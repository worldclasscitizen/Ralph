#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ "${1:-}" == "--fake-agent" ]]; then
  role="${2:-}"
  model_alias="${3:-}"
  cat >/dev/null
  case "${role}:${model_alias}" in
    critic:gemini-flash|metaPrompter:deepseek-pro|worker:openai-sol)
      if [[ "${RALPH_TEST_SCENARIO:-rate_limit}" == "empty_response" && "${role}:${model_alias}" == "critic:gemini-flash" ]]; then
        printf '%s\n' 'RALPH_AGENT_ERROR {"class":"empty_response","source":"antigravity"}' >&2
        exit 74
      elif [[ "${RALPH_TEST_SCENARIO:-rate_limit}" == "authentication" && "${role}:${model_alias}" == "critic:gemini-flash" ]]; then
        printf 'HTTP 401 authentication failed\n' >&2
        exit 64
      elif [[ "${RALPH_TEST_SCENARIO:-rate_limit}" == "quota_reached" && "${role}:${model_alias}" == "critic:gemini-flash" ]]; then
        printf 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 165h16m5s.\n' >&2
        exit 1
      else
        if [[ "${role}:${model_alias}" == "metaPrompter:deepseek-pro" ]]; then
          printf '%s\n' 'RALPH_AGENT_ERROR {"class":"rate_limit","httpStatus":429}' >&2
        else
          printf 'HTTP 429 rate limit reached\n' >&2
        fi
        exit 75
      fi
      ;;
    critic:openai-sol)
      printf '%s\n' '{"criteria":[{"id":"contract_evidence","level":"complete","evidence":["smoke"],"reason":"고정 테스트 증거입니다."},{"id":"deterministic_verification","level":"complete","evidence":["smoke"],"reason":"고정 테스트 증거입니다."},{"id":"regression_scope_safety","level":"complete","evidence":["smoke"],"reason":"고정 테스트 증거입니다."},{"id":"reproducibility","level":"complete","evidence":["smoke"],"reason":"고정 테스트 증거입니다."},{"id":"api_contract_correctness","level":"complete","evidence":["smoke"],"reason":"고정 테스트 증거입니다."},{"id":"data_business_integrity","level":"complete","evidence":["smoke"],"reason":"고정 테스트 증거입니다."},{"id":"error_security_handling","level":"complete","evidence":["smoke"],"reason":"고정 테스트 증거입니다."},{"id":"integration_evidence","level":"complete","evidence":["smoke"],"reason":"고정 테스트 증거입니다."}],"hardGates":[{"id":"worker_execution_failed","status":"pass","evidence":["smoke"],"reason":"고정 테스트 판정입니다."},{"id":"deterministic_verifier_failed","status":"pass","evidence":["smoke"],"reason":"고정 테스트 판정입니다."},{"id":"secret_or_user_data_exposure","status":"pass","evidence":["smoke"],"reason":"고정 테스트 판정입니다."},{"id":"core_placeholder_claimed_complete","status":"pass","evidence":["smoke"],"reason":"고정 테스트 판정입니다."},{"id":"tests_weakened","status":"pass","evidence":["smoke"],"reason":"고정 테스트 판정입니다."},{"id":"destructive_out_of_scope_change","status":"pass","evidence":["smoke"],"reason":"고정 테스트 판정입니다."},{"id":"core_contract_broken","status":"pass","evidence":["smoke"],"reason":"고정 테스트 판정입니다."}],"findings":[],"risks":[],"lesson":"test only"}'
      ;;
    metaPrompter:openai-sol)
      printf '%s\n' \
        '# Ralph Smoke Prompt' \
        '' \
        '## 목표' \
        '외부 모델 호출 없이 fallback router의 Meta-Prompter 대체 경로를 검증한다.' \
        '' \
        '## 허용 범위' \
        '임시 테스트 디렉터리와 가짜 출력만 사용하며 프로젝트 파일과 외부 상태를 수정하지 않는다.' \
        '' \
        '## 완료 조건' \
        '기본 모델의 429 오류 이후 보조 모델 출력이 선택되고 모든 이벤트가 JSONL 증거로 남아야 한다.'
      ;;
    worker:openai-terra)
      printf '%s\n' 'RALPH_WORKER_SMOKE_OK'
      ;;
    *)
      printf 'unexpected fake route: %s:%s\n' "${role}" "${model_alias}" >&2
      exit 64
      ;;
  esac
  exit 0
fi

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ralph-fallback-test.XXXXXX")"
cleanup() {
  rm -rf "${TEMP_ROOT}"
}
trap cleanup EXIT INT TERM

mkdir -p "${TEMP_ROOT}/runs"
: > "${TEMP_ROOT}/progress.txt"

RALPH_LOCAL_CONFIG="${SCRIPT_DIR}/tests/fallback-config.local.json" \
RALPH_COMMANDS_FILE="${SCRIPT_DIR}/tests/fallback-commands.sh" \
RALPH_RUNS_DIR="${TEMP_ROOT}/runs" \
RALPH_STATE_FILE="${TEMP_ROOT}/state.json" \
RALPH_LOCK_DIR="${TEMP_ROOT}/lock" \
RALPH_PROGRESS_FILE="${TEMP_ROOT}/progress.txt" \
RALPH_FALLBACK_DISABLE_SLEEP=1 \
  "${SCRIPT_DIR}/ralph-loop.sh" --smoke --task backend_core > "${TEMP_ROOT}/stdout.log" 2> "${TEMP_ROOT}/stderr.log"

EVENTS_FILE="$(find "${TEMP_ROOT}/runs" -name fallback-events.jsonl -type f -print -quit)"
if [[ -z "${EVENTS_FILE}" || ! -s "${EVENTS_FILE}" ]]; then
  printf 'ERROR: fallback event log가 생성되지 않았습니다.\n' >&2
  exit 1
fi

OBSERVABILITY_EVENTS_FILE="$(find "${TEMP_ROOT}/runs" -name events.jsonl -type f -print -quit)"
RUN_METADATA_FILE="$(find "${TEMP_ROOT}/runs" -name run.json -type f -print -quit)"
if [[ -z "${OBSERVABILITY_EVENTS_FILE}" || ! -s "${OBSERVABILITY_EVENTS_FILE}" || -z "${RUN_METADATA_FILE}" ]]; then
  printf 'ERROR: Control Center 관찰 이벤트 또는 run metadata가 생성되지 않았습니다.\n' >&2
  exit 1
fi
jq -e '.task == "backend_core" and .maxIterations >= 1' "${RUN_METADATA_FILE}" >/dev/null
jq -s -e '
  any(.[]; .type == "run_created") and
  any(.[]; .type == "model_attempt_started" and .role == "critic") and
  any(.[]; .type == "fallback" and .status == "fallback_next_model") and
  any(.[]; .type == "run_completed" and .status == "passed")
' "${OBSERVABILITY_EVENTS_FILE}" >/dev/null

CANONICAL_INPUT="$(find "${TEMP_ROOT}/runs" -name '*.attempt-1.input.md' -type f -print -quit)"
if [[ -z "${CANONICAL_INPUT}" ]]; then
  printf 'ERROR: 모델 호출에 전달된 canonical input 증거가 없습니다.\n' >&2
  exit 1
fi
grep -F '# Ralph canonical state contract' "${CANONICAL_INPUT}" >/dev/null
grep -F "Project root (absolute): ${PROJECT_ROOT}" "${CANONICAL_INPUT}" >/dev/null
grep -F 'If prior session memory conflicts with current evidence, ignore the memory' \
  "${CANONICAL_INPUT}" >/dev/null

jq -s -e '
  any(.[]; .role == "critic" and .modelAlias == "gemini-flash" and .action == "fallback_next_model") and
  any(.[]; .role == "critic" and .modelAlias == "openai-sol" and .action == "success") and
  any(.[]; .role == "metaPrompter" and .modelAlias == "deepseek-pro" and .action == "fallback_next_model") and
  any(.[]; .role == "metaPrompter" and .modelAlias == "openai-sol" and .action == "success") and
  any(.[]; .role == "worker" and .modelAlias == "openai-sol" and .action == "fallback_next_model") and
  any(.[]; .role == "worker" and .modelAlias == "glm-5-3" and .action == "skip_unavailable") and
  any(.[]; .role == "worker" and .modelAlias == "deepseek-pro" and .action == "skip_degraded") and
  any(.[]; .role == "worker" and .modelAlias == "openai-terra" and .action == "success")
' "${EVENTS_FILE}" >/dev/null

FAILURES_FILE="$(find "${TEMP_ROOT}/runs" -name failures.jsonl -type f -print -quit)"
if [[ -z "${FAILURES_FILE}" || ! -s "${FAILURES_FILE}" ]]; then
  printf 'ERROR: 중간 실패 원인 JSONL이 생성되지 않았습니다.\n' >&2
  exit 1
fi
jq -s -e '
  any(.[]; .stage == "Smoke Critic" and .failureClass == "rate_limit" and (.action | contains("다음 실행 가능 모델"))) and
  any(.[]; .stage == "Smoke Meta-Prompter" and .failureClass == "rate_limit") and
  any(.[]; .stage == "Smoke Worker" and .failureClass == "rate_limit")
' "${FAILURES_FILE}" >/dev/null
grep -F '[status=failed] 원인: rate_limit:' "${TEMP_ROOT}/progress.txt" >/dev/null
grep -F '대응: fallback chain의 다음 실행 가능 모델로 전환' "${TEMP_ROOT}/progress.txt" >/dev/null

mkdir -p "${TEMP_ROOT}/runs-auth"
set +e
RALPH_TEST_SCENARIO=authentication \
RALPH_LOCAL_CONFIG="${SCRIPT_DIR}/tests/fallback-config.local.json" \
RALPH_COMMANDS_FILE="${SCRIPT_DIR}/tests/fallback-commands.sh" \
RALPH_RUNS_DIR="${TEMP_ROOT}/runs-auth" \
RALPH_STATE_FILE="${TEMP_ROOT}/state-auth.json" \
RALPH_LOCK_DIR="${TEMP_ROOT}/lock-auth" \
RALPH_FALLBACK_DISABLE_SLEEP=1 \
  "${SCRIPT_DIR}/ralph-loop.sh" --smoke --task backend_core > "${TEMP_ROOT}/stdout-auth.log" 2> "${TEMP_ROOT}/stderr-auth.log"
auth_rc=$?
set -e

if [[ "${auth_rc}" -eq 0 ]]; then
  printf 'ERROR: 인증 오류가 fallback으로 우회되었습니다.\n' >&2
  exit 1
fi

AUTH_EVENTS_FILE="$(find "${TEMP_ROOT}/runs-auth" -name fallback-events.jsonl -type f -print -quit)"
jq -s -e '
  any(.[]; .role == "critic" and .modelAlias == "gemini-flash" and .errorClass == "authentication" and .action == "stop_non_retryable") and
  (any(.[]; .role == "critic" and .modelAlias == "openai-sol" and .action == "success") | not)
' "${AUTH_EVENTS_FILE}" >/dev/null

mkdir -p "${TEMP_ROOT}/runs-quota"
RALPH_TEST_SCENARIO=quota_reached \
RALPH_LOCAL_CONFIG="${SCRIPT_DIR}/tests/fallback-config.local.json" \
RALPH_COMMANDS_FILE="${SCRIPT_DIR}/tests/fallback-commands.sh" \
RALPH_RUNS_DIR="${TEMP_ROOT}/runs-quota" \
RALPH_STATE_FILE="${TEMP_ROOT}/state-quota.json" \
RALPH_LOCK_DIR="${TEMP_ROOT}/lock-quota" \
RALPH_FALLBACK_DISABLE_SLEEP=1 \
  "${SCRIPT_DIR}/ralph-loop.sh" --smoke --task backend_core > "${TEMP_ROOT}/stdout-quota.log" 2> "${TEMP_ROOT}/stderr-quota.log"

QUOTA_EVENTS_FILE="$(find "${TEMP_ROOT}/runs-quota" -name fallback-events.jsonl -type f -print -quit)"
jq -s -e '
  any(.[]; .role == "critic" and .modelAlias == "gemini-flash" and .errorClass == "rate_limit" and .action == "fallback_next_model") and
  any(.[]; .role == "critic" and .modelAlias == "openai-sol" and .action == "success")
' "${QUOTA_EVENTS_FILE}" >/dev/null

mkdir -p "${TEMP_ROOT}/runs-empty"
RALPH_TEST_SCENARIO=empty_response \
RALPH_LOCAL_CONFIG="${SCRIPT_DIR}/tests/fallback-config.local.json" \
RALPH_COMMANDS_FILE="${SCRIPT_DIR}/tests/fallback-commands.sh" \
RALPH_RUNS_DIR="${TEMP_ROOT}/runs-empty" \
RALPH_STATE_FILE="${TEMP_ROOT}/state-empty.json" \
RALPH_LOCK_DIR="${TEMP_ROOT}/lock-empty" \
RALPH_FALLBACK_DISABLE_SLEEP=1 \
  "${SCRIPT_DIR}/ralph-loop.sh" --smoke --task backend_core > "${TEMP_ROOT}/stdout-empty.log" 2> "${TEMP_ROOT}/stderr-empty.log"

EMPTY_EVENTS_FILE="$(find "${TEMP_ROOT}/runs-empty" -name fallback-events.jsonl -type f -print -quit)"
jq -s -e '
  any(.[]; .role == "critic" and .modelAlias == "gemini-flash" and .errorClass == "empty_response" and .action == "fallback_next_model") and
  any(.[]; .role == "critic" and .modelAlias == "openai-sol" and .action == "success")
' "${EMPTY_EVENTS_FILE}" >/dev/null

printf 'OK: 429·quota·빈 응답 자동 전환과 인증 오류 비우회를 모두 검증했습니다.\n'
