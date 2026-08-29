#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from collections import defaultdict
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse


DASHBOARD_DIR = Path(__file__).resolve().parent
RALPH_DIR = DASHBOARD_DIR.parent
DEFAULT_PROJECT_ROOT = RALPH_DIR.parent
STATIC_DIR = DASHBOARD_DIR / "static"
MAX_ARTIFACT_BYTES = 256 * 1024
MAX_EVENT_LINES = 600
MAX_OPERATOR_NOTE_BYTES = 4 * 1024

STAGES = (
    ("pre_critic", "Pre-Critic", "작업을 시작하기 전에 현재 계약과 기존 증거를 평가합니다."),
    ("meta_prompter", "Meta-Prompter", "평가에서 발견한 문제를 다음 작업 지시에 반영합니다."),
    ("worker", "Worker", "코드·테스트·문서를 실제로 구현합니다."),
    ("verifier", "Verifier", "테스트·린트·타입 검사·빌드 결과를 확인합니다."),
    ("post_critic", "Post-Critic", "구현 결과를 다시 평가하고 통과 여부를 판정합니다."),
    ("checkpoint", "Git checkpoint", "현재 변경을 되돌릴 수 있는 로컬 Git 복구 지점으로 저장합니다."),
)

STAGE_BY_ID = {stage_id: (label, description) for stage_id, label, description in STAGES}

STAGE_EXECUTOR_LABELS = {
    "verifier": "테스트·빌드 자동 검사",
    "checkpoint": "Git 안전 스크립트",
}

EFFORT_LABELS = {
    "none": "No Reasoning",
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Extra High",
    "max": "Maximum",
    "ultra": "Ultra",
}

ERROR_CLASS_LABELS = {
    "none": "장애 없음",
    "rate_limit": "호출 한도 초과",
    "timeout": "응답 시간 초과",
    "server_error": "공급자 서버 오류",
    "empty_response": "빈 응답",
    "authentication": "인증 오류",
    "invalid_request": "잘못된 요청",
    "policy_denial": "안전 정책 차단",
    "unknown": "분류되지 않은 오류",
}

SECRET_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"\bAIza[A-Za-z0-9_-]{16,}"),
    re.compile(r"(?i)(api[_-]?key|auth[_-]?token|client[_-]?secret)(\s*[:=]\s*)([^\s\"']+)"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def redact(text: str) -> str:
    result = text
    for pattern in SECRET_PATTERNS:
        if pattern.groups >= 3:
            result = pattern.sub(lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", result)
        else:
            result = pattern.sub("[REDACTED]", result)
    return result


def read_text(path: Path, limit: int = MAX_ARTIFACT_BYTES, tail: bool = False) -> str:
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:
            if tail and size > limit:
                handle.seek(-limit, os.SEEK_END)
            data = handle.read(limit if not tail else limit)
        text = data.decode("utf-8", errors="replace")
        if tail and size > limit:
            text = "… 앞부분 생략 …\n" + text
        elif not tail and size > limit:
            text += "\n… 뒷부분 생략 …"
        return redact(text)
    except (OSError, ValueError):
        return ""


def read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def read_jsonl(path: Path, limit: int = MAX_EVENT_LINES) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(payload, dict):
                    rows.append(payload)
                    if len(rows) > limit:
                        rows.pop(0)
    except OSError:
        return []
    return rows


def normalize_stage(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")
    aliases = {
        "pre_critic": "pre_critic",
        "critic_pre": "pre_critic",
        "meta_prompter": "meta_prompter",
        "meta": "meta_prompter",
        "worker": "worker",
        "deterministic_verifier": "verifier",
        "smoke_verifier": "verifier",
        "verifier": "verifier",
        "post_critic": "post_critic",
        "critic_post": "post_critic",
        "checkpoint": "checkpoint",
        "git_checkpoint": "checkpoint",
    }
    return aliases.get(normalized, normalized)


def humanize_model_id(model_id: str) -> str:
    value = model_id.strip()
    patterns = (
        (r"^gpt-([0-9.]+)-(.+)$", lambda match: f"GPT {match.group(1)} {match.group(2).title()}"),
        (r"^gemini-([0-9.]+)-(.+)$", lambda match: f"Gemini {match.group(1)} {match.group(2).title()}"),
        (r"^claude-(.+)-([0-9.]+)$", lambda match: f"Claude {match.group(1).title()} {match.group(2)}"),
        (r"^deepseek-v([0-9.]+)-(.+)$", lambda match: f"DeepSeek V{match.group(1)} {match.group(2).title()}"),
        (r"^glm-([0-9.]+)(?:-(.+))?$", lambda match: f"GLM {match.group(1)}{f' {match.group(2).title()}' if match.group(2) else ''}"),
    )
    for pattern, formatter in patterns:
        match = re.match(pattern, value, re.IGNORECASE)
        if match:
            return formatter(match)
    return value or "모델 정보 없음"


def humanize_fallback_event(event: dict[str, Any]) -> str:
    summary = str(event.get("summary") or event.get("type") or "이벤트")
    if event.get("type") != "fallback":
        return summary
    status = str(event.get("status") or "")
    match = re.match(r"^([^:]+):\s*([^ ]+)\s*\(exit\s+(-?[0-9]+)\)$", summary)
    action = match.group(1) if match else status
    error_class = match.group(2) if match else "unknown"
    exit_code = match.group(3) if match else "?"
    error_label = ERROR_CLASS_LABELS.get(error_class, error_class)
    if action == "success":
        return f"모델 호출이 정상 종료되었습니다. 장애 분류: {error_label}, 종료 코드 {exit_code}."
    if action == "retry_same_model":
        return f"{error_label} 때문에 같은 모델을 다시 시도합니다. 종료 코드 {exit_code}."
    if action == "fallback_next_model":
        return f"{error_label} 때문에 폴백 체인의 다음 모델로 전환합니다. 종료 코드 {exit_code}."
    if action == "stop_non_retryable":
        return f"{error_label}는 자동 우회하지 않는 오류라 이 실행을 중단했습니다. 종료 코드 {exit_code}."
    if action == "skip_degraded":
        return "이 실행에서 이미 장애가 반복된 모델이라 건너뛰었습니다."
    if action == "skip_unavailable":
        return "이 역할에 연결된 실행 명령이 없어 모델을 건너뛰었습니다."
    if action == "skip_conflict":
        return "Worker 또는 1차 Critic과 독립된 평가 모델을 사용하기 위해 이 모델을 건너뛰었습니다."
    return f"모델 라우팅 결과: {action}, 원인: {error_label}, 종료 코드 {exit_code}."


def decorate_event(event: dict[str, Any]) -> dict[str, Any]:
    decorated = dict(event)
    decorated["rawSummary"] = event.get("summary") or ""
    decorated["summary"] = humanize_fallback_event(event)
    return decorated


def safe_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value >= 0:
        return int(value)
    if isinstance(value, str):
        try:
            parsed = int(value.replace(",", "").strip())
            return parsed if parsed >= 0 else None
        except ValueError:
            return None
    return None


def parse_prompt_tasks(text: str, run_passed: bool = False) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    heading = "작업 계약"
    capture_numbered = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line.startswith("## "):
            heading = line[3:].strip()
            capture_numbered = any(token in heading for token in ("구현 요구사항", "완료 조건", "작업", "요구사항"))
            continue
        checkbox = re.match(r"^[-*]\s+\[([ xX])\]\s+(.+)$", line)
        if checkbox:
            complete = checkbox.group(1).lower() == "x" or run_passed
            tasks.append(
                {
                    "id": f"task-{len(tasks) + 1}",
                    "text": checkbox.group(2).strip(),
                    "section": heading,
                    "status": "completed" if complete else "pending",
                    "source": "checkbox",
                }
            )
            continue
        numbered = re.match(r"^(\d+)\.\s+(.+)$", line)
        if capture_numbered and numbered and len(tasks) < 60:
            tasks.append(
                {
                    "id": f"task-{len(tasks) + 1}",
                    "text": numbered.group(2).strip(),
                    "section": heading,
                    "status": "completed" if run_passed else "pending",
                    "source": "numbered",
                }
            )
    if not tasks:
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if line.startswith("## ") and line[3:].strip() not in {"목표", "사용자 가치와 문제 정의"}:
                tasks.append(
                    {
                        "id": f"task-{len(tasks) + 1}",
                        "text": line[3:].strip(),
                        "section": "PROMPT.md",
                        "status": "completed" if run_passed else "pending",
                        "source": "heading",
                    }
                )
    return tasks[:60]


class RalphRepository:
    def __init__(self, project_root: Path):
        self.project_root = project_root.resolve()
        self.ralph_dir = self.project_root / ".ralph"
        self.antigravity_dir = self.project_root / ".antigravity"
        self.runs_dir = self.ralph_dir / "runs"
        self.prompt_file = self.ralph_dir / "PROMPT.md"
        self.state_file = self.ralph_dir / "state.json"
        self.operator_note_file = self.ralph_dir / "OPERATOR_NOTE.local.md"
        self.lock_dir = self.ralph_dir / ".lock"
        self._cache_lock = threading.Lock()
        self._cache_at = 0.0
        self._cache_key = ""
        self._cache_value: dict[str, Any] | None = None

    def _model_catalog(self, metadata: dict[str, Any]) -> dict[str, dict[str, Any]]:
        public_models = read_json(self.antigravity_dir / "config.json").get("models", {})
        local_models = read_json(self.antigravity_dir / "config.local.json").get("models", {})
        catalog: dict[str, dict[str, Any]] = {}
        if isinstance(local_models, dict) and isinstance(public_models, dict):
            for alias, selection in local_models.items():
                if not isinstance(selection, dict):
                    continue
                catalog_alias = str(selection.get("catalogModel") or alias)
                public = public_models.get(catalog_alias, {})
                if not isinstance(public, dict):
                    public = {}
                catalog[str(alias)] = {
                    "alias": str(alias),
                    "provider": str(public.get("provider") or ""),
                    "modelId": str(public.get("modelId") or catalog_alias),
                    "reasoningEffort": str(selection.get("reasoningEffort") or ""),
                }
        route = metadata.get("route", {})
        route_models = route.get("models", []) if isinstance(route, dict) else []
        if isinstance(route_models, list):
            for item in route_models:
                if not isinstance(item, dict) or not item.get("alias"):
                    continue
                reasoning = item.get("reasoning", {})
                catalog[str(item["alias"])] = {
                    "alias": str(item["alias"]),
                    "provider": str(item.get("provider") or ""),
                    "modelId": str(item.get("modelId") or item["alias"]),
                    "reasoningEffort": str(reasoning.get("value") or "") if isinstance(reasoning, dict) else "",
                }
        for alias, info in catalog.items():
            effort = str(info.get("reasoningEffort") or "")
            display_name = humanize_model_id(str(info.get("modelId") or alias))
            info["displayName"] = display_name
            info["effortLabel"] = EFFORT_LABELS.get(effort, effort.title()) if effort else ""
            info["displayLabel"] = f"{display_name} · {info['effortLabel']}" if info["effortLabel"] else display_name
        return catalog

    @staticmethod
    def _model_info(alias: str, catalog: dict[str, dict[str, Any]]) -> dict[str, Any]:
        if not alias:
            return {
                "alias": "",
                "provider": "local",
                "modelId": "",
                "reasoningEffort": "",
                "effortLabel": "",
                "displayName": "",
                "displayLabel": "",
            }
        if alias in catalog:
            return dict(catalog[alias])
        display_name = humanize_model_id(alias)
        return {
            "alias": alias,
            "provider": "",
            "modelId": alias,
            "reasoningEffort": "",
            "effortLabel": "",
            "displayName": display_name,
            "displayLabel": display_name,
        }

    def _state_for_run(self, run_dir: Path) -> dict[str, Any]:
        state = read_json(self.state_file)
        if str(state.get("runId") or "") == run_dir.name:
            return state
        state_dir = state.get("runDirectory")
        if isinstance(state_dir, str):
            try:
                if Path(state_dir).resolve() == run_dir.resolve():
                    return state
            except OSError:
                pass
        return {}

    def list_runs(self) -> list[dict[str, Any]]:
        if not self.runs_dir.is_dir():
            return []
        runs: list[dict[str, Any]] = []
        for run_dir in sorted((path for path in self.runs_dir.iterdir() if path.is_dir()), reverse=True):
            metadata = read_json(run_dir / "run.json")
            events = read_jsonl(run_dir / "events.jsonl", limit=50)
            final_event = next((event for event in reversed(events) if event.get("type") == "run_completed"), None)
            state = self._state_for_run(run_dir)
            run_id = str(metadata.get("runId") or run_dir.name)
            status = str((final_event or {}).get("status") or state.get("status") or "unknown")
            score = (final_event or {}).get("score")
            if status == "unknown" and self.lock_dir.exists() and run_dir == self.latest_run_dir():
                status = "running"
            elif status == "unknown" and events:
                status = "interrupted"
            runs.append(
                {
                    "runId": run_id,
                    "task": metadata.get("task") or (events[-1].get("task") if events else "unknown"),
                    "taskLabel": (metadata.get("route") or {}).get("taskLabel") if isinstance(metadata.get("route"), dict) else "",
                    "startedAt": metadata.get("startedAt") or datetime.fromtimestamp(run_dir.stat().st_mtime, timezone.utc).isoformat(),
                    "lastActivityAt": events[-1].get("timestamp") if events else None,
                    "endedAt": None if status == "running" else (events[-1].get("timestamp") if events else None),
                    "status": status,
                    "score": score,
                    "directory": str(run_dir),
                    "instrumented": bool(events),
                }
            )
        return runs[:30]

    def latest_run_dir(self) -> Path | None:
        if not self.runs_dir.is_dir():
            return None
        candidates = [path for path in self.runs_dir.iterdir() if path.is_dir()]
        return max(candidates, key=lambda path: path.stat().st_mtime) if candidates else None

    def resolve_run_dir(self, run_id: str | None) -> Path | None:
        if run_id:
            candidate = (self.runs_dir / run_id).resolve()
            try:
                candidate.relative_to(self.runs_dir.resolve())
            except ValueError:
                return None
            return candidate if candidate.is_dir() else None
        state = read_json(self.state_file)
        state_dir = state.get("runDirectory")
        if isinstance(state_dir, str):
            candidate = Path(state_dir).resolve()
            try:
                candidate.relative_to(self.runs_dir.resolve())
            except ValueError:
                pass
            else:
                if candidate.is_dir() and (self.lock_dir.exists() or candidate == self.latest_run_dir()):
                    return candidate
        return self.latest_run_dir()

    def safe_artifact(self, run_id: str, artifact: str) -> Path | None:
        run_dir = self.resolve_run_dir(run_id)
        if run_dir is None or not artifact:
            return None
        candidate = (run_dir / unquote(artifact)).resolve()
        try:
            candidate.relative_to(run_dir.resolve())
        except ValueError:
            return None
        if not candidate.is_file() or candidate.name.startswith("."):
            return None
        allowed = {".json", ".jsonl", ".log", ".md", ".raw", ".stderr", ".txt"}
        if candidate.suffix not in allowed and ".attempt-" not in candidate.name:
            return None
        return candidate

    def artifact_payload(self, run_id: str, artifact: str) -> dict[str, Any] | None:
        path = self.safe_artifact(run_id, artifact)
        if path is None:
            return None
        return {
            "runId": run_id,
            "artifact": path.name,
            "size": path.stat().st_size,
            "content": read_text(path, tail=True),
            "updatedAt": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
        }

    def write_operator_note(self, note: str) -> dict[str, Any]:
        encoded = note.encode("utf-8")
        if not note.strip():
            raise ValueError("오퍼레이터 메모가 비어 있습니다.")
        if len(encoded) > MAX_OPERATOR_NOTE_BYTES:
            raise ValueError("오퍼레이터 메모는 4KB 이하여야 합니다.")
        body = f"# Operator note\n\n{note.strip()}\n"
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        temporary = self.runs_dir / f".operator-note-{os.getpid()}-{threading.get_ident()}.tmp"
        temporary.write_text(body, encoding="utf-8")
        temporary.replace(self.operator_note_file)
        return {"ok": True, "updatedAt": utc_now(), "path": str(self.operator_note_file)}

    def delete_runs(self, run_ids: list[str]) -> dict[str, Any]:
        unique_ids = list(dict.fromkeys(run_id.strip() for run_id in run_ids if run_id.strip()))
        if not unique_ids:
            raise ValueError("삭제할 LOOP HISTORY를 하나 이상 선택해 주세요.")
        if len(unique_ids) > 500:
            raise ValueError("한 번에 삭제할 수 있는 LOOP HISTORY는 최대 500개입니다.")

        run_dirs: list[Path] = []
        active_run_dir = self.latest_run_dir() if self.lock_dir.exists() else None
        for run_id in unique_ids:
            run_dir = self.resolve_run_dir(run_id)
            if run_dir is None or run_dir.name != run_id:
                raise FileNotFoundError(f"삭제할 실행 기록을 찾을 수 없습니다: {run_id}")
            if run_dir.is_symlink():
                raise ValueError("심볼릭 링크 실행 디렉터리는 대시보드에서 삭제할 수 없습니다.")
            if active_run_dir is not None and run_dir == active_run_dir:
                raise RuntimeError("현재 실행 중인 LOOP HISTORY는 삭제할 수 없습니다. Ralph를 먼저 중단하거나 종료해 주세요.")
            run_dirs.append(run_dir)

        clear_state = any(self._state_for_run(run_dir) for run_dir in run_dirs)
        file_count = sum(1 for run_dir in run_dirs for path in run_dir.rglob("*") if path.is_file())
        total_bytes = sum(path.stat().st_size for run_dir in run_dirs for path in run_dir.rglob("*") if path.is_file())
        for run_dir in run_dirs:
            shutil.rmtree(run_dir)
        if clear_state:
            try:
                self.state_file.unlink(missing_ok=True)
            except OSError:
                pass
        with self._cache_lock:
            self._cache_at = 0.0
            self._cache_key = ""
            self._cache_value = None
        return {
            "ok": True,
            "runIds": unique_ids,
            "deletedRuns": len(unique_ids),
            "deletedFiles": file_count,
            "deletedBytes": total_bytes,
            "message": f"로컬 상세 실행 증거 {len(unique_ids)}개를 삭제했습니다. 코드와 Git 커밋은 변경하지 않았습니다.",
        }

    def delete_run(self, run_id: str) -> dict[str, Any]:
        result = self.delete_runs([run_id])
        return {**result, "runId": run_id}

    def git_summary(self) -> dict[str, Any]:
        def run_git(*arguments: str, preserve_leading: bool = False) -> str:
            try:
                completed = subprocess.run(
                    ["git", "-C", str(self.project_root), *arguments],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=2,
                )
                output = completed.stdout.rstrip() if preserve_leading else completed.stdout.strip()
                return redact(output)
            except (OSError, subprocess.SubprocessError):
                return ""

        status = run_git("status", "--short", preserve_leading=True).splitlines()
        checkpoints = run_git(
            "log",
            "--oneline",
            "--decorate",
            "--max-count=12",
            "--grep=^chore(ralph):",
        ).splitlines()
        return {
            "branch": run_git("branch", "--show-current"),
            "head": run_git("rev-parse", "--short", "HEAD"),
            "dirty": bool(status),
            "status": status[:120],
            "diffStat": run_git("diff", "--stat"),
            "checkpoints": checkpoints,
        }

    def _legacy_events(self, run_dir: Path) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for row in read_jsonl(run_dir / "fallback-events.jsonl"):
            events.append(
                {
                    "id": f"fallback-{len(events)}",
                    "timestamp": row.get("timestamp", ""),
                    "type": "fallback",
                    "runId": run_dir.name,
                    "task": "",
                    "iteration": 0,
                    "stage": row.get("stage", "fallback"),
                    "status": row.get("action", "info"),
                    "role": row.get("role", ""),
                    "modelAlias": row.get("modelAlias", ""),
                    "attempt": row.get("attempt", 0),
                    "summary": f"{row.get('action', 'fallback')}: {row.get('errorClass', '')}",
                    "artifact": "fallback-events.jsonl",
                    "score": None,
                    "verdict": None,
                }
            )
        return events

    def _stage_snapshot(
        self,
        iteration: int,
        events: list[dict[str, Any]],
        *,
        active: bool = True,
        run_status: str = "running",
        checkpoint: dict[str, Any] | None = None,
        model_catalog: dict[str, dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        checkpoint = checkpoint or {}
        model_catalog = model_catalog or {}
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for event in events:
            if int(event.get("iteration") or 0) != iteration:
                continue
            grouped[normalize_stage(str(event.get("stage") or ""))].append(event)

        snapshots: list[dict[str, Any]] = []
        for stage_id, label, description in STAGES:
            matching = grouped.get(stage_id, [])
            latest = matching[-1] if matching else {}
            summary_override = ""
            status = "pending"
            if matching:
                latest_status = str(latest.get("status") or "")
                latest_type = str(latest.get("type") or "")
                completed_event = next(
                    (event for event in reversed(matching) if event.get("type") in {"stage_completed", "checkpoint_completed"}),
                    None,
                )
                failed_event = next(
                    (event for event in reversed(matching) if event.get("type") == "checkpoint_failed" or event.get("status") in {"failed", "stop_non_retryable"}),
                    None,
                )
                if failed_event and (completed_event is None or matching.index(failed_event) > matching.index(completed_event)):
                    status = "failed"
                elif completed_event is not None:
                    status = "completed"
                    latest = completed_event
                elif latest_status in {"retry_same_model", "fallback_next_model", "retrying", "skip_degraded", "warning"}:
                    status = "warning"
                elif latest_status in {"running", "preparing", "completed", "success"}:
                    status = "running"
                elif latest_type:
                    status = "running"

            checkpoint_status = str(checkpoint.get("status") or "")
            if stage_id == "meta_prompter" and checkpoint_status in {"meta_failed", "meta_invalid"}:
                status = "failed"
                description = (
                    "Meta-Prompter 출력이 전체 작업 계약 형식을 충족하지 못해 실행이 중단되었습니다."
                    if checkpoint_status == "meta_invalid"
                    else "Meta-Prompter 모델 체인이 완료되지 못해 실행이 중단되었습니다."
                )
                summary_override = description
                latest = {**latest, "summary": description}
            if stage_id == "worker" and checkpoint_status in {"worker_failed", "worker_fallback_exhausted"}:
                status = "failed"
                description = "Worker 모델 체인을 모두 시도했지만 구현 단계를 완료하지 못했습니다."
                summary_override = description
                latest = {**latest, "summary": description}
            if stage_id == "post_critic" and str(latest.get("verdict") or "") == "fail":
                status = "failed"
                critic_score = safe_int(latest.get("score"))
                score_text = f"{critic_score}점으로 " if critic_score is not None else ""
                description = f"Post-Critic 평가는 완료되었지만 {score_text}통과 판정을 받지 못했습니다."
                summary_override = description
                latest = {**latest, "summary": description}
            if stage_id == "checkpoint":
                if run_status == "checkpoint_failed":
                    status = "failed"
                    failure_event = next(
                        (event for event in reversed(matching) if event.get("type") == "checkpoint_failed"),
                        None,
                    )
                    error_artifact = str(checkpoint.get("_errorArtifact") or "")
                    if failure_event:
                        latest = failure_event
                        summary_override = str(failure_event.get("summary") or "Git checkpoint 생성이 실패했습니다.")
                    elif error_artifact:
                        summary_override = "Git 안전 검사 또는 commit 과정이 실패했습니다. 저장된 오류 로그에서 정확한 원인을 확인해 주세요."
                        latest = {"summary": summary_override, "artifact": error_artifact}
                    else:
                        summary_override = "이 과거 실행은 오류 로그 저장 기능이 추가되기 전에 종료되어 정확한 Git 실패 원인이 남아 있지 않습니다. 현재 checkpoint 안전 테스트는 통과하지만, 이 실행의 원인이 해결됐다고 단정할 수는 없습니다."
                        latest = {"summary": summary_override, "artifact": ""}
                elif checkpoint.get("commit"):
                    if checkpoint_status in {"meta_failed", "meta_invalid", "worker_failed", "worker_fallback_exhausted"}:
                        status = "warning"
                        description = "실행이 비정상 종료되기 전에 현재 변경을 복구할 수 있도록 안전 저장했습니다. Iteration 완료를 뜻하지 않습니다."
                    else:
                        status = "completed"
                        description = "Iteration 종료 시점의 변경을 되돌릴 수 있는 로컬 Git 복구 지점으로 저장했습니다."
                    summary_override = description
                    latest = {
                        **latest,
                        "summary": description,
                        "artifact": f"git-checkpoint-{iteration}.json",
                    }

            if not active and status == "running":
                status = "failed"
                description = "실행이 중단되어 이 단계의 완료 기록이 남지 않았습니다."
                summary_override = description
                latest = {**latest, "summary": description}

            model_alias = str(latest.get("modelAlias") or "")
            if not model_alias:
                model_alias = next((str(event.get("modelAlias")) for event in reversed(matching) if event.get("modelAlias")), "")
            latest_attempt = max((safe_int(event.get("attempt")) or 0 for event in matching), default=0)
            model_info = self._model_info(model_alias, model_catalog)
            executor_label = str(model_info.get("displayLabel") or STAGE_EXECUTOR_LABELS.get(stage_id) or "실행 정보 없음")
            snapshots.append(
                {
                    "id": stage_id,
                    "label": label,
                    "description": description,
                    "status": status,
                    "summary": summary_override or (humanize_fallback_event(latest) if latest else description),
                    "modelAlias": model_alias,
                    "model": model_info,
                    "executorLabel": executor_label,
                    "attempt": latest_attempt,
                    "artifact": latest.get("artifact") or "",
                    "score": latest.get("score"),
                    "verdict": latest.get("verdict"),
                    "timestamp": latest.get("timestamp") or "",
                    "events": [decorate_event(event) for event in matching[-40:]],
                }
            )
        return snapshots

    @staticmethod
    def _usage_key(iteration: int, stage: str, model_alias: str, attempt: int) -> tuple[int, str, str, int]:
        return (iteration, normalize_stage(stage), model_alias, attempt)

    def _usage_rows(self, run_dir: Path) -> dict[tuple[int, str, str, int], dict[str, Any]]:
        aggregated: dict[tuple[int, str, str, int], dict[str, Any]] = {}

        def add_usage(row: dict[str, Any], *, fallback_stage: str = "", fallback_alias: str = "") -> None:
            usage = row.get("usage") if isinstance(row.get("usage"), dict) else row
            iteration = safe_int(row.get("iteration")) or 0
            stage = str(row.get("stage") or fallback_stage)
            alias = str(row.get("modelAlias") or fallback_alias)
            attempt = safe_int(row.get("attempt")) or 1
            if not alias or not stage:
                return
            input_tokens = safe_int(usage.get("inputTokens"))
            if input_tokens is None:
                input_tokens = safe_int(usage.get("input_tokens"))
            if input_tokens is None:
                input_tokens = safe_int(usage.get("prompt_tokens"))
            if input_tokens is None:
                input_tokens = safe_int(usage.get("promptTokenCount"))
            output_tokens = safe_int(usage.get("outputTokens"))
            if output_tokens is None:
                output_tokens = safe_int(usage.get("output_tokens"))
            if output_tokens is None:
                output_tokens = safe_int(usage.get("completion_tokens"))
            if output_tokens is None:
                output_tokens = safe_int(usage.get("candidatesTokenCount"))
            cached_tokens = safe_int(usage.get("cachedInputTokens"))
            if cached_tokens is None:
                cached_tokens = safe_int(usage.get("cached_input_tokens"))
            if cached_tokens is None:
                cached_tokens = safe_int(usage.get("cache_read_input_tokens"))
            reasoning_tokens = safe_int(usage.get("reasoningOutputTokens"))
            if reasoning_tokens is None:
                reasoning_tokens = safe_int(usage.get("reasoning_output_tokens"))
            total_tokens = safe_int(usage.get("totalTokens"))
            if total_tokens is None:
                total_tokens = safe_int(usage.get("total_tokens"))
            if total_tokens is None:
                total_tokens = safe_int(usage.get("totalTokenCount"))
            if total_tokens is None and (input_tokens is not None or output_tokens is not None):
                total_tokens = (input_tokens or 0) + (output_tokens or 0)
            if total_tokens is None:
                return
            key = self._usage_key(iteration, stage, alias, attempt)
            target = aggregated.setdefault(
                key,
                {
                    "inputTokens": 0,
                    "outputTokens": 0,
                    "cachedInputTokens": 0,
                    "reasoningOutputTokens": 0,
                    "totalTokens": 0,
                    "hasInput": False,
                    "hasOutput": False,
                    "source": str(row.get("source") or "provider_usage"),
                },
            )
            target["inputTokens"] += input_tokens or 0
            target["outputTokens"] += output_tokens or 0
            target["cachedInputTokens"] += cached_tokens or 0
            target["reasoningOutputTokens"] += reasoning_tokens or 0
            target["totalTokens"] += total_tokens
            target["hasInput"] = target["hasInput"] or input_tokens is not None
            target["hasOutput"] = target["hasOutput"] or output_tokens is not None

        for row in read_jsonl(run_dir / "usage-events.jsonl"):
            add_usage(row)

        # 계측 도입 전 직접 API 하네스 run도 provider usage를 최대한 복구한다.
        for path in run_dir.glob("tool-events-*.jsonl"):
            for row in read_jsonl(path):
                if row.get("event") == "model_response" and isinstance(row.get("usage"), dict):
                    key = self._usage_key(
                        safe_int(row.get("iteration")) or 0,
                        str(row.get("stage") or ""),
                        str(row.get("modelAlias") or ""),
                        safe_int(row.get("attempt")) or 1,
                    )
                    if key not in aggregated:
                        add_usage(row)
        return aggregated

    @staticmethod
    def _historical_total(stderr_path: Path) -> int | None:
        text = read_text(stderr_path, limit=64 * 1024, tail=True)
        matches = re.findall(r"tokens used\s*\n\s*([0-9][0-9,]*)", text, re.IGNORECASE)
        return safe_int(matches[-1]) if matches else None

    def _usage_snapshot(
        self,
        run_dir: Path,
        metadata: dict[str, Any],
        events: list[dict[str, Any]],
        model_catalog: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        exact_usage = self._usage_rows(run_dir)
        started: dict[tuple[int, str, str, int], dict[str, Any]] = {}
        terminal: list[dict[str, Any]] = []
        stage_summaries: dict[tuple[int, str], str] = {}
        for event in events:
            iteration = safe_int(event.get("iteration")) or 0
            normalized_stage = normalize_stage(str(event.get("stage") or ""))
            alias = str(event.get("modelAlias") or "")
            attempt = safe_int(event.get("attempt")) or 1
            key = self._usage_key(iteration, normalized_stage, alias, attempt)
            if event.get("type") == "model_attempt_started":
                started[key] = event
            elif event.get("type") in {"model_attempt_completed", "model_attempt_failed"}:
                terminal.append(event)
            elif event.get("type") == "stage_completed":
                stage_summaries[(iteration, normalized_stage)] = str(event.get("summary") or "")

        calls: list[dict[str, Any]] = []
        for event in terminal:
            iteration = safe_int(event.get("iteration")) or 0
            stage = normalize_stage(str(event.get("stage") or ""))
            alias = str(event.get("modelAlias") or "")
            attempt = safe_int(event.get("attempt")) or 1
            key = self._usage_key(iteration, stage, alias, attempt)
            usage = exact_usage.get(key)
            if usage is None:
                # 과거 tool event에는 iteration이 없을 수 있다.
                usage = exact_usage.get(self._usage_key(0, stage, alias, attempt))
            artifact = str(event.get("artifact") or "")
            historical_total = self._historical_total(run_dir / f"{artifact}.stderr") if artifact else None
            if usage:
                token_detail = "exact" if usage.get("hasInput") and usage.get("hasOutput") else "total_only"
                input_tokens = usage.get("inputTokens") if usage.get("hasInput") else None
                output_tokens = usage.get("outputTokens") if usage.get("hasOutput") else None
                cached_tokens = usage.get("cachedInputTokens") if usage.get("hasInput") else None
                reasoning_tokens = usage.get("reasoningOutputTokens") if usage.get("hasOutput") else None
                total_tokens = usage.get("totalTokens")
                usage_source = usage.get("source")
            elif historical_total is not None:
                token_detail = "total_only"
                input_tokens = None
                output_tokens = None
                cached_tokens = None
                reasoning_tokens = None
                total_tokens = historical_total
                usage_source = "legacy_cli_total"
            else:
                token_detail = "unavailable"
                input_tokens = None
                output_tokens = None
                cached_tokens = None
                reasoning_tokens = None
                total_tokens = None
                usage_source = "unavailable"
            start_event = started.get(key, {})
            stage_label, stage_description = STAGE_BY_ID.get(stage, (str(event.get("stage") or stage), "모델 작업"))
            model_info = self._model_info(alias, model_catalog)
            calls.append(
                {
                    "id": f"{iteration}-{stage}-{alias}-{attempt}",
                    "iteration": iteration,
                    "stage": stage,
                    "stageLabel": stage_label,
                    "role": event.get("role") or start_event.get("role") or "",
                    "modelAlias": alias,
                    "model": model_info,
                    "attempt": attempt,
                    "status": "failed" if event.get("type") == "model_attempt_failed" else "completed",
                    "startedAt": start_event.get("timestamp") or "",
                    "completedAt": event.get("timestamp") or "",
                    "summary": stage_summaries.get((iteration, stage)) or stage_description,
                    "artifact": artifact,
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "cachedInputTokens": cached_tokens,
                    "reasoningOutputTokens": reasoning_tokens,
                    "totalTokens": total_tokens,
                    "tokenDetail": token_detail,
                    "usageSource": usage_source,
                }
            )

        models: dict[str, dict[str, Any]] = {}
        for call in calls:
            alias = call["modelAlias"]
            model = models.setdefault(
                alias,
                {
                    "modelAlias": alias,
                    "model": call["model"],
                    "calls": 0,
                    "completedCalls": 0,
                    "failedCalls": 0,
                    "exactCalls": 0,
                    "knownTotalCalls": 0,
                    "inputTokens": 0,
                    "outputTokens": 0,
                    "cachedInputTokens": 0,
                    "reasoningOutputTokens": 0,
                    "totalTokens": 0,
                    "tasks": [],
                },
            )
            model["calls"] += 1
            model["completedCalls" if call["status"] == "completed" else "failedCalls"] += 1
            if call["tokenDetail"] == "exact":
                model["exactCalls"] += 1
            if call["totalTokens"] is not None:
                model["knownTotalCalls"] += 1
                model["totalTokens"] += int(call["totalTokens"])
            model["inputTokens"] += int(call["inputTokens"] or 0)
            model["outputTokens"] += int(call["outputTokens"] or 0)
            model["cachedInputTokens"] += int(call["cachedInputTokens"] or 0)
            model["reasoningOutputTokens"] += int(call["reasoningOutputTokens"] or 0)
            task_label = f"Iteration {call['iteration']} · {call['stageLabel']}"
            if task_label not in model["tasks"]:
                model["tasks"].append(task_label)

        model_rows = sorted(models.values(), key=lambda item: item["totalTokens"], reverse=True)
        total_tokens = sum(item["totalTokens"] for item in model_rows)
        totals = {
            "calls": len(calls),
            "exactCalls": sum(1 for call in calls if call["tokenDetail"] == "exact"),
            "knownTotalCalls": sum(1 for call in calls if call["totalTokens"] is not None),
            "inputTokens": sum(item["inputTokens"] for item in model_rows),
            "outputTokens": sum(item["outputTokens"] for item in model_rows),
            "cachedInputTokens": sum(item["cachedInputTokens"] for item in model_rows),
            "reasoningOutputTokens": sum(item["reasoningOutputTokens"] for item in model_rows),
            "totalTokens": total_tokens,
        }
        for model in model_rows:
            model["sharePercent"] = round(model["totalTokens"] / total_tokens * 100, 1) if total_tokens else 0
        legacy_total_calls = sum(1 for call in calls if call["usageSource"] == "legacy_cli_total")
        total_only_calls = sum(1 for call in calls if call["tokenDetail"] == "total_only")
        if legacy_total_calls:
            usage_note = (
                f"이 실행의 {legacy_total_calls}개 호출은 계측 도입 전 CLI 로그에서 총 토큰만 복구했습니다. "
                "입력·출력 값을 임의로 추정하지 않습니다."
            )
        elif total_only_calls:
            usage_note = (
                f"공급자 또는 호출 도구가 {total_only_calls}개 호출에서 총 토큰만 제공했습니다. "
                "입력·출력 값을 임의로 추정하지 않습니다."
            )
        else:
            usage_note = "공급자가 보고한 구조화된 usage 값을 호출별로 집계합니다."
        return {
            "totals": totals,
            "models": model_rows,
            "calls": calls,
            "note": usage_note,
        }

    def _live_artifact(self, run_dir: Path, events: list[dict[str, Any]]) -> dict[str, Any] | None:
        candidates: list[Path] = []
        for event in reversed(events):
            artifact = str(event.get("artifact") or "")
            path = self.safe_artifact(run_dir.name, artifact)
            if path is not None:
                candidates.append(path)
                break
        attempt_files = sorted(run_dir.glob("*.attempt-*"), key=lambda path: path.stat().st_mtime, reverse=True)
        if attempt_files and (not candidates or attempt_files[0].stat().st_mtime > candidates[0].stat().st_mtime):
            candidates.insert(0, attempt_files[0])
        if not candidates:
            return None
        path = candidates[0]
        return {
            "artifact": path.name,
            "content": read_text(path, limit=48 * 1024, tail=True),
            "size": path.stat().st_size,
            "updatedAt": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
        }

    def build_snapshot(self, run_id: str | None = None, bypass_cache: bool = False) -> dict[str, Any]:
        cache_key = run_id or "__current__"
        now = time.monotonic()
        with self._cache_lock:
            if not bypass_cache and self._cache_key == cache_key and self._cache_value is not None and now - self._cache_at < 0.45:
                return self._cache_value

        run_dir = self.resolve_run_dir(run_id)
        runs = self.list_runs()
        git = self.git_summary()
        if run_dir is None:
            snapshot = {
                "generatedAt": utc_now(),
                "projectRoot": str(self.project_root),
                "workspace": {"name": self.project_root.name, "path": str(self.project_root), "branch": git.get("branch")},
                "active": False,
                "run": None,
                "runs": runs,
                "iterations": [],
                "tasks": parse_prompt_tasks(read_text(self.prompt_file)),
                "events": [],
                "liveArtifact": None,
                "usage": {"totals": {}, "models": [], "calls": [], "note": "아직 선택된 실행이 없습니다."},
                "git": git,
            }
        else:
            metadata = read_json(run_dir / "run.json")
            events = read_jsonl(run_dir / "events.jsonl")
            if not events:
                events = self._legacy_events(run_dir)
            final_event = next((event for event in reversed(events) if event.get("type") == "run_completed"), None)
            active = bool(self.lock_dir.exists() and run_dir == self.latest_run_dir() and final_event is None)
            state = self._state_for_run(run_dir)
            run_status = str((final_event or {}).get("status") or ("running" if active else state.get("status") or "interrupted"))
            model_catalog = self._model_catalog(metadata)
            iteration_numbers = sorted({int(event.get("iteration") or 0) for event in events if int(event.get("iteration") or 0) > 0})
            iterations = []
            for number in iteration_numbers:
                checkpoint = read_json(run_dir / f"git-checkpoint-{number}.json")
                checkpoint_error_path = run_dir / f"git-checkpoint-{number}.stderr"
                if checkpoint_error_path.is_file():
                    checkpoint["_errorArtifact"] = checkpoint_error_path.name
                stages = self._stage_snapshot(
                    number,
                    events,
                    active=active,
                    run_status=run_status if number == iteration_numbers[-1] else "completed",
                    checkpoint=checkpoint,
                    model_catalog=model_catalog,
                )
                checkpoint_status = str(checkpoint.get("status") or "")
                if checkpoint_status == "passed":
                    status = "completed"
                elif checkpoint_status == "retrying":
                    status = "warning"
                elif checkpoint_status:
                    status = "failed" if checkpoint_status in {"meta_failed", "meta_invalid", "worker_failed", "worker_fallback_exhausted", "max_iterations_reached"} else "warning"
                    if checkpoint_status == "needs_operator":
                        status = "needs_operator"
                elif active and number == iteration_numbers[-1]:
                    status = "running"
                elif any(stage["status"] == "failed" for stage in stages) or run_status not in {"passed", "completed"}:
                    status = "failed"
                else:
                    status = "completed"
                iterations.append(
                    {
                        "number": number,
                        "status": status,
                        "score": checkpoint.get("criticScore"),
                        "verdict": checkpoint.get("criticVerdict"),
                        "checkpoint": {
                            "commit": checkpoint.get("commit") or "",
                            "status": checkpoint_status,
                            "isRecovery": checkpoint_status in {"meta_failed", "meta_invalid", "worker_failed", "worker_fallback_exhausted", "needs_operator"},
                        },
                        "stages": stages,
                    }
                )
            prompt_path = self.prompt_file
            prompt_candidates = sorted(run_dir.glob("prompt-*.next.md"), key=lambda path: path.stat().st_mtime)
            if not active and prompt_candidates:
                prompt_path = prompt_candidates[-1]
            run_passed = run_status == "passed"
            tasks = parse_prompt_tasks(read_text(prompt_path), run_passed=run_passed)
            usage = self._usage_snapshot(run_dir, metadata, events, model_catalog)
            route = metadata.get("route") if isinstance(metadata.get("route"), dict) else {}
            snapshot = {
                "generatedAt": utc_now(),
                "projectRoot": str(self.project_root),
                "workspace": {"name": self.project_root.name, "path": str(self.project_root), "branch": metadata.get("branch") or git.get("branch")},
                "active": active,
                "run": {
                    "runId": metadata.get("runId") or run_dir.name,
                    "task": metadata.get("task") or (events[-1].get("task") if events else "unknown"),
                    "taskLabel": route.get("taskLabel") or metadata.get("task") or "unknown",
                    "status": run_status,
                    "startedAt": metadata.get("startedAt"),
                    "lastActivityAt": events[-1].get("timestamp") if events else metadata.get("startedAt"),
                    "endedAt": None if active else (events[-1].get("timestamp") if events else metadata.get("startedAt")),
                    "maxIterations": metadata.get("maxIterations"),
                    "minimumCriticScore": metadata.get("minimumCriticScore"),
                    "branch": metadata.get("branch") or git.get("branch"),
                    "baselineCommit": metadata.get("baselineCommit"),
                    "directory": str(run_dir),
                },
                "runs": runs,
                "iterations": iterations,
                "tasks": tasks,
                "events": [decorate_event(event) for event in events[-250:]],
                "liveArtifact": self._live_artifact(run_dir, events),
                "usage": usage,
                "git": git,
            }

        with self._cache_lock:
            self._cache_key = cache_key
            self._cache_at = now
            self._cache_value = snapshot
        return snapshot


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "RalphDashboard/1.0"
    protocol_version = "HTTP/1.1"

    @property
    def repository(self) -> RalphRepository:
        return self.server.repository  # type: ignore[attr-defined]

    def log_message(self, message: str, *args: Any) -> None:
        sys.stderr.write(f"[dashboard] {self.address_string()} {message % args}\n")

    def _send_bytes(self, body: bytes, content_type: str, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_bytes(body, "application/json; charset=utf-8", status)

    def _serve_static(self, request_path: str) -> None:
        relative = "index.html" if request_path in {"", "/"} else request_path.lstrip("/")
        candidate = (STATIC_DIR / relative).resolve()
        try:
            candidate.relative_to(STATIC_DIR.resolve())
        except ValueError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
            content_type += "; charset=utf-8"
        self._send_bytes(candidate.read_bytes(), content_type)

    def _serve_sse(self, run_id: str | None) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        previous = ""
        last_keepalive = time.monotonic()
        try:
            while True:
                snapshot = self.repository.build_snapshot(run_id, bypass_cache=True)
                payload = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
                digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
                if digest != previous:
                    self.wfile.write(f"event: snapshot\ndata: {payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    previous = digest
                    last_keepalive = time.monotonic()
                elif time.monotonic() - last_keepalive >= 12:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    last_keepalive = time.monotonic()
                time.sleep(0.65)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/api/snapshot":
            self._send_json(self.repository.build_snapshot(query.get("runId", [None])[0], bypass_cache=True))
            return
        if parsed.path == "/api/events":
            self._serve_sse(query.get("runId", [None])[0])
            return
        if parsed.path == "/api/artifact":
            run_id = query.get("runId", [""])[0]
            artifact = query.get("artifact", [""])[0]
            payload = self.repository.artifact_payload(run_id, artifact)
            if payload is None:
                self._send_json({"error": "허용되지 않거나 존재하지 않는 실행 증거입니다."}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(payload)
            return
        if parsed.path == "/api/health":
            self._send_json({"ok": True, "time": utc_now(), "projectRoot": str(self.repository.project_root)})
            return
        self._serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/operator-note":
            self._send_json({"error": "지원하지 않는 작업입니다."}, HTTPStatus.NOT_FOUND)
            return
        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("application/json"):
            self._send_json({"error": "application/json 요청만 허용합니다."}, HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_OPERATOR_NOTE_BYTES * 2:
            self._send_json({"error": "요청 크기가 올바르지 않습니다."}, HTTPStatus.BAD_REQUEST)
            return
        try:
            payload = json.loads(self.rfile.read(length))
            note = payload.get("note", "") if isinstance(payload, dict) else ""
            result = self.repository.write_operator_note(str(note))
        except (json.JSONDecodeError, ValueError) as error:
            self._send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        self._send_json(result)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/runs":
            content_type = self.headers.get("Content-Type", "")
            if not content_type.startswith("application/json"):
                self._send_json({"error": "application/json 요청만 허용합니다."}, HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length <= 0 or length > 64 * 1024:
                self._send_json({"error": "요청 크기가 올바르지 않습니다."}, HTTPStatus.BAD_REQUEST)
                return
            try:
                payload = json.loads(self.rfile.read(length))
                raw_ids = payload.get("runIds") if isinstance(payload, dict) else None
                if not isinstance(raw_ids, list) or any(not isinstance(run_id, str) for run_id in raw_ids):
                    raise ValueError("runIds는 실행 ID 문자열 배열이어야 합니다.")
                result = self.repository.delete_runs(raw_ids)
            except (json.JSONDecodeError, ValueError) as error:
                self._send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
                return
            except FileNotFoundError as error:
                self._send_json({"error": str(error)}, HTTPStatus.NOT_FOUND)
                return
            except RuntimeError as error:
                self._send_json({"error": str(error)}, HTTPStatus.CONFLICT)
                return
            except OSError as error:
                self._send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
                return
            self._send_json(result)
            return
        match = re.fullmatch(r"/api/runs/([^/]+)", parsed.path)
        if match is None:
            self._send_json({"error": "지원하지 않는 작업입니다."}, HTTPStatus.NOT_FOUND)
            return
        run_id = unquote(match.group(1))
        try:
            result = self.repository.delete_run(run_id)
        except FileNotFoundError as error:
            self._send_json({"error": str(error)}, HTTPStatus.NOT_FOUND)
            return
        except RuntimeError as error:
            self._send_json({"error": str(error)}, HTTPStatus.CONFLICT)
            return
        except (OSError, ValueError) as error:
            self._send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        self._send_json(result)


class RalphDashboardServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], repository: RalphRepository):
        super().__init__(address, DashboardHandler)
        self.repository = repository


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ralph Loop 로컬 관제 대시보드")
    parser.add_argument("--project-root", type=Path, default=DEFAULT_PROJECT_ROOT)
    parser.add_argument("--host", default="127.0.0.1", choices=("127.0.0.1", "localhost", "::1"))
    parser.add_argument("--port", type=int, default=7331)
    parser.add_argument("--open", action="store_true", dest="open_browser")
    parser.add_argument("--check", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    project_root = args.project_root.resolve()
    if not (project_root / ".ralph").is_dir():
        print(f"ERROR: .ralph 디렉터리가 없습니다: {project_root}", file=sys.stderr)
        return 2
    if not STATIC_DIR.is_dir():
        print(f"ERROR: dashboard static 디렉터리가 없습니다: {STATIC_DIR}", file=sys.stderr)
        return 2
    repository = RalphRepository(project_root)
    if args.check:
        snapshot = repository.build_snapshot(bypass_cache=True)
        print(
            json.dumps(
                {
                    "ok": True,
                    "projectRoot": str(project_root),
                    "runs": len(snapshot.get("runs", [])),
                    "tasks": len(snapshot.get("tasks", [])),
                },
                ensure_ascii=False,
            )
        )
        return 0
    if not (1 <= args.port <= 65535):
        print("ERROR: port는 1..65535 범위여야 합니다.", file=sys.stderr)
        return 2
    server = RalphDashboardServer((args.host, args.port), repository)
    url = f"http://{args.host}:{server.server_port}"
    print(f"Ralph Control Center: {url}")
    print("로컬 파일과 실행 로그만 사용하며 외부로 전송하지 않습니다. 종료: Ctrl+C")
    if args.open_browser:
        threading.Timer(0.35, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\nDashboard를 종료합니다.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
