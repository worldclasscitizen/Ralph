#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tool_harness.bridge import run_glm_coding_plan_bridge
from tool_harness.config import HarnessConfigError, read_dotenv, resolve_model
from tool_harness.providers import ApiError, ChatCompletionsProvider
from tool_harness.runner import AgentProtocolError, run_direct_agent
from tool_harness.tools import ToolExecutionError, ToolPolicyError
from tool_harness.usage import record_usage


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Ralph provider-neutral tool-call Worker")
    parser.add_argument("--model-alias", required=True)
    parser.add_argument("--mode", choices=("run", "smoke"), default="run")
    return parser


def make_event_logger(run_dir: Path, model_alias: str):
    stage = os.environ.get("RALPH_STAGE", "manual").replace("/", "_").replace(" ", "-")
    iteration = int(os.environ.get("RALPH_ITERATION", "0") or 0)
    attempt = int(os.environ.get("RALPH_ATTEMPT", "1") or 1)
    role = os.environ.get("RALPH_ROLE", "worker")
    event_file = run_dir / f"tool-events-{stage}-{model_alias}-{os.getpid()}.jsonl"
    event_file.parent.mkdir(parents=True, exist_ok=True)

    def log(event: str, data: dict[str, Any]) -> None:
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": event,
            "modelAlias": model_alias,
            "stage": stage,
            "iteration": iteration,
            "attempt": attempt,
            "role": role,
            **data,
        }
        with event_file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        if event == "model_response" and isinstance(data.get("usage"), dict):
            try:
                record_usage(
                    run_dir,
                    {
                        "provider": data.get("provider") or "direct_api_or_bridge",
                        "modelAlias": model_alias,
                        "modelId": data.get("model") or "",
                        "iteration": iteration,
                        "attempt": attempt,
                        "stage": stage,
                        "role": role,
                        "source": "tool_harness_response",
                        "usage": data["usage"],
                    },
                )
            except (OSError, TypeError, ValueError):
                pass

    return log


def error_exit(error_class: str, message: str, http_status: int | None = None) -> int:
    safe_message = " ".join(message.replace("\n", " ").split())[:800]
    payload: dict[str, Any] = {"class": error_class, "message": safe_message}
    if http_status is not None:
        payload["httpStatus"] = http_status
    print(f"RALPH_AGENT_ERROR {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}", file=sys.stderr)
    return {
        "rate_limit": 75,
        "server_error": 75,
        "timeout": 124,
        "authentication": 77,
        "policy_denial": 78,
        "invalid_request": 64,
    }.get(error_class, 70)


def main() -> int:
    args = build_parser().parse_args()
    prompt = sys.stdin.read()
    if not prompt.strip():
        return error_exit("invalid_request", "stdin Worker 프롬프트가 비어 있습니다.")
    runtime = resolve_model(PROJECT_ROOT, args.model_alias)
    dotenv = read_dotenv(PROJECT_ROOT / ".env")
    run_dir = Path(os.environ.get("RALPH_RUN_DIR", SCRIPT_DIR / "runs" / f"manual-{os.getpid()}"))
    event_logger = make_event_logger(run_dir, args.model_alias)

    if runtime.provider == "zai-coding-plan":
        output = run_glm_coding_plan_bridge(
            project_root=PROJECT_ROOT,
            runtime=runtime,
            prompt=prompt,
            mode=args.mode,
            dotenv=dotenv,
            run_dir=run_dir,
            event_callback=event_logger,
        )
    elif runtime.provider in {"deepseek", "zai-general"}:
        api_key_env = str(runtime.connection.get("apiKeyEnv") or "")
        base_url_env = str(runtime.connection.get("baseUrlEnv") or "")
        api_key = os.environ.get(api_key_env) or dotenv.get(api_key_env, "")
        base_url = os.environ.get(base_url_env) or dotenv.get(base_url_env, "") or str(runtime.connection.get("baseUrl") or "")
        if not api_key:
            raise HarnessConfigError(f"API 키가 설정되지 않았습니다: {api_key_env}")
        if not base_url:
            raise HarnessConfigError(f"API Base URL이 설정되지 않았습니다: {base_url_env}")
        provider = ChatCompletionsProvider(
            provider=runtime.provider,
            base_url=base_url,
            api_key=api_key,
            model_id=runtime.model_id,
            reasoning_effort=runtime.reasoning_effort,
            timeout_seconds=int(runtime.policy["requestTimeoutSeconds"]),
        )
        output = run_direct_agent(
            provider=provider,
            project_root=PROJECT_ROOT,
            prompt=prompt,
            policy=runtime.policy,
            run_dir=run_dir,
            mode=args.mode,
            event_callback=event_logger,
        )
    else:
        raise HarnessConfigError(f"자체 Worker 하네스가 지원하지 않는 Provider입니다: {runtime.provider}")

    print(output)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ApiError as exc:
        raise SystemExit(error_exit(exc.error_class, exc.message, exc.http_status))
    except ToolPolicyError as exc:
        raise SystemExit(error_exit("policy_denial", str(exc)))
    except (HarnessConfigError, AgentProtocolError, ToolExecutionError) as exc:
        raise SystemExit(error_exit("invalid_request", str(exc)))
    except KeyboardInterrupt:
        raise SystemExit(error_exit("timeout", "사용자가 Worker 실행을 중단했습니다."))
