#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from tool_harness.usage import record_usage


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        return 0
    if not isinstance(payload, dict):
        return 0
    run_dir_value = payload.get("runDirectory") or os.environ.get("RALPH_RUN_DIR")
    if not run_dir_value:
        return 0
    try:
        record_usage(Path(str(run_dir_value)), payload)
    except (OSError, TypeError, ValueError):
        # 사용량 계측은 Ralph의 모델 결과나 종료 코드에 영향을 주지 않는다.
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
