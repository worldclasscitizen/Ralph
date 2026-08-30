from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _token_value(usage: dict[str, Any], *names: str) -> int | None:
    for name in names:
        value = usage.get(name)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)) and value >= 0:
            return int(value)
        if isinstance(value, str):
            try:
                parsed = int(value.replace(",", "").strip())
            except ValueError:
                continue
            if parsed >= 0:
                return parsed
    return None


def normalize_usage(usage: dict[str, Any]) -> dict[str, int | None]:
    input_tokens = _token_value(usage, "inputTokens", "input_tokens", "prompt_tokens", "promptTokenCount")
    output_tokens = _token_value(
        usage,
        "outputTokens",
        "output_tokens",
        "completion_tokens",
        "candidatesTokenCount",
    )
    cached_input_tokens = _token_value(
        usage,
        "cachedInputTokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
        "cachedContentTokenCount",
    )
    reasoning_output_tokens = _token_value(
        usage,
        "reasoningOutputTokens",
        "reasoning_output_tokens",
        "reasoning_tokens",
        "thoughtsTokenCount",
    )
    total_tokens = _token_value(usage, "totalTokens", "total_tokens", "totalTokenCount")
    if total_tokens is None and (input_tokens is not None or output_tokens is not None):
        total_tokens = (input_tokens or 0) + (output_tokens or 0)
    return {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cachedInputTokens": cached_input_tokens,
        "reasoningOutputTokens": reasoning_output_tokens,
        "totalTokens": total_tokens,
    }


def record_usage(run_dir: Path, payload: dict[str, Any]) -> bool:
    raw_usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else payload
    normalized = normalize_usage(raw_usage)
    if normalized["totalTokens"] is None:
        return False
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "provider": str(payload.get("provider") or ""),
        "modelAlias": str(payload.get("modelAlias") or os.environ.get("RALPH_MODEL_ALIAS") or ""),
        "modelId": str(payload.get("modelId") or ""),
        "task": str(payload.get("task") or os.environ.get("RALPH_TASK_ID") or ""),
        "iteration": int(payload.get("iteration") or os.environ.get("RALPH_ITERATION") or 0),
        "stage": str(payload.get("stage") or os.environ.get("RALPH_STAGE") or ""),
        "role": str(payload.get("role") or os.environ.get("RALPH_ROLE") or ""),
        "attempt": int(payload.get("attempt") or os.environ.get("RALPH_ATTEMPT") or 1),
        "source": str(payload.get("source") or "provider_usage"),
        **normalized,
    }
    run_dir.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    descriptor = os.open(run_dir / "usage-events.jsonl", os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, encoded)
    finally:
        os.close(descriptor)
    return True
