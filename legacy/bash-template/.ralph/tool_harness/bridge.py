from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from .config import HarnessConfigError, ModelRuntime
from .providers import ApiError
from .tools import ToolExecutionError, ToolPolicyError, WorkspaceTools, sha256_bytes


def _scan_mirror(root: Path, tools: WorkspaceTools) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ToolPolicyError(f"GLM 임시 작업공간에 symlink가 생성되었습니다: {path.relative_to(root)}")
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        if tools._is_protected(relative):  # 같은 공용 정책으로 임시 산출물도 걸러낸다.
            continue
        content = path.read_bytes()
        if len(content) > int(tools.policy["maxWriteBytes"]):
            raise ToolPolicyError(f"GLM 변경 파일이 쓰기 제한을 넘었습니다: {relative}")
        files[relative] = content
    return files


def run_glm_coding_plan_bridge(
    *,
    project_root: Path,
    runtime: ModelRuntime,
    prompt: str,
    mode: str,
    dotenv: dict[str, str],
    run_dir: Path,
    event_callback,
) -> str:
    api_key_env = str(runtime.connection.get("apiKeyEnv") or "GLM_API_KEY")
    api_key = os.environ.get(api_key_env) or dotenv.get(api_key_env, "")
    if not api_key:
        raise HarnessConfigError(f"GLM Coding Plan 키가 설정되지 않았습니다: {api_key_env}")

    claude_bin = os.environ.get("RALPH_CLAUDE_BIN") or shutil.which("claude")
    if not claude_bin:
        raise ApiError("authentication", "GLM Coding Plan용 Claude Code CLI를 찾을 수 없습니다.")

    workspace_tools = WorkspaceTools(project_root, runtime.policy, run_dir, event_callback)
    source_files = workspace_tools.workspace_files()
    source_manifest: dict[str, str] = {}

    with tempfile.TemporaryDirectory(prefix="ralph-glm-workspace.") as temp_name:
        mirror_root = Path(temp_name)
        for relative in source_files:
            source = project_root / relative
            destination = mirror_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            source_manifest[relative] = sha256_bytes(source.read_bytes())

        env = os.environ.copy()
        for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
            env.pop(key, None)
        env.update(
            {
                "ANTHROPIC_AUTH_TOKEN": api_key,
                "ANTHROPIC_BASE_URL": os.environ.get(
                    "GLM_ANTHROPIC_BASE_URL",
                    dotenv.get("GLM_ANTHROPIC_BASE_URL", "https://api.z.ai/api/anthropic"),
                ),
                "ANTHROPIC_DEFAULT_OPUS_MODEL": runtime.model_id,
                "ANTHROPIC_DEFAULT_SONNET_MODEL": runtime.model_id,
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": runtime.model_id,
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            }
        )

        permission = "plan" if mode == "smoke" else "acceptEdits"
        tools_value = "" if mode == "smoke" else "Read,Glob,Grep,Edit,Write"
        argv = [
            claude_bin,
            "--print",
            "--model",
            "opus",
            "--effort",
            runtime.reasoning_effort,
            "--permission-mode",
            permission,
            "--tools",
            tools_value,
            "--output-format",
            "json",
            "--no-session-persistence",
            "--no-chrome",
            "--disable-slash-commands",
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
        ]
        event_callback("glm_bridge_start", {"model": runtime.model_id, "mode": mode})
        try:
            completed = subprocess.run(
                argv,
                cwd=mirror_root,
                input=prompt,
                text=True,
                capture_output=True,
                timeout=int(runtime.policy["requestTimeoutSeconds"]),
                env=env,
            )
        except subprocess.TimeoutExpired as exc:
            raise ApiError("timeout", "GLM Coding Plan Claude Code timeout") from exc

        if completed.returncode != 0:
            stderr = completed.stderr[:1000]
            lowered = stderr.lower()
            if "429" in lowered or "rate limit" in lowered or "quota" in lowered:
                error_class = "rate_limit"
            elif "401" in lowered or "403" in lowered or "auth" in lowered or "credential" in lowered:
                error_class = "authentication"
            elif any(code in lowered for code in ("500", "502", "503", "504", "overloaded")):
                error_class = "server_error"
            else:
                error_class = "invalid_request"
            raise ApiError(error_class, f"GLM Coding Plan Claude Code 실패: {stderr}")

        if mode != "smoke":
            mirror_files = _scan_mirror(mirror_root, workspace_tools)
            all_paths = sorted(set(source_manifest) | set(mirror_files))
            try:
                for relative in all_paths:
                    before_sha = source_manifest.get(relative)
                    after = mirror_files.get(relative)
                    if after is None:
                        if before_sha is not None:
                            workspace_tools.delete_file(relative, before_sha)
                        continue
                    after_sha = sha256_bytes(after)
                    if before_sha == after_sha:
                        continue
                    try:
                        text = after.decode("utf-8")
                    except UnicodeDecodeError as exc:
                        raise ToolExecutionError(f"GLM이 UTF-8이 아닌 파일을 생성했습니다: {relative}") from exc
                    workspace_tools.write_file(relative, text, before_sha)
            except Exception:
                workspace_tools.rollback()
                raise
            event_callback("glm_bridge_commit", {"changes": workspace_tools.change_summary()})

        try:
            result = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise ApiError("invalid_request", "GLM Coding Plan Claude Code JSON 결과를 해석하지 못했습니다.") from exc
        if not isinstance(result, dict):
            raise ApiError("invalid_request", "GLM Coding Plan Claude Code 결과가 객체가 아닙니다.")
        event_callback("model_response", {"usage": result.get("usage", {}), "model": runtime.model_id})
        output = str(result.get("result") or result.get("response") or "").strip()
        if not output:
            raise ApiError("invalid_request", "GLM Coding Plan Worker가 최종 응답을 반환하지 않았습니다.")
        return output
