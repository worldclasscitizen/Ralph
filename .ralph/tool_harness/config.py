from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class HarnessConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class ModelRuntime:
    alias: str
    provider: str
    model_id: str
    reasoning_effort: str
    connection: dict[str, Any]
    policy: dict[str, Any]


def read_dotenv(path: Path) -> dict[str, str]:
    """Read the small KEY=VALUE subset used by this repository without sourcing shell code."""
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise HarnessConfigError(f".env {line_number}행이 KEY=VALUE 형식이 아닙니다.")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or not key.replace("_", "").isalnum() or not key[0].isalpha():
            raise HarnessConfigError(f".env {line_number}행의 환경변수 이름이 올바르지 않습니다.")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        values[key] = value
    return values


def load_resolved_config(project_root: Path) -> dict[str, Any]:
    resolver = project_root / ".ralph" / "resolve-config.sh"
    try:
        completed = subprocess.run(
            [str(resolver), "--resolved"],
            cwd=project_root,
            check=True,
            text=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        raise HarnessConfigError(f"개인 모델 설정을 해석하지 못했습니다: {detail.strip()}") from exc
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise HarnessConfigError("resolve-config.sh가 유효한 JSON을 반환하지 않았습니다.") from exc


def resolve_model(project_root: Path, alias: str) -> ModelRuntime:
    resolved = load_resolved_config(project_root)
    model = resolved.get("models", {}).get(alias)
    if not isinstance(model, dict):
        raise HarnessConfigError(f"개인 설정에 없는 model alias입니다: {alias}")
    provider = model.get("provider")
    provider_selection = resolved.get("providers", {}).get(provider)
    if not isinstance(provider_selection, dict):
        raise HarnessConfigError(f"모델의 Provider 연결을 찾을 수 없습니다: {alias} -> {provider}")
    policy = resolved.get("workerHarnessPolicy")
    if not isinstance(policy, dict):
        raise HarnessConfigError("공용 workerHarnessPolicy가 없습니다.")
    return ModelRuntime(
        alias=alias,
        provider=str(provider),
        model_id=str(model.get("modelId", "")),
        reasoning_effort=str(model.get("reasoning", {}).get("value", "")),
        connection=dict(provider_selection.get("connection", {})),
        policy=dict(policy),
    )
