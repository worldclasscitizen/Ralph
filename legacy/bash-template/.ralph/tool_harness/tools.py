from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable


class ToolPolicyError(RuntimeError):
    pass


class ToolExecutionError(RuntimeError):
    pass


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


class WorkspaceTools:
    def __init__(
        self,
        root: Path,
        policy: dict[str, Any],
        run_dir: Path,
        event_callback: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> None:
        self.root = root.resolve()
        self.policy = policy
        self.run_dir = run_dir
        self.event_callback = event_callback
        self.originals: dict[str, tuple[bytes | None, int | None]] = {}
        self.last_written_sha: dict[str, str | None] = {}
        self.backup_dir = run_dir / "harness-backups" / str(os.getpid())

    @property
    def definitions(self) -> list[dict[str, Any]]:
        object_schema = {"type": "object", "additionalProperties": False}
        return [
            self._tool("list_files", "List non-ignored workspace files. Paths are relative to the project root.", {
                **object_schema,
                "properties": {
                    "glob": {"type": "string", "description": "Optional glob such as src/**/*.ts"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 1000},
                },
            }),
            self._tool("search_text", "Search a literal text string in non-ignored UTF-8 workspace files.", {
                **object_schema,
                "properties": {
                    "query": {"type": "string", "minLength": 1, "maxLength": 300},
                    "glob": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 500},
                },
                "required": ["query"],
            }),
            self._tool("read_file", "Read a UTF-8 file and receive its current SHA-256 for safe edits.", {
                **object_schema,
                "properties": {
                    "path": {"type": "string", "minLength": 1},
                    "start_line": {"type": "integer", "minimum": 1},
                    "end_line": {"type": "integer", "minimum": 1},
                },
                "required": ["path"],
            }),
            self._tool("edit_file", "Atomically replace exact text in an existing file after verifying its SHA-256.", {
                **object_schema,
                "properties": {
                    "path": {"type": "string", "minLength": 1},
                    "expected_sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                    "edits": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "old_text": {"type": "string", "minLength": 1},
                                "new_text": {"type": "string"},
                                "expected_occurrences": {"type": "integer", "minimum": 1},
                            },
                            "required": ["old_text", "new_text", "expected_occurrences"],
                        },
                    },
                },
                "required": ["path", "expected_sha256", "edits"],
            }),
            self._tool("write_file", "Create a new file or atomically replace an existing file using its expected SHA-256.", {
                **object_schema,
                "properties": {
                    "path": {"type": "string", "minLength": 1},
                    "content": {"type": "string"},
                    "expected_sha256": {"type": ["string", "null"], "pattern": "^[a-f0-9]{64}$"},
                },
                "required": ["path", "content", "expected_sha256"],
            }),
            self._tool("delete_file", "Delete a file after SHA verification; the original is kept in the Ralph run backup.", {
                **object_schema,
                "properties": {
                    "path": {"type": "string", "minLength": 1},
                    "expected_sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                },
                "required": ["path", "expected_sha256"],
            }),
            self._tool("git_status", "Show concise local Git status without changing repository state.", object_schema),
            self._tool("git_diff", "Show the current unstaged Git diff, optionally for one path.", {
                **object_schema,
                "properties": {"path": {"type": "string"}},
            }),
            self._tool("run_verifier", "Run the deterministic project verifier registered by the team.", object_schema),
        ]

    @staticmethod
    def _tool(name: str, description: str, parameters: dict[str, Any]) -> dict[str, Any]:
        return {"type": "function", "function": {"name": name, "description": description, "parameters": parameters}}

    def _emit(self, event: str, data: dict[str, Any]) -> None:
        if self.event_callback:
            self.event_callback(event, data)

    def _relative(self, path_value: str) -> str:
        path_value = path_value.replace("\\", "/")
        candidate_input = Path(path_value)
        if candidate_input.is_absolute():
            raise ToolPolicyError("절대 경로는 허용되지 않습니다.")
        if any(part in {"", ".", ".."} for part in candidate_input.parts):
            raise ToolPolicyError("빈 경로, 현재 경로 또는 상위 경로 참조는 허용되지 않습니다.")
        relative = candidate_input.as_posix()
        if self._is_protected(relative):
            raise ToolPolicyError(f"보호된 경로입니다: {relative}")
        return relative

    def _path(self, path_value: str, *, for_write: bool = False) -> tuple[str, Path]:
        relative = self._relative(path_value)
        current = self.root
        for part in Path(relative).parts[:-1]:
            current = current / part
            if current.is_symlink():
                raise ToolPolicyError(f"symlink 디렉터리는 허용되지 않습니다: {relative}")
        candidate = self.root / relative
        if candidate.is_symlink():
            raise ToolPolicyError(f"symlink 파일은 허용되지 않습니다: {relative}")
        try:
            candidate.resolve(strict=False).relative_to(self.root)
        except ValueError as exc:
            raise ToolPolicyError(f"프로젝트 밖 경로는 허용되지 않습니다: {relative}") from exc
        if for_write and self._is_git_ignored(relative):
            raise ToolPolicyError(f"Git에서 무시된 경로는 수정할 수 없습니다: {relative}")
        return relative, candidate

    def _is_protected(self, relative: str) -> bool:
        name = Path(relative).name
        if name.startswith(".env.") and name != ".env.example":
            return True
        return any(fnmatch.fnmatchcase(relative, pattern) for pattern in self.policy["protectedPaths"])

    def _is_git_ignored(self, relative: str) -> bool:
        completed = subprocess.run(
            ["git", "check-ignore", "-q", "--", relative],
            cwd=self.root,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return completed.returncode == 0

    def workspace_files(self) -> list[str]:
        completed = subprocess.run(
            ["git", "ls-files", "-co", "--exclude-standard", "-z"],
            cwd=self.root,
            check=True,
            capture_output=True,
        )
        files: list[str] = []
        for raw in completed.stdout.split(b"\0"):
            if not raw:
                continue
            relative = raw.decode("utf-8", errors="surrogateescape")
            if self._is_protected(relative):
                continue
            path = self.root / relative
            if path.is_file() and not path.is_symlink():
                files.append(relative)
        return sorted(set(files))

    def execute(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        handlers = {
            "list_files": self.list_files,
            "search_text": self.search_text,
            "read_file": self.read_file,
            "edit_file": self.edit_file,
            "write_file": self.write_file,
            "delete_file": self.delete_file,
            "git_status": self.git_status,
            "git_diff": self.git_diff,
            "run_verifier": self.run_verifier,
        }
        handler = handlers.get(name)
        if handler is None:
            raise ToolPolicyError(f"등록되지 않은 도구입니다: {name}")
        if not isinstance(arguments, dict):
            raise ToolExecutionError("도구 인자는 JSON 객체여야 합니다.")
        result = handler(**arguments)
        encoded = json.dumps(result, ensure_ascii=False)
        limit = int(self.policy["maxToolOutputBytes"])
        if len(encoded.encode("utf-8")) > limit:
            encoded = encoded.encode("utf-8")[:limit].decode("utf-8", errors="ignore")
            result = {"truncated": True, "content": encoded}
        self._emit("tool_result", {"tool": name, "ok": True})
        return result

    def list_files(self, glob: str = "*", limit: int = 500) -> dict[str, Any]:
        if limit < 1 or limit > 1000:
            raise ToolExecutionError("limit은 1..1000이어야 합니다.")
        matches = [path for path in self.workspace_files() if fnmatch.fnmatchcase(path, glob) or glob == "*"]
        return {"files": matches[:limit], "truncated": len(matches) > limit}

    def search_text(self, query: str, glob: str = "*", limit: int = 200) -> dict[str, Any]:
        if not query or len(query) > 300:
            raise ToolExecutionError("query 길이는 1..300이어야 합니다.")
        if limit < 1 or limit > 500:
            raise ToolExecutionError("limit은 1..500이어야 합니다.")
        matches: list[dict[str, Any]] = []
        for relative in self.workspace_files():
            if glob != "*" and not fnmatch.fnmatchcase(relative, glob):
                continue
            path = self.root / relative
            if path.stat().st_size > int(self.policy["maxReadBytes"]):
                continue
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except (UnicodeDecodeError, OSError):
                continue
            for line_number, line in enumerate(lines, 1):
                if query in line:
                    matches.append({"path": relative, "line": line_number, "text": line[:500]})
                    if len(matches) >= limit:
                        return {"matches": matches, "truncated": True}
        return {"matches": matches, "truncated": False}

    def read_file(self, path: str, start_line: int = 1, end_line: int | None = None) -> dict[str, Any]:
        relative, absolute = self._path(path)
        if not absolute.is_file():
            raise ToolExecutionError(f"파일이 없습니다: {relative}")
        content = absolute.read_bytes()
        if len(content) > int(self.policy["maxReadBytes"]):
            raise ToolPolicyError(f"읽기 크기 제한을 넘었습니다: {relative}")
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ToolExecutionError(f"UTF-8 텍스트 파일이 아닙니다: {relative}") from exc
        lines = text.splitlines(keepends=True)
        if start_line < 1:
            raise ToolExecutionError("start_line은 1 이상이어야 합니다.")
        selected_end = end_line if end_line is not None else min(len(lines), start_line + 399)
        if selected_end < start_line:
            raise ToolExecutionError("end_line은 start_line 이상이어야 합니다.")
        return {
            "path": relative,
            "sha256": sha256_bytes(content),
            "start_line": start_line,
            "end_line": min(selected_end, len(lines)),
            "total_lines": len(lines),
            "content": "".join(lines[start_line - 1:selected_end]),
        }

    def _record_original(self, relative: str, absolute: Path) -> None:
        if relative in self.originals:
            return
        if absolute.exists():
            content = absolute.read_bytes()
            mode = absolute.stat().st_mode & 0o777
            self.originals[relative] = (content, mode)
            backup = self.backup_dir / relative
            backup.parent.mkdir(parents=True, exist_ok=True)
            backup.write_bytes(content)
        else:
            self.originals[relative] = (None, None)

    def _atomic_write(self, absolute: Path, content: bytes, mode: int | None) -> None:
        if len(content) > int(self.policy["maxWriteBytes"]):
            raise ToolPolicyError("쓰기 크기 제한을 넘었습니다.")
        absolute.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=f".{absolute.name}.", dir=absolute.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            if mode is not None:
                os.chmod(temp_name, mode)
            os.replace(temp_name, absolute)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    @staticmethod
    def _require_sha(content: bytes, expected_sha256: str, relative: str) -> None:
        actual = sha256_bytes(content)
        if actual != expected_sha256:
            raise ToolExecutionError(f"파일이 읽은 뒤 변경되었습니다: {relative}; actual_sha256={actual}")

    def edit_file(self, path: str, expected_sha256: str, edits: list[dict[str, Any]]) -> dict[str, Any]:
        relative, absolute = self._path(path, for_write=True)
        if not absolute.is_file():
            raise ToolExecutionError(f"파일이 없습니다: {relative}")
        original = absolute.read_bytes()
        self._require_sha(original, expected_sha256, relative)
        try:
            text = original.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ToolExecutionError(f"UTF-8 텍스트 파일이 아닙니다: {relative}") from exc
        for edit in edits:
            if not isinstance(edit, dict):
                raise ToolExecutionError("edits 항목은 객체여야 합니다.")
            old_text = edit.get("old_text")
            new_text = edit.get("new_text")
            expected = edit.get("expected_occurrences")
            if not isinstance(old_text, str) or not old_text or not isinstance(new_text, str) or not isinstance(expected, int):
                raise ToolExecutionError("edit 항목의 old_text/new_text/expected_occurrences가 올바르지 않습니다.")
            actual_count = text.count(old_text)
            if actual_count != expected:
                raise ToolExecutionError(
                    f"치환 대상 개수가 다릅니다: expected={expected}, actual={actual_count}, path={relative}"
                )
            text = text.replace(old_text, new_text)
        content = text.encode("utf-8")
        self._record_original(relative, absolute)
        self._atomic_write(absolute, content, absolute.stat().st_mode & 0o777)
        digest = sha256_bytes(content)
        self.last_written_sha[relative] = digest
        return {"path": relative, "sha256": digest, "bytes": len(content)}

    def write_file(self, path: str, content: str, expected_sha256: str | None) -> dict[str, Any]:
        if not isinstance(content, str):
            raise ToolExecutionError("content는 문자열이어야 합니다.")
        relative, absolute = self._path(path, for_write=True)
        existing = absolute.read_bytes() if absolute.exists() else None
        if existing is None and expected_sha256 is not None:
            raise ToolExecutionError(f"신규 파일에는 expected_sha256=null을 사용하세요: {relative}")
        if existing is not None:
            if expected_sha256 is None:
                raise ToolExecutionError(f"기존 파일 덮어쓰기에는 expected_sha256이 필요합니다: {relative}")
            self._require_sha(existing, expected_sha256, relative)
        encoded = content.encode("utf-8")
        self._record_original(relative, absolute)
        mode = absolute.stat().st_mode & 0o777 if absolute.exists() else 0o644
        self._atomic_write(absolute, encoded, mode)
        digest = sha256_bytes(encoded)
        self.last_written_sha[relative] = digest
        return {"path": relative, "sha256": digest, "bytes": len(encoded)}

    def delete_file(self, path: str, expected_sha256: str) -> dict[str, Any]:
        relative, absolute = self._path(path, for_write=True)
        if not absolute.is_file():
            raise ToolExecutionError(f"파일이 없습니다: {relative}")
        content = absolute.read_bytes()
        self._require_sha(content, expected_sha256, relative)
        self._record_original(relative, absolute)
        absolute.unlink()
        self.last_written_sha[relative] = None
        return {"path": relative, "deleted": True, "backup": str((self.backup_dir / relative).relative_to(self.run_dir))}

    def git_status(self) -> dict[str, Any]:
        completed = subprocess.run(
            ["git", "status", "--short"], cwd=self.root, check=False, text=True, capture_output=True
        )
        return {"exit_code": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}

    def git_diff(self, path: str | None = None) -> dict[str, Any]:
        argv = ["git", "diff", "--"]
        if path:
            relative, _ = self._path(path)
            argv.append(relative)
        completed = subprocess.run(argv, cwd=self.root, check=False, text=True, capture_output=True)
        return {"exit_code": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}

    def run_verifier(self) -> dict[str, Any]:
        verifier = self.policy["verifier"]
        argv = list(verifier["argv"])
        executable = self.root / argv[0]
        if not executable.is_file():
            raise ToolExecutionError(f"등록된 verifier가 없습니다: {argv[0]}")
        env = {
            key: value
            for key, value in os.environ.items()
            if not any(marker in key.upper() for marker in ("KEY", "TOKEN", "SECRET", "PASSWORD"))
        }
        try:
            completed = subprocess.run(
                argv,
                cwd=self.root,
                check=False,
                text=True,
                capture_output=True,
                timeout=int(self.policy["verifierTimeoutSeconds"]),
                env=env,
            )
        except subprocess.TimeoutExpired as exc:
            raise ToolExecutionError("project verifier timeout") from exc
        return {"id": verifier["id"], "exit_code": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}

    def rollback(self) -> None:
        for relative, (original, mode) in reversed(list(self.originals.items())):
            absolute = self.root / relative
            expected_current = self.last_written_sha.get(relative)
            if expected_current is None:
                if absolute.exists():
                    continue
            else:
                if not absolute.is_file() or sha256_bytes(absolute.read_bytes()) != expected_current:
                    continue
            if original is None:
                if absolute.exists():
                    absolute.unlink()
            else:
                self._atomic_write(absolute, original, mode)
        self._emit("rollback", {"paths": sorted(self.originals)})

    def change_summary(self) -> list[dict[str, Any]]:
        changes: list[dict[str, Any]] = []
        for relative, (original, _) in self.originals.items():
            absolute = self.root / relative
            if original is None:
                action = "created" if absolute.exists() else "unchanged"
            elif not absolute.exists():
                action = "deleted"
            elif absolute.read_bytes() != original:
                action = "modified"
            else:
                action = "unchanged"
            if action != "unchanged":
                changes.append({"path": relative, "action": action})
        return changes
