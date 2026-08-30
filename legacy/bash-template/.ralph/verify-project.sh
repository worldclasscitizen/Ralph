#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

LOCAL_CONFIG_PATH="${RALPH_LOCAL_CONFIG:-.antigravity/config.local.json}"
if [[ ! -f "${LOCAL_CONFIG_PATH}" ]]; then
  LOCAL_CONFIG_PATH=".antigravity/config.local.json.example"
fi

json_files=(
  ".antigravity/config.json"
  ".antigravity/config.schema.json"
  ".antigravity/config.local.schema.json"
  "${LOCAL_CONFIG_PATH}"
  ".antigravity/config.local.json.example"
  ".ralph/tests/fallback-config.local.json"
  ".ralph/rubrics/base.json"
  ".ralph/rubrics/planning_architecture.json"
  ".ralph/rubrics/frontend_visual.json"
  ".ralph/rubrics/backend_core.json"
  ".ralph/rubrics/tdd_debugging.json"
  ".ralph/rubrics/static_review.json"
  ".ralph/rubrics/delivery_evidence.json"
  ".ralph/evals/critic/calibration_cases.json"
)

jq empty "${json_files[@]}"

if command -v python3 >/dev/null 2>&1 && python3 -c 'import jsonschema' >/dev/null 2>&1; then
  RALPH_VERIFY_LOCAL_CONFIG="${LOCAL_CONFIG_PATH}" python3 - <<'PY'
import json
import os
from pathlib import Path

from jsonschema import Draft202012Validator

root = Path.cwd()
checks = (
    (".antigravity/config.schema.json", ".antigravity/config.json"),
    (".antigravity/config.local.schema.json", os.environ["RALPH_VERIFY_LOCAL_CONFIG"]),
    (".antigravity/config.local.schema.json", ".antigravity/config.local.json.example"),
    (".antigravity/config.local.schema.json", ".ralph/tests/fallback-config.local.json"),
)
for schema_path, instance_path in checks:
    schema = json.loads((root / schema_path).read_text())
    instance = json.loads((root / instance_path).read_text())
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(instance)
PY
else
  printf 'WARNING: python3 jsonschema가 없어 JSON Schema 검증은 건너뜁니다. jq와 resolver 검증은 계속 실행합니다.\n'
fi

bash_files=(
  ".ralph/ralph-loop.sh"
  ".ralph/resolve-config.sh"
  ".ralph/git-checkpoint.sh"
  ".ralph/observability.sh"
  ".ralph/ralph-dashboard.sh"
  ".ralph/antigravity-agent.sh"
  ".ralph/codex-builtin-agent.sh"
  ".ralph/api-text-agent.sh"
  ".ralph/claude-builtin-agent.sh"
  ".ralph/verify-project.sh"
  ".ralph/commands.local.sh.example"
  ".ralph/test-fallback-router.sh"
  ".ralph/test-git-checkpoints.sh"
  ".ralph/test-antigravity-sessions.sh"
  ".ralph/test-antigravity-agent.sh"
  ".ralph/tests/fallback-commands.sh"
)
if [[ -f ".ralph/commands.local.sh" ]]; then
  bash_files+=(".ralph/commands.local.sh")
fi
bash -n "${bash_files[@]}"
if rg -F -q -- '--header "Authorization:' .ralph/api-text-agent.sh; then
  printf 'ERROR: API 인증 헤더를 프로세스 argv에 직접 넣지 마세요.\n' >&2
  exit 1
fi
rg -F -q -- '--header "@${AUTH_HEADER_FILE}"' .ralph/api-text-agent.sh
rg -F -q -- '--connect-timeout' .ralph/api-text-agent.sh
rg -F -q -- '--max-time' .ralph/api-text-agent.sh
python3 -m py_compile .ralph/tool-agent.py .ralph/record-usage.py .ralph/critic_engine.py .ralph/critic_calibration.py .ralph/tool_harness/*.py .ralph/dashboard/server.py .ralph/tests/test_tool_harness.py .ralph/tests/test_dashboard.py .ralph/tests/test_critic_engine.py
python3 .ralph/critic_calibration.py --threshold 85 --margin 5 >/dev/null
python3 -m unittest discover -s .ralph/tests -p 'test_*.py'
RALPH_LOCAL_CONFIG="${LOCAL_CONFIG_PATH}" .ralph/resolve-config.sh --check >/dev/null
.ralph/test-fallback-router.sh
.ralph/test-git-checkpoints.sh
.ralph/test-antigravity-sessions.sh
.ralph/test-antigravity-agent.sh
git diff --check

if [[ ! -f package.json ]]; then
  printf 'OK: 설정·JSON·Bash 검증 통과. 아직 package.json이 없어 앱 테스트는 건너뜁니다.\n'
  exit 0
fi

if [[ -f pnpm-lock.yaml ]] && command -v pnpm >/dev/null 2>&1; then
  package_runner=(pnpm run)
elif [[ -f yarn.lock ]] && command -v yarn >/dev/null 2>&1; then
  package_runner=(yarn run)
elif [[ -f bun.lockb || -f bun.lock ]] && command -v bun >/dev/null 2>&1; then
  package_runner=(bun run)
else
  package_runner=(npm run)
fi

scripts_run=0
for script_name in test lint typecheck build; do
  if jq -e --arg name "${script_name}" '.scripts[$name] != null' package.json >/dev/null; then
    "${package_runner[@]}" "${script_name}"
    scripts_run=$((scripts_run + 1))
  fi
done

if [[ "${scripts_run}" -eq 0 ]]; then
  printf 'WARNING: package.json에 test/lint/typecheck/build 스크립트가 없습니다.\n'
else
  printf 'OK: %s개의 프로젝트 검증 스크립트가 통과했습니다.\n' "${scripts_run}"
fi
