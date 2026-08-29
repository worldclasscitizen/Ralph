#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TEAM_CONFIG="${RALPH_TEAM_CONFIG:-${PROJECT_ROOT}/.antigravity/config.json}"
LOCAL_CONFIG="${RALPH_LOCAL_CONFIG:-${PROJECT_ROOT}/.antigravity/config.local.json}"
CONFIG_RESOLVER="${SCRIPT_DIR}/resolve-config.sh"
GIT_CHECKPOINT="${SCRIPT_DIR}/git-checkpoint.sh"
OBSERVABILITY_LIB="${SCRIPT_DIR}/observability.sh"
PROMPT_FILE="${SCRIPT_DIR}/PROMPT.md"
META_PROMPT_FILE="${SCRIPT_DIR}/META_PROMPT.md"
RUBRIC_FILE="${SCRIPT_DIR}/CRITIC_RUBRIC.md"
BASE_RUBRIC_FILE="${SCRIPT_DIR}/rubrics/base.json"
CRITIC_ENGINE="${SCRIPT_DIR}/critic_engine.py"
GUARDRAILS_FILE="${SCRIPT_DIR}/guardrails.md"
PROGRESS_FILE="${RALPH_PROGRESS_FILE:-${SCRIPT_DIR}/progress.txt}"
COMMANDS_FILE="${RALPH_COMMANDS_FILE:-${SCRIPT_DIR}/commands.local.sh}"
OPERATOR_NOTE_FILE="${SCRIPT_DIR}/OPERATOR_NOTE.local.md"
RUNS_DIR="${RALPH_RUNS_DIR:-${SCRIPT_DIR}/runs}"
STATE_FILE="${RALPH_STATE_FILE:-${SCRIPT_DIR}/state.json}"
LOCK_DIR="${RALPH_LOCK_DIR:-${SCRIPT_DIR}/.lock}"

if [[ -r "${OBSERVABILITY_LIB}" ]]; then
  # shellcheck source=/dev/null
  source "${OBSERVABILITY_LIB}"
else
  ralph_observe_init() { return 0; }
  ralph_observe_event() { return 0; }
  ralph_observe_run_metadata() { return 0; }
fi

MODE="run"
TASK_ID=""

usage() {
  printf '%s\n' \
    'Usage: .ralph/ralph-loop.sh [--check|--smoke|--explain] [--task TASK_ID]' \
    '' \
    '  --check       파일, JSON, 명령 설정만 검사하고 실행하지 않는다.' \
    '  --smoke       Critic/Meta/Worker(읽기 전용)/Verifier를 실제로 한 번 호출한다.' \
    '  --explain     루프 단계와 현재 task route를 출력한다.' \
    '  --task ID     config.local.json의 6대 taskPipelines 중 하나를 선택한다.' \
    '  --help        이 도움말을 출력한다.'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      MODE="check"
      shift
      ;;
    --smoke)
      MODE="smoke"
      shift
      ;;
    --explain)
      MODE="explain"
      shift
      ;;
    --task)
      if [[ $# -lt 2 ]]; then
        printf 'ERROR: --task 뒤에 task ID가 필요합니다.\n' >&2
        exit 2
      fi
      TASK_ID="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'ERROR: 알 수 없는 인자: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  printf 'ERROR: jq가 필요합니다. 설치 후 다시 실행하세요.\n' >&2
  exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
  printf 'ERROR: 작업별 Critic 채점 엔진을 실행하려면 Python 3가 필요합니다.\n' >&2
  exit 2
fi

required_files=(
  "${TEAM_CONFIG}"
  "${LOCAL_CONFIG}"
  "${CONFIG_RESOLVER}"
  "${GIT_CHECKPOINT}"
  "${PROMPT_FILE}"
  "${META_PROMPT_FILE}"
  "${RUBRIC_FILE}"
  "${BASE_RUBRIC_FILE}"
  "${CRITIC_ENGINE}"
  "${GUARDRAILS_FILE}"
  "${PROGRESS_FILE}"
)
for required_file in "${required_files[@]}"; do
  if [[ ! -f "${required_file}" ]]; then
    printf 'ERROR: 필수 파일이 없습니다: %s\n' "${required_file}" >&2
    exit 2
  fi
done

if ! "${CONFIG_RESOLVER}" --check >/dev/null; then
  printf 'ERROR: 공용 규격과 개인 설정 검증에 실패했습니다. resolve-config.sh --check 결과를 확인하세요.\n' >&2
  exit 2
fi

if [[ -f "${COMMANDS_FILE}" ]]; then
  # 이 파일은 사용자가 직접 관리하는 신뢰된 로컬 셸 설정이다.
  # shellcheck source=/dev/null
  source "${COMMANDS_FILE}"
fi

RALPH_CONFIG_JSON="$("${CONFIG_RESOLVER}" --ralph)"
RESOLVED_CONFIG_JSON="$("${CONFIG_RESOLVER}" --resolved)"
TASK_ID="${TASK_ID:-${RALPH_TASK:-$(jq -r '.defaults.task' <<<"${RALPH_CONFIG_JSON}")}}"

if ! ROUTE_JSON="$("${CONFIG_RESOLVER}" --task "${TASK_ID}")"; then
  exit 2
fi

if [[ -z "${ROUTE_JSON}" ]]; then
  printf 'ERROR: 개인 설정에 task pipeline이 없습니다: %s\n' "${TASK_ID}" >&2
  exit 2
fi

TASK_RUBRIC_FILE="${SCRIPT_DIR}/rubrics/${TASK_ID}.json"
if [[ ! -f "${TASK_RUBRIC_FILE}" ]]; then
  printf 'ERROR: 작업별 Critic rubric이 없습니다: %s\n' "${TASK_RUBRIC_FILE}" >&2
  exit 2
fi

RALPH_VERIFY_CMD="${RALPH_VERIFY_CMD:-}"
MAX_ITERATIONS="${RALPH_MAX_ITERATIONS:-$(jq -r '.defaults.maxIterations' <<<"${RALPH_CONFIG_JSON}")}"
MIN_CRITIC_SCORE="${RALPH_MIN_CRITIC_SCORE:-$(jq -r '.defaults.minimumCriticScore' <<<"${RALPH_CONFIG_JSON}")}"
MAX_ATTEMPTS_PER_MODEL="${RALPH_MAX_ATTEMPTS_PER_MODEL:-$(jq -r '.routingPolicy.maxAttemptsPerModel' <<<"${RESOLVED_CONFIG_JSON}")}"
INITIAL_BACKOFF_SECONDS="${RALPH_INITIAL_BACKOFF_SECONDS:-$(jq -r '.routingPolicy.initialBackoffSeconds' <<<"${RESOLVED_CONFIG_JSON}")}"
MAX_BACKOFF_SECONDS="${RALPH_MAX_BACKOFF_SECONDS:-$(jq -r '.routingPolicy.maxBackoffSeconds' <<<"${RESOLVED_CONFIG_JSON}")}"
RETRYABLE_ERROR_LABELS="$(jq -r '.routingPolicy.retryableErrors | join("|")' <<<"${RESOLVED_CONFIG_JSON}")"
GIT_CHECKPOINT_PREFIX="$(jq -r '.gitCheckpointPolicy.commitMessagePrefix' <<<"${RESOLVED_CONFIG_JSON}")"
SESSION_MODE="$(jq -r '.sessionPolicy.mode' <<<"${RESOLVED_CONFIG_JSON}")"
SESSION_MAX_TURNS="$(jq -r '.sessionPolicy.maxTurnsPerSession' <<<"${RESOLVED_CONFIG_JSON}")"
SESSION_PERSISTENT_ROLES="$(jq -r '.sessionPolicy.persistentRoles | join("|")' <<<"${RESOLVED_CONFIG_JSON}")"
ADJUDICATION_MARGIN="${RALPH_ADJUDICATION_MARGIN:-5}"

if ! [[ "${MAX_ITERATIONS}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'ERROR: RALPH_MAX_ITERATIONS는 양의 정수여야 합니다.\n' >&2
  exit 2
fi

if ! [[ "${MIN_CRITIC_SCORE}" =~ ^([0-9]|[1-9][0-9]|100)$ ]]; then
  printf 'ERROR: RALPH_MIN_CRITIC_SCORE는 0..100 정수여야 합니다.\n' >&2
  exit 2
fi

if ! [[ "${MAX_ATTEMPTS_PER_MODEL}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'ERROR: maxAttemptsPerModel은 양의 정수여야 합니다.\n' >&2
  exit 2
fi

if ! [[ "${INITIAL_BACKOFF_SECONDS}" =~ ^[0-9]+$ && "${MAX_BACKOFF_SECONDS}" =~ ^[0-9]+$ ]]; then
  printf 'ERROR: fallback backoff 값은 0 이상의 정수여야 합니다.\n' >&2
  exit 2
fi

if ! [[ "${ADJUDICATION_MARGIN}" =~ ^[0-9]+$ && "${ADJUDICATION_MARGIN}" -le 20 ]]; then
  printf 'ERROR: RALPH_ADJUDICATION_MARGIN은 0..20 정수여야 합니다.\n' >&2
  exit 2
fi

if ! python3 "${CRITIC_ENGINE}" check-rubric \
  --base "${BASE_RUBRIC_FILE}" --task-rubric "${TASK_RUBRIC_FILE}" >/dev/null; then
  printf 'ERROR: 공통·작업별 Critic rubric 검증에 실패했습니다.\n' >&2
  exit 2
fi

if ! declare -f ralph_command_for >/dev/null 2>&1; then
  printf 'ERROR: commands.local.sh에 ralph_command_for 함수가 없습니다.\n' >&2
  exit 2
fi

if [[ -z "${RALPH_VERIFY_CMD}" || "${RALPH_VERIFY_CMD}" == *YOUR_* ]]; then
  printf 'ERROR: RALPH_VERIFY_CMD가 설정되지 않았습니다. commands.local.sh를 확인하세요.\n' >&2
  exit 2
fi

aliases_for_role() {
  local role="$1"
  case "${role}" in
    critic)
      jq -r '.fallbackChains.critic[]' <<<"${RALPH_CONFIG_JSON}"
      ;;
    metaPrompter)
      jq -r '.fallbackChains.metaPrompter[]' <<<"${RALPH_CONFIG_JSON}"
      ;;
    worker)
      jq -r '.models[].alias' <<<"${ROUTE_JSON}"
      ;;
    *)
      return 2
      ;;
  esac
}

command_for_model() {
  local role="$1"
  local model_alias="$2"
  local execution_mode="${3:-run}"
  local command_string
  if ! command_string="$(ralph_command_for "${role}" "${model_alias}" "${execution_mode}")"; then
    return 1
  fi
  if [[ -z "${command_string}" || "${command_string}" == *YOUR_* ]]; then
    return 1
  fi
  printf '%s\n' "${command_string}"
}

describe_role_route() {
  local role="$1"
  local execution_mode="${2:-run}"
  local model_alias
  local available=""
  local unavailable=""
  local available_separator=""
  local unavailable_separator=""
  while IFS= read -r model_alias; do
    [[ -n "${model_alias}" ]] || continue
    if command_for_model "${role}" "${model_alias}" "${execution_mode}" >/dev/null; then
      available="${available}${available_separator}${model_alias}"
      available_separator=' -> '
    else
      unavailable="${unavailable}${unavailable_separator}${model_alias}"
      unavailable_separator=' -> '
    fi
  done < <(aliases_for_role "${role}")
  printf '%s executable: %s\n' "${role}" "${available:-none}"
  if [[ -n "${unavailable}" ]]; then
    printf '%s skipped(no command): %s\n' "${role}" "${unavailable}"
  fi
}

check_role_route() {
  local role="$1"
  local execution_mode="${2:-run}"
  local model_alias
  local available_count=0
  while IFS= read -r model_alias; do
    [[ -n "${model_alias}" ]] || continue
    if command_for_model "${role}" "${model_alias}" "${execution_mode}" >/dev/null; then
      available_count=$((available_count + 1))
    fi
  done < <(aliases_for_role "${role}")
  if [[ "${available_count}" -eq 0 ]]; then
    printf 'ERROR: %s 역할에 실행 가능한 모델 명령이 하나도 없습니다.\n' "${role}" >&2
    return 1
  fi
}

command_settings_ok=true
check_role_route critic run || command_settings_ok=false
check_role_route metaPrompter run || command_settings_ok=false
check_role_route worker run || command_settings_ok=false
if [[ "${MODE}" == "smoke" ]]; then
  check_role_route worker smoke || command_settings_ok=false
fi

if [[ "${command_settings_ok}" != true ]]; then
  exit 2
fi

if [[ "${MODE}" == "explain" ]]; then
  printf 'Task: %s\n' "${TASK_ID}"
  printf 'Configured route: %s\n' "${ROUTE_JSON}"
  describe_role_route critic run
  describe_role_route metaPrompter run
  describe_role_route worker run
  printf 'Retry policy: attempts/model=%s, backoff=%ss..%ss, retryable=%s\n' \
    "${MAX_ATTEMPTS_PER_MODEL}" "${INITIAL_BACKOFF_SECONDS}" "${MAX_BACKOFF_SECONDS}" "${RETRYABLE_ERROR_LABELS}"
  printf 'Session policy: %s, persistent=%s, critic=stateless, scope=run+task+node+model, max turns=%s\n' \
    "${SESSION_MODE}" "${SESSION_PERSISTENT_ROLES}" "${SESSION_MAX_TURNS}"
  printf '%s\n' \
    '1. Pre-Critic이 현재 PROMPT, 저장소 상태, 이전 검증 로그를 작업별 rubric으로 평가' \
    '2. Meta-Prompter가 실패 원인을 반영해 PROMPT.md 전체를 재작성' \
    '3. Worker가 진화된 PROMPT와 guardrails를 받아 구현' \
    '4. 각 역할에서 Rate Limit·timeout·5xx 발생 시 재시도 후 다음 실행 가능 모델로 전환' \
    '5. 사용자가 지정한 결정적 테스트/린트/타입 검사 실행' \
    '6. Post-Critic은 항목별 증거 수준만 반환하고 로컬 채점 엔진이 pass/retry/needs_operator를 결정' \
    '7. 통과선 ±경계 구간에서만 Worker와 다른 두 번째 Critic이 재심' \
    '8. 교훈을 guardrails.md에 누적하고 반복 정체 시 사용자 확인 상태로 중단' \
    '9. 이터레이션 전체 변경을 로컬 Git checkpoint로 강제 커밋하고 통과하지 못하면 다음 반복'
  exit 0
fi

if [[ "${MODE}" == "check" ]]; then
  printf 'OK: Ralph 설정과 런타임 fallback 명령이 유효합니다.\n'
  printf 'Task: %s\n' "${TASK_ID}"
  describe_role_route critic run
  describe_role_route metaPrompter run
  describe_role_route worker run
  printf 'Max iterations: %s, minimum critic score: %s\n' "${MAX_ITERATIONS}" "${MIN_CRITIC_SCORE}"
  printf 'Critic rubric: base + %s, boundary adjudication: ±%s points\n' "${TASK_ID}" "${ADJUDICATION_MARGIN}"
  printf 'Attempts/model: %s, backoff: %ss..%ss\n' \
    "${MAX_ATTEMPTS_PER_MODEL}" "${INITIAL_BACKOFF_SECONDS}" "${MAX_BACKOFF_SECONDS}"
  printf 'Git checkpoint: clean worktree required, every iteration committed, auto-push disabled\n'
  printf 'Session policy: %s, persistent=%s, critic=stateless, max turns=%s\n' \
    "${SESSION_MODE}" "${SESSION_PERSISTENT_ROLES}" "${SESSION_MAX_TURNS}"
  exit 0
fi

mkdir -p "${RUNS_DIR}"
if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  printf 'ERROR: 다른 Ralph Loop가 실행 중이거나 이전 lock이 남아 있습니다: %s\n' "${LOCK_DIR}" >&2
  exit 3
fi

cleanup() {
  rmdir "${LOCK_DIR}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

RUN_ID="$(date '+%Y%m%d-%H%M%S')-$$"
RUN_DIR="${RUNS_DIR}/${RUN_ID}"
mkdir -p "${RUN_DIR}"
FALLBACK_EVENTS_FILE="${RUN_DIR}/fallback-events.jsonl"
FAILURES_FILE="${RUN_DIR}/failures.jsonl"
OBSERVABILITY_EVENTS_FILE="${RUN_DIR}/events.jsonl"
RUN_METADATA_FILE="${RUN_DIR}/run.json"
DEGRADED_MODELS_FILE="${RUN_DIR}/degraded-models.txt"
ASSESSMENT_HISTORY_FILE="${RUN_DIR}/assessment-history.jsonl"
: > "${FALLBACK_EVENTS_FILE}"
: > "${FAILURES_FILE}"
: > "${OBSERVABILITY_EVENTS_FILE}"
: > "${DEGRADED_MODELS_FILE}"
: > "${ASSESSMENT_HISTORY_FILE}"
ralph_observe_init \
  "${OBSERVABILITY_EVENTS_FILE}" "${RUN_METADATA_FILE}" "${RUN_ID}" "${TASK_ID}" "${PROJECT_ROOT}"
ralph_observe_run_metadata \
  "${MAX_ITERATIONS}" "${MIN_CRITIC_SCORE}" '' \
  "$(git -C "${PROJECT_ROOT}" branch --show-current 2>/dev/null || true)" "${ROUTE_JSON}" "${RUN_DIR}"
ralph_observe_event run_created 0 run preparing '' '' 0 'Ralph 실행 디렉터리를 준비했습니다.' 'run.json'

printf '아직 검증을 실행하지 않았습니다.\n' > "${RUN_DIR}/verify-0.log"
LAST_VERIFY_FILE="${RUN_DIR}/verify-0.log"

run_agent_once() {
  local role="$1"
  local stage="$2"
  local model_alias="$3"
  local command_string="$4"
  local input_file="$5"
  local output_file="$6"
  local execution_mode="$7"
  local canonical_input="${output_file}.input.md"
  local session_mode_for_call="${SESSION_MODE}"
  local current_head

  if [[ "${MODE}" == "smoke" ]]; then
    session_mode_for_call='stateless'
  fi
  current_head="$(git -C "${PROJECT_ROOT}" rev-parse HEAD 2>/dev/null || printf 'unborn')"

  {
    printf '%s\n' \
      '# Ralph canonical state contract' \
      "- Project root (absolute): ${PROJECT_ROOT}" \
      "- Task: ${TASK_ID}" \
      "- Node role: ${role}" \
      "- Node stage: ${stage}" \
      "- Model alias: ${model_alias}" \
      "- Current Git HEAD: ${current_head}" \
      '- The repository files, current Git state, deterministic verifier evidence, and the payload below are the source of truth.' \
      '- If prior session memory conflicts with current evidence, ignore the memory and follow the current evidence.' \
      '- Do not create or modify artifacts outside the absolute project root.' \
      '' \
      '# Current Git working tree status'
    git -C "${PROJECT_ROOT}" status --short | sed -n '1,200p'
    printf '\n# Current node payload\n'
    cat "${input_file}"
  } > "${canonical_input}"

  printf '[%s] %s 시작 model=%s\n' "$(date '+%H:%M:%S')" "${stage}" "${model_alias}"
  ralph_observe_event model_attempt_started "${iteration:-0}" "${stage}" running \
    "${role}" "${model_alias}" "${attempt:-0}" "${stage} 모델 호출을 시작했습니다." "$(basename "${output_file}")"
  if (
    cd "${PROJECT_ROOT}"
    RALPH_PROJECT_ROOT="${PROJECT_ROOT}" \
    RALPH_RUN_DIR="${RUN_DIR}" \
    RALPH_TASK_ID="${TASK_ID}" \
    RALPH_ITERATION="${iteration:-0}" \
    RALPH_ROLE="${role}" \
    RALPH_STAGE="${stage}" \
    RALPH_MODEL_ALIAS="${model_alias}" \
    RALPH_ATTEMPT="${attempt:-1}" \
    RALPH_EXECUTION_MODE="${execution_mode}" \
    RALPH_SESSION_MODE="${session_mode_for_call}" \
    RALPH_SESSION_MAX_TURNS="${SESSION_MAX_TURNS}" \
    RALPH_SESSION_PERSISTENT_ROLES="${SESSION_PERSISTENT_ROLES}" \
      bash -lc "${command_string}"
  ) < "${canonical_input}" > "${output_file}" 2> "${output_file}.stderr"; then
    ralph_observe_event model_attempt_completed "${iteration:-0}" "${stage}" completed \
      "${role}" "${model_alias}" "${attempt:-0}" "${stage} 모델 호출이 완료됐습니다." "$(basename "${output_file}")"
    return 0
  else
    local command_rc=$?
    ralph_observe_event model_attempt_failed "${iteration:-0}" "${stage}" failed \
      "${role}" "${model_alias}" "${attempt:-0}" "${stage} 모델 호출이 종료 코드 ${command_rc}로 실패했습니다." "$(basename "${output_file}.stderr")"
    return "${command_rc}"
  fi
}

classify_agent_error() {
  local exit_code="$1"
  local stdout_file="$2"
  local stderr_file="$3"
  local combined_file
  local structured_error
  combined_file="$(mktemp "${TMPDIR:-/tmp}/ralph-error.XXXXXX")"
  {
    sed -n '1,120p' "${stderr_file}" 2>/dev/null || true
    sed -n '1,40p' "${stdout_file}" 2>/dev/null || true
  } > "${combined_file}"

  structured_error="$(grep -E '^RALPH_AGENT_ERROR \{' "${combined_file}" | tail -n 1 | sed 's/^RALPH_AGENT_ERROR //' || true)"
  if [[ -n "${structured_error}" ]] && jq -e '.class | type == "string"' <<<"${structured_error}" >/dev/null 2>&1; then
    jq -r '.class' <<<"${structured_error}"
    rm -f "${combined_file}"
    return 0
  fi

  if grep -Eiq '(^|[^0-9])429([^0-9]|$)|rate[ _-]?limit|resource exhausted|quota|too many requests' "${combined_file}"; then
    printf '%s\n' 'rate_limit'
  elif [[ "${exit_code}" -eq 28 || "${exit_code}" -eq 124 ]] || \
       grep -Eiq 'timed? out|timeout|deadline exceeded|request time-out' "${combined_file}"; then
    printf '%s\n' 'timeout'
  elif grep -Eiq '(^|[^0-9])5(00|02|03|04)([^0-9]|$)|server error|service unavailable|temporarily unavailable|bad gateway|overloaded|internal error' "${combined_file}"; then
    printf '%s\n' 'server_error'
  elif grep -Eiq '(^|[^0-9])(401|403)([^0-9]|$)|unauthori[sz]ed|forbidden|invalid api key|authentication|credential' "${combined_file}"; then
    printf '%s\n' 'authentication'
  elif grep -Eiq '(^|[^0-9])400([^0-9]|$)|invalid request|invalid argument|schema' "${combined_file}"; then
    printf '%s\n' 'invalid_request'
  elif grep -Eiq 'policy denial|policy_denial|safety policy|content policy|permission denied' "${combined_file}"; then
    printf '%s\n' 'policy_denial'
  else
    printf '%s\n' 'unknown'
  fi
  rm -f "${combined_file}"
}

is_retryable_error() {
  jq -e --arg error_class "$1" \
    '.routingPolicy.retryableErrors | index($error_class) != null' \
    <<<"${RESOLVED_CONFIG_JSON}" >/dev/null
}

progress_recording_enabled() {
  [[ "${MODE}" == "run" || -n "${RALPH_PROGRESS_FILE:-}" ]]
}

single_line() {
  tr '\n\r\t' '   ' | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//'
}

append_progress() {
  local stage="$1"
  local status="$2"
  local cause="$3"
  local action="$4"
  local artifact="${5:-}"
  local safe_cause
  local safe_action

  progress_recording_enabled || return 0
  safe_cause="$(printf '%s' "${cause}" | single_line)"
  safe_action="$(printf '%s' "${action}" | single_line)"
  printf '%s\n' \
    "- [$(date -u '+%Y-%m-%dT%H:%M:%SZ')][run=${RUN_ID}][task=${TASK_ID}][iteration=${iteration:-0}][stage=${stage}][status=${status}] 원인: ${safe_cause:-없음} | 대응: ${safe_action:-없음} | 증거: ${artifact:-없음}" \
    >> "${PROGRESS_FILE}"
}

record_failure() {
  local stage="$1"
  local failure_class="$2"
  local cause="$3"
  local action="$4"
  local artifact="${5:-}"
  local safe_cause
  local safe_action

  safe_cause="$(printf '%s' "${cause}" | single_line)"
  safe_action="$(printf '%s' "${action}" | single_line)"
  jq -nc \
    --arg timestamp "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --arg runId "${RUN_ID}" \
    --arg task "${TASK_ID}" \
    --arg stage "${stage}" \
    --arg failureClass "${failure_class}" \
    --arg cause "${safe_cause}" \
    --arg action "${safe_action}" \
    --arg artifact "${artifact}" \
    --argjson iteration "${iteration:-0}" \
    '{timestamp:$timestamp,runId:$runId,task:$task,iteration:$iteration,stage:$stage,failureClass:$failureClass,cause:$cause,action:$action,artifact:$artifact}' \
    >> "${FAILURES_FILE}"
  append_progress "${stage}" failed "${failure_class}: ${safe_cause}" "${safe_action}" "${artifact}"
  ralph_observe_event failure_recorded "${iteration:-0}" "${stage}" failed '' '' 0 \
    "${failure_class}: ${safe_cause}" "${artifact}"
}

log_fallback_event() {
  local role="$1"
  local stage="$2"
  local model_alias="$3"
  local attempt="$4"
  local error_class="$5"
  local exit_code="$6"
  local action="$7"
  jq -nc \
    --arg timestamp "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --arg role "${role}" \
    --arg stage "${stage}" \
    --arg modelAlias "${model_alias}" \
    --arg errorClass "${error_class}" \
    --arg action "${action}" \
    --argjson attempt "${attempt}" \
    --argjson exitCode "${exit_code}" \
    '{timestamp:$timestamp,role:$role,stage:$stage,modelAlias:$modelAlias,attempt:$attempt,errorClass:$errorClass,exitCode:$exitCode,action:$action}' \
    >> "${FALLBACK_EVENTS_FILE}"
  ralph_observe_event fallback "${iteration:-0}" "${stage}" "${action}" \
    "${role}" "${model_alias}" "${attempt}" "${action}: ${error_class} (exit ${exit_code})" 'fallback-events.jsonl'
  case "${action}" in
    retry_same_model)
      record_failure "${stage}" "${error_class}" \
        "${role} model=${model_alias} attempt=${attempt} 호출이 exit ${exit_code}로 실패" \
        'backoff 후 같은 모델 재시도' 'fallback-events.jsonl'
      ;;
    fallback_next_model)
      record_failure "${stage}" "${error_class}" \
        "${role} model=${model_alias} attempt=${attempt}까지 실패해 현재 run에서 소진" \
        'fallback chain의 다음 실행 가능 모델로 전환' 'fallback-events.jsonl'
      ;;
    stop_non_retryable)
      record_failure "${stage}" "${error_class}" \
        "${role} model=${model_alias} 호출이 비재시도 오류(exit ${exit_code})로 실패" \
        '자동 우회를 중단하고 사용자 확인 요청' 'fallback-events.jsonl'
      ;;
    skip_unavailable|skip_degraded|skip_conflict)
      append_progress "${stage}" skipped \
        "${role} model=${model_alias}: ${error_class}" \
        "${action}" 'fallback-events.jsonl'
      ;;
  esac
}

alias_is_excluded() {
  local model_alias="$1"
  local excluded_aliases="${2:-}"
  [[ -n "${excluded_aliases}" ]] && grep -Fxq "${model_alias}" <<<"$(tr '|' '\n' <<<"${excluded_aliases}")"
}

has_available_role_model_excluding() {
  local role="$1"
  local excluded_aliases="${2:-}"
  local model_alias
  while IFS= read -r model_alias; do
    [[ -n "${model_alias}" ]] || continue
    alias_is_excluded "${model_alias}" "${excluded_aliases}" && continue
    is_model_degraded "${model_alias}" && continue
    if command_for_model "${role}" "${model_alias}" run >/dev/null; then
      return 0
    fi
  done < <(aliases_for_role "${role}")
  return 1
}

is_model_degraded() {
  grep -Fxq "$1" "${DEGRADED_MODELS_FILE}" 2>/dev/null
}

mark_model_degraded() {
  if ! is_model_degraded "$1"; then
    printf '%s\n' "$1" >> "${DEGRADED_MODELS_FILE}"
  fi
}

run_agent_with_fallback() {
  local role="$1"
  local stage="$2"
  local input_file="$3"
  local output_file="$4"
  local execution_mode="${5:-run}"
  local excluded_aliases="${6:-}"
  local model_alias
  local command_string
  local attempt
  local attempt_output
  local agent_rc
  local error_class
  local backoff_seconds
  local last_rc=70

  : > "${output_file}"
  : > "${output_file}.stderr"

  while IFS= read -r model_alias; do
    [[ -n "${model_alias}" ]] || continue

    if alias_is_excluded "${model_alias}" "${excluded_aliases}"; then
      printf '[%s] %s model=%s 건너뜀: Worker 또는 1차 Critic과 독립된 평가 모델을 선택합니다.\n' \
        "$(date '+%H:%M:%S')" "${stage}" "${model_alias}"
      log_fallback_event "${role}" "${stage}" "${model_alias}" 0 model_conflict 0 skip_conflict
      continue
    fi

    if is_model_degraded "${model_alias}"; then
      printf '[%s] %s model=%s 건너뜀: 이 run에서 이미 transient 장애로 소진됨\n' \
        "$(date '+%H:%M:%S')" "${stage}" "${model_alias}"
      log_fallback_event "${role}" "${stage}" "${model_alias}" 0 degraded 75 skip_degraded
      continue
    fi

    if ! command_string="$(command_for_model "${role}" "${model_alias}" "${execution_mode}")"; then
      printf '[%s] %s model=%s 건너뜀: 역할용 명령 없음\n' \
        "$(date '+%H:%M:%S')" "${stage}" "${model_alias}"
      log_fallback_event "${role}" "${stage}" "${model_alias}" 0 unavailable 0 skip_unavailable
      continue
    fi

    attempt=1
    while [[ "${attempt}" -le "${MAX_ATTEMPTS_PER_MODEL}" ]]; do
      attempt_output="${output_file}.${model_alias}.attempt-${attempt}"
      if run_agent_once "${role}" "${stage}" "${model_alias}" "${command_string}" "${input_file}" "${attempt_output}" "${execution_mode}"; then
        cp "${attempt_output}" "${output_file}"
        cp "${attempt_output}.stderr" "${output_file}.stderr"
        printf '%s\n' "${model_alias}" > "${output_file}.model"
        log_fallback_event "${role}" "${stage}" "${model_alias}" "${attempt}" none 0 success
        return 0
      else
        agent_rc=$?
      fi

      last_rc="${agent_rc}"
      error_class="$(classify_agent_error "${agent_rc}" "${attempt_output}" "${attempt_output}.stderr")"
      cp "${attempt_output}" "${output_file}"
      cp "${attempt_output}.stderr" "${output_file}.stderr"

      if ! is_retryable_error "${error_class}"; then
        log_fallback_event "${role}" "${stage}" "${model_alias}" "${attempt}" "${error_class}" "${agent_rc}" stop_non_retryable
        printf 'ERROR: %s model=%s 비재시도 오류=%s rc=%s\n' \
          "${stage}" "${model_alias}" "${error_class}" "${agent_rc}" >&2
        return "${agent_rc}"
      fi

      if [[ "${attempt}" -lt "${MAX_ATTEMPTS_PER_MODEL}" ]]; then
        backoff_seconds=$((INITIAL_BACKOFF_SECONDS * (1 << (attempt - 1))))
        if [[ "${backoff_seconds}" -gt "${MAX_BACKOFF_SECONDS}" ]]; then
          backoff_seconds="${MAX_BACKOFF_SECONDS}"
        fi
        log_fallback_event "${role}" "${stage}" "${model_alias}" "${attempt}" "${error_class}" "${agent_rc}" retry_same_model
        printf 'WARNING: %s model=%s 오류=%s, %ss 후 재시도 %s/%s\n' \
          "${stage}" "${model_alias}" "${error_class}" "${backoff_seconds}" "$((attempt + 1))" "${MAX_ATTEMPTS_PER_MODEL}" >&2
        if [[ "${RALPH_FALLBACK_DISABLE_SLEEP:-0}" != "1" && "${backoff_seconds}" -gt 0 ]]; then
          sleep "${backoff_seconds}"
        fi
      else
        mark_model_degraded "${model_alias}"
        log_fallback_event "${role}" "${stage}" "${model_alias}" "${attempt}" "${error_class}" "${agent_rc}" fallback_next_model
        printf 'WARNING: %s model=%s transient 오류 소진, 다음 모델로 전환\n' \
          "${stage}" "${model_alias}" >&2
      fi
      attempt=$((attempt + 1))
    done
  done < <(aliases_for_role "${role}")

  printf 'ERROR: %s에서 실행 가능한 fallback 모델을 모두 소진했습니다.\n' "${stage}" >&2
  return "${last_rc}"
}

append_critic_contract() {
  printf '# Critic evaluation contract\n'
  sed -n '1,320p' "${RUBRIC_FILE}"
  printf '\n# Common rubric JSON\n'
  cat "${BASE_RUBRIC_FILE}"
  printf '\n# Task rubric JSON: %s\n' "${TASK_ID}"
  cat "${TASK_RUBRIC_FILE}"
  printf '\n# Deterministic pass threshold\n%s\n' "${MIN_CRITIC_SCORE}"
}

if [[ "${MODE}" == "smoke" ]]; then
  SMOKE_CRITIC_INPUT="${RUN_DIR}/smoke-critic.input.md"
  SMOKE_CRITIC_OUTPUT="${RUN_DIR}/smoke-critic.output.raw.json"
  SMOKE_CRITIC_ASSESSMENT="${RUN_DIR}/smoke-critic.assessment.json"
  SMOKE_CRITIC_EXPECTED="${RUN_DIR}/smoke-critic.expected.json"
  jq -n --slurpfile base "${BASE_RUBRIC_FILE}" --slurpfile task "${TASK_RUBRIC_FILE}" '{
    criteria: (($base[0].criteria + $task[0].criteria) | map({id:.id,level:"complete",evidence:["Ralph Critic smoke test"],reason:"연결 검사를 위한 고정 증거입니다."})),
    hardGates: (($base[0].hardGates + $task[0].hardGates) | map({id:.id,status:"pass",evidence:["Ralph Critic smoke test"],reason:"연결 검사를 위한 고정 판정입니다."})),
    findings: [], risks: [], lesson: "smoke test only"
  }' > "${SMOKE_CRITIC_EXPECTED}"
  {
    printf '%s\n' \
      '이것은 읽기 전용 Ralph Critic 연결 및 출력 계약 검사입니다. 파일을 읽거나 수정하지 않습니다.' \
      '설명과 코드 펜스 없이 아래 JSON 객체 하나만 정확히 출력합니다.'
    cat "${SMOKE_CRITIC_EXPECTED}"
  } > "${SMOKE_CRITIC_INPUT}"
  if ! run_agent_with_fallback critic 'Smoke Critic' "${SMOKE_CRITIC_INPUT}" "${SMOKE_CRITIC_OUTPUT}" run; then
    sed -n '1,120p' "${SMOKE_CRITIC_OUTPUT}.stderr" >&2
    exit 6
  fi
  if ! python3 "${CRITIC_ENGINE}" evaluate \
    --raw "${SMOKE_CRITIC_OUTPUT}" --base "${BASE_RUBRIC_FILE}" --task-rubric "${TASK_RUBRIC_FILE}" \
    --threshold "${MIN_CRITIC_SCORE}" --worker-exit 0 --verifier-exit 0 --stage post-worker \
    --output "${SMOKE_CRITIC_ASSESSMENT}" --strict; then
    printf 'ERROR: Smoke Critic이 유효한 계약 JSON을 반환하지 않았습니다.\n' >&2
    sed -n '1,80p' "${SMOKE_CRITIC_OUTPUT}" >&2
    exit 6
  fi

  SMOKE_META_INPUT="${RUN_DIR}/smoke-meta.input.md"
  SMOKE_META_OUTPUT="${RUN_DIR}/smoke-meta.output.md"
  cat > "${SMOKE_META_INPUT}" <<'EOF'
이것은 Ralph Meta-Prompter 연결 검사다. 파일을 읽거나 수정하지 마라.
코드 펜스 없이 150자 이상의 Markdown 작업 계약을 출력하라.
제목은 '# Ralph Smoke Prompt'로 시작하고 목표, 허용 범위, 완료 조건을 포함하라.
EOF
  if ! run_agent_with_fallback metaPrompter 'Smoke Meta-Prompter' "${SMOKE_META_INPUT}" "${SMOKE_META_OUTPUT}" run; then
    sed -n '1,120p' "${SMOKE_META_OUTPUT}.stderr" >&2
    exit 6
  fi
  if [[ ! -s "${SMOKE_META_OUTPUT}" ]] || [[ "$(wc -c < "${SMOKE_META_OUTPUT}")" -lt 150 ]] || grep -Eq '^```' "${SMOKE_META_OUTPUT}"; then
    printf 'ERROR: Smoke Meta-Prompter 출력 계약이 유효하지 않습니다.\n' >&2
    exit 6
  fi

  SMOKE_WORKER_INPUT="${RUN_DIR}/smoke-worker.input.md"
  SMOKE_WORKER_OUTPUT="${RUN_DIR}/smoke-worker.output.md"
  cat > "${SMOKE_WORKER_INPUT}" <<'EOF'
이것은 읽기 전용 Ralph Worker 연결 검사다. 파일과 외부 상태를 읽거나 수정하지 마라.
정확히 RALPH_WORKER_SMOKE_OK 한 줄만 출력하라.
EOF
  if ! run_agent_with_fallback worker 'Smoke Worker' "${SMOKE_WORKER_INPUT}" "${SMOKE_WORKER_OUTPUT}" smoke; then
    sed -n '1,120p' "${SMOKE_WORKER_OUTPUT}.stderr" >&2
    exit 6
  fi
  if ! grep -qx 'RALPH_WORKER_SMOKE_OK' "${SMOKE_WORKER_OUTPUT}"; then
    printf 'ERROR: Smoke Worker 응답이 예상과 다릅니다.\n' >&2
    sed -n '1,80p' "${SMOKE_WORKER_OUTPUT}" >&2
    exit 6
  fi

  SMOKE_VERIFY_OUTPUT="${RUN_DIR}/smoke-verify.log"
  printf '[%s] Smoke Verifier 시작\n' "$(date '+%H:%M:%S')"
  if ! (
    cd "${PROJECT_ROOT}"
    bash -lc "${RALPH_VERIFY_CMD}"
  ) > "${SMOKE_VERIFY_OUTPUT}" 2>&1; then
    sed -n '1,160p' "${SMOKE_VERIFY_OUTPUT}" >&2
    exit 6
  fi

  ralph_observe_event run_completed 0 run passed '' '' 0 \
    'Critic, Meta-Prompter, Worker와 Verifier 연결 검사가 통과했습니다.' 'smoke-verify.log' 100 pass
  printf 'SUCCESS: Ralph smoke test 통과. Critic, Meta, Worker(read-only), Verifier가 모두 응답했습니다.\n'
  printf '증거 디렉터리: %s\n' "${RUN_DIR}"
  exit 0
fi

evaluate_critic_json() {
  local raw_file="$1"
  local assessment_file="$2"
  local stage="$3"
  local worker_exit="${4:-0}"
  local verifier_exit="${5:-0}"
  local history_file="${6:-}"
  local args=(
    evaluate --raw "${raw_file}" --base "${BASE_RUBRIC_FILE}" --task-rubric "${TASK_RUBRIC_FILE}"
    --threshold "${MIN_CRITIC_SCORE}" --worker-exit "${worker_exit}" --verifier-exit "${verifier_exit}"
    --stage "${stage}" --output "${assessment_file}"
  )
  if [[ -n "${history_file}" ]]; then
    args+=(--history "${history_file}")
  fi
  python3 "${CRITIC_ENGINE}" "${args[@]}"
}

write_state() {
  local iteration="$1"
  local status="$2"
  local score="$3"
  jq -n \
    --arg runId "${RUN_ID}" \
    --arg task "${TASK_ID}" \
    --arg status "${status}" \
    --argjson iteration "${iteration}" \
    --argjson score "${score}" \
    --arg runDirectory "${RUN_DIR}" \
    '{runId:$runId, task:$task, status:$status, iteration:$iteration, criticScore:$score, runDirectory:$runDirectory}' \
    > "${STATE_FILE}.tmp"
  mv "${STATE_FILE}.tmp" "${STATE_FILE}"
}

append_guardrail_lesson() {
  local lesson="$1"
  local lesson_iteration="$2"
  lesson="$(printf '%s' "${lesson}" | single_line)"
  if [[ -n "${lesson}" ]] && ! grep -Fq -- "] ${lesson}" "${GUARDRAILS_FILE}"; then
    printf '\n- [%s][run=%s][iteration=%s] %s\n' \
      "$(date '+%Y-%m-%d')" "${RUN_ID}" "${lesson_iteration}" "${lesson}" >> "${GUARDRAILS_FILE}"
  fi
}

append_lesson() {
  local critic_file="$1"
  local lesson_iteration="$2"
  local lesson
  lesson="$(jq -r '.lesson // empty' "${critic_file}")"
  append_guardrail_lesson "${lesson}" "${lesson_iteration}"
}

append_operator_note() {
  if [[ -s "${OPERATOR_NOTE_FILE}" ]]; then
    printf '\n# Human operator note\n'
    printf '아래 지시는 사용자가 실행 중 추가한 최신 개입 사항이다. 기존 목표와 안전 규칙을 위반하지 않는 범위에서 우선 반영하라.\n'
    sed -n '1,240p' "${OPERATOR_NOTE_FILE}"
  fi
}

checkpoint_iteration() {
  local iteration="$1"
  local status="$2"
  local score="$3"
  local worker_rc="$4"
  local verify_rc="$5"
  local verdict="$6"
  local checkpoint_sha
  local checkpoint_error_file="${RUN_DIR}/git-checkpoint-${iteration}.stderr"
  local checkpoint_error_summary=""

  if ! checkpoint_sha="$(
    RALPH_PROJECT_ROOT="${PROJECT_ROOT}" \
    RALPH_RUN_DIR="${RUN_DIR}" \
      "${GIT_CHECKPOINT}" commit \
        "${iteration}" "${TASK_ID}" "${RUN_ID}" "${status}" "${score}" \
        "${worker_rc}" "${verify_rc}" "${verdict}" "${GIT_CHECKPOINT_PREFIX}" 2>"${checkpoint_error_file}"
  )"; then
    checkpoint_error_summary="$(tail -n 1 "${checkpoint_error_file}" 2>/dev/null | single_line)"
    write_state "${iteration}" 'checkpoint_failed' "${score}"
    ralph_observe_event checkpoint_failed "${iteration}" checkpoint failed git '' 0 \
      "Git checkpoint 생성이 차단되었습니다: ${checkpoint_error_summary:-상세 원인은 오류 로그를 확인하세요.}" \
      "$(basename "${checkpoint_error_file}")" "${score}" "${verdict}"
    printf 'ERROR: Iteration %s Git checkpoint 생성에 실패했습니다. 자동 루프를 중단합니다.\n' "${iteration}" >&2
    return 1
  fi
  rm -f "${checkpoint_error_file}"
  printf 'Iteration %s Git checkpoint: %s\n' "${iteration}" "${checkpoint_sha}"
  if [[ "${status}" == 'meta_failed' || "${status}" == 'meta_invalid' || "${status}" == 'worker_failed' || "${status}" == 'worker_fallback_exhausted' || "${status}" == 'needs_operator' ]]; then
    ralph_observe_event checkpoint_completed "${iteration}" checkpoint warning git '' 0 \
      "실행 중단 전 변경을 안전 복구 지점 ${checkpoint_sha}에 저장했습니다. Iteration 완료를 뜻하지 않습니다." \
      "git-checkpoint-${iteration}.json" "${score}" "${verdict}"
  else
    ralph_observe_event checkpoint_completed "${iteration}" checkpoint completed git '' 0 \
      "Iteration ${iteration} 종료 상태를 복구 지점 ${checkpoint_sha}에 저장했습니다." \
      "git-checkpoint-${iteration}.json" "${score}" "${verdict}"
  fi
}

if ! GIT_BASELINE_JSON="$(
  RALPH_PROJECT_ROOT="${PROJECT_ROOT}" \
  RALPH_RUN_DIR="${RUN_DIR}" \
    "${GIT_CHECKPOINT}" prepare
)"; then
  write_state 0 'git_baseline_invalid' 0
  exit 8
fi

ralph_observe_run_metadata \
  "${MAX_ITERATIONS}" "${MIN_CRITIC_SCORE}" "$(jq -r '.baselineCommit' <<<"${GIT_BASELINE_JSON}")" \
  "$(git -C "${PROJECT_ROOT}" branch --show-current 2>/dev/null || true)" "${ROUTE_JSON}" "${RUN_DIR}"
ralph_observe_event run_started 0 run running '' '' 0 \
  "task=${TASK_ID}, 최대 ${MAX_ITERATIONS}회, 통과 점수 ${MIN_CRITIC_SCORE}" 'run.json'

printf 'Ralph run %s 시작: task=%s route=%s baseline=%s\n' \
  "${RUN_ID}" "${TASK_ID}" "${ROUTE_JSON}" "$(jq -r '.baselineCommit' <<<"${GIT_BASELINE_JSON}")"

iteration=1
while [[ "${iteration}" -le "${MAX_ITERATIONS}" ]]; do
  printf '\nIteration %s/%s\n' "${iteration}" "${MAX_ITERATIONS}"
  ralph_observe_event iteration_started "${iteration}" iteration running '' '' 0 \
    "Iteration ${iteration}/${MAX_ITERATIONS}을 시작했습니다." ''

  PRE_CRITIC_INPUT="${RUN_DIR}/critic-pre-${iteration}.input.md"
  PRE_CRITIC_RAW="${RUN_DIR}/critic-pre-${iteration}.raw"
  PRE_CRITIC_JSON="${RUN_DIR}/critic-pre-${iteration}.json"

  {
    printf '# Critic stage\npre-worker\n\n'
    printf '# Task ID and local model route\n%s\n%s\n\n' "${TASK_ID}" "${ROUTE_JSON}"
    append_operator_note
    append_critic_contract
    printf '\n# Current worker prompt\n'
    sed -n '1,320p' "${PROMPT_FILE}"
    printf '\n# Guardrails\n'
    sed -n '1,320p' "${GUARDRAILS_FILE}"
    printf '\n# Recent progress and failure ledger\n'
    tail -n 160 "${PROGRESS_FILE}"
    printf '\n# Latest deterministic verification log\n'
    sed -n '1,240p' "${LAST_VERIFY_FILE}"
    printf '\n# Git status and diff summary\n'
    git -C "${PROJECT_ROOT}" status --short || true
    git -C "${PROJECT_ROOT}" diff --stat || true
  } > "${PRE_CRITIC_INPUT}"

  if ! run_agent_with_fallback critic 'Pre-Critic' "${PRE_CRITIC_INPUT}" "${PRE_CRITIC_RAW}" run; then
    printf 'ERROR: Pre-Critic fallback chain을 모두 소진했습니다.\n' >&2
    record_failure pre_critic fallback_exhausted \
      'Pre-Critic의 실행 가능한 모델이 모두 실패하거나 비재시도 오류로 중단됨' \
      'run을 중단하고 failures.jsonl과 fallback-events.jsonl을 확인' \
      "$(basename "${PRE_CRITIC_RAW}.stderr")"
    write_state "${iteration}" 'critic_failed' 0
    checkpoint_iteration "${iteration}" 'critic_failed' 0 -1 -1 error || exit 8
    exit 4
  fi
  if ! evaluate_critic_json "${PRE_CRITIC_RAW}" "${PRE_CRITIC_JSON}" 'pre-worker' 0 0; then
    record_failure pre_critic invalid_output \
      'Critic 응답이 작업별 항목·증거 JSON 스키마를 충족하지 못함' \
      'needs_operator 평가를 다음 Meta-Prompter에 전달하고 출력 어댑터 점검 교훈을 기록' \
      "$(basename "${PRE_CRITIC_JSON}")"
    append_lesson "${PRE_CRITIC_JSON}" "${iteration}"
  fi
  ralph_observe_event stage_completed "${iteration}" pre_critic completed critic \
    "$(cat "${PRE_CRITIC_RAW}.model" 2>/dev/null || true)" 0 \
    "$(jq -r '.summary // "Pre-Critic 평가 완료"' "${PRE_CRITIC_JSON}" | tr '\n' ' ')" "$(basename "${PRE_CRITIC_JSON}")" \
    "$(jq -r '.score // 0' "${PRE_CRITIC_JSON}")" "$(jq -r '.verdict // "fail"' "${PRE_CRITIC_JSON}")"

  META_INPUT="${RUN_DIR}/meta-${iteration}.input.md"
  META_OUTPUT="${RUN_DIR}/prompt-${iteration}.next.md"
  {
    sed -n '1,320p' "${META_PROMPT_FILE}"
    printf '\n# Current PROMPT.md\n'
    sed -n '1,360p' "${PROMPT_FILE}"
    printf '\n# Critic JSON\n'
    sed -n '1,240p' "${PRE_CRITIC_JSON}"
    printf '\n# Latest verification log\n'
    sed -n '1,240p' "${LAST_VERIFY_FILE}"
    printf '\n# Guardrails\n'
    sed -n '1,360p' "${GUARDRAILS_FILE}"
    printf '\n# Recent progress and failure ledger\n'
    tail -n 160 "${PROGRESS_FILE}"
    printf '\n# Selected task and local route\n%s\n%s\n' "${TASK_ID}" "${ROUTE_JSON}"
    append_operator_note
  } > "${META_INPUT}"

  if ! run_agent_with_fallback metaPrompter 'Meta-Prompter' "${META_INPUT}" "${META_OUTPUT}" run; then
    printf 'ERROR: Meta-Prompter 실행에 실패했습니다. 로그: %s.stderr\n' "${META_OUTPUT}" >&2
    record_failure meta_prompter fallback_exhausted \
      'Meta-Prompter의 실행 가능한 모델이 모두 실패하거나 비재시도 오류로 중단됨' \
      'run을 중단하고 모델 연결·오류 분류·fallback chain을 확인' \
      "$(basename "${META_OUTPUT}.stderr")"
    write_state "${iteration}" 'meta_failed' 0
    checkpoint_iteration "${iteration}" 'meta_failed' 0 -1 -1 error || exit 8
    exit 4
  fi

  if [[ ! -s "${META_OUTPUT}" ]] || [[ "$(wc -c < "${META_OUTPUT}")" -lt 120 ]] || grep -Eq '^```' "${META_OUTPUT}"; then
    printf 'ERROR: Meta-Prompter 출력이 비었거나 전체 Markdown 계약을 지키지 않았습니다.\n' >&2
    record_failure meta_prompter invalid_output \
      'Meta-Prompter 응답이 비었거나 120자 미만이거나 코드 펜스로 감싸짐' \
      'META_PROMPT.md의 전체 Markdown 계약을 지켜 다시 실행' \
      "$(basename "${META_OUTPUT}")"
    append_guardrail_lesson \
      'Meta-Prompter는 코드 펜스 없이 120자 이상의 완전한 Markdown 작업 계약을 출력해야 한다.' \
      "${iteration}"
    write_state "${iteration}" 'meta_invalid' 0
    checkpoint_iteration "${iteration}" 'meta_invalid' 0 -1 -1 error || exit 8
    exit 4
  fi

  cp "${PROMPT_FILE}" "${RUN_DIR}/prompt-${iteration}.before.md"
  cp "${META_OUTPUT}" "${PROMPT_FILE}.tmp"
  mv "${PROMPT_FILE}.tmp" "${PROMPT_FILE}"
  ralph_observe_event stage_completed "${iteration}" meta_prompter completed metaPrompter \
    "$(cat "${META_OUTPUT}.model" 2>/dev/null || true)" 0 \
    'Critic 증거를 반영해 PROMPT.md 작업 계약을 갱신했습니다.' "$(basename "${META_OUTPUT}")"

  WORKER_INPUT="${RUN_DIR}/worker-${iteration}.input.md"
  WORKER_OUTPUT="${RUN_DIR}/worker-${iteration}.output.md"
  {
    printf '# 실행할 작업 계약\n'
    sed -n '1,420p' "${PROMPT_FILE}"
    printf '\n# 반드시 지킬 guardrails\n'
    sed -n '1,360p' "${GUARDRAILS_FILE}"
    printf '\n# 최근 진행 및 실패 원인\n'
    tail -n 160 "${PROGRESS_FILE}"
    printf '\n# 선택된 task와 권장 local fallback route\n%s\n%s\n' "${TASK_ID}" "${ROUTE_JSON}"
    append_operator_note
    printf '\n저장소를 직접 확인하고 구현·검증하라. 완료 선언 대신 변경 파일과 실행한 검증 증거를 보고하라.\n'
  } > "${WORKER_INPUT}"

  if run_agent_with_fallback worker 'Worker' "${WORKER_INPUT}" "${WORKER_OUTPUT}" run; then
    worker_rc=0
  else
    worker_rc=$?
  fi
  if [[ "${worker_rc}" -eq 0 ]]; then
    ralph_observe_event stage_completed "${iteration}" worker completed worker \
      "$(cat "${WORKER_OUTPUT}.model" 2>/dev/null || true)" 0 \
      'Worker가 구현 단계를 완료했습니다.' "$(basename "${WORKER_OUTPUT}")"
  else
    ralph_observe_event stage_completed "${iteration}" worker failed worker \
      "$(cat "${WORKER_OUTPUT}.model" 2>/dev/null || true)" 0 \
      "Worker 실행이 종료 코드 ${worker_rc}로 실패했습니다." "$(basename "${WORKER_OUTPUT}.stderr")"
    record_failure worker fallback_exhausted \
      "Worker fallback chain이 종료 코드 ${worker_rc}로 소진됨" \
      '사후 Critic과 verifier 증거로 원인을 구체화한 뒤 run 중단' \
      "$(basename "${WORKER_OUTPUT}.stderr")"
  fi

  VERIFY_FILE="${RUN_DIR}/verify-${iteration}.log"
  printf '[%s] Deterministic verifier 시작\n' "$(date '+%H:%M:%S')"
  ralph_observe_event stage_started "${iteration}" verifier running verifier '' 0 \
    '결정적 test·lint·typecheck·build 검증을 시작했습니다.' "$(basename "${VERIFY_FILE}")"
  set +e
  (
    cd "${PROJECT_ROOT}"
    bash -lc "${RALPH_VERIFY_CMD}"
  ) > "${VERIFY_FILE}" 2>&1
  verify_rc=$?
  set -e
  LAST_VERIFY_FILE="${VERIFY_FILE}"
  if [[ "${verify_rc}" -eq 0 ]]; then
    ralph_observe_event stage_completed "${iteration}" verifier completed verifier '' 0 \
      '결정적 검증이 통과했습니다.' "$(basename "${VERIFY_FILE}")"
  else
    ralph_observe_event stage_completed "${iteration}" verifier failed verifier '' 0 \
      "결정적 검증이 종료 코드 ${verify_rc}로 실패했습니다." "$(basename "${VERIFY_FILE}")"
    record_failure verifier deterministic_failure \
      "test·lint·typecheck·build 검증이 종료 코드 ${verify_rc}로 실패" \
      '사후 Critic이 실패 로그를 분석하고 다음 이터레이션의 완료 조건에 반영' \
      "$(basename "${VERIFY_FILE}")"
  fi

  POST_CRITIC_INPUT="${RUN_DIR}/critic-post-${iteration}.input.md"
  POST_CRITIC_RAW="${RUN_DIR}/critic-post-${iteration}.raw"
  POST_CRITIC_JSON="${RUN_DIR}/critic-post-${iteration}.json"
  POST_CRITIC_PRIMARY_JSON="${RUN_DIR}/critic-post-${iteration}.primary.json"
  {
    printf '# Critic stage\npost-worker\n\n'
    printf '# Task ID and local model route\n%s\n%s\n\n' "${TASK_ID}" "${ROUTE_JSON}"
    append_operator_note
    printf '# Worker exit code\n%s\n\n' "${worker_rc}"
    printf '# Verifier exit code\n%s\n\n' "${verify_rc}"
    append_critic_contract
    printf '\n# Evolved worker prompt\n'
    sed -n '1,420p' "${PROMPT_FILE}"
    printf '\n# Worker report\n'
    sed -n '1,300p' "${WORKER_OUTPUT}"
    printf '\n# Deterministic verification log\n'
    sed -n '1,320p' "${VERIFY_FILE}"
    printf '\n# Git status and diff summary\n'
    git -C "${PROJECT_ROOT}" status --short || true
    git -C "${PROJECT_ROOT}" diff --stat || true
  } > "${POST_CRITIC_INPUT}"

  worker_model="$(cat "${WORKER_OUTPUT}.model" 2>/dev/null || true)"
  post_critic_excludes=''
  if [[ -n "${worker_model}" ]] && has_available_role_model_excluding critic "${worker_model}"; then
    post_critic_excludes="${worker_model}"
  elif [[ -n "${worker_model}" ]]; then
    append_progress post_critic warning \
      "Worker와 다른 실행 가능한 Critic 모델이 없어 ${worker_model}을 독립 평가에 재사용" \
      '개인 critic fallback chain에 Worker와 다른 모델을 추가' 'run.json'
  fi

  if ! run_agent_with_fallback critic 'Post-Critic' "${POST_CRITIC_INPUT}" "${POST_CRITIC_RAW}" run "${post_critic_excludes}"; then
    printf 'ERROR: Post-Critic fallback chain을 모두 소진했습니다.\n' >&2
    record_failure post_critic fallback_exhausted \
      'Post-Critic의 실행 가능한 모델이 모두 실패하거나 비재시도 오류로 중단됨' \
      'run을 중단하고 Worker·verifier 원본 증거를 사람이 확인' \
      "$(basename "${POST_CRITIC_RAW}.stderr")"
    write_state "${iteration}" 'critic_failed' 0
    checkpoint_iteration "${iteration}" 'critic_failed' 0 "${worker_rc}" "${verify_rc}" error || exit 8
    exit 4
  fi
  if ! evaluate_critic_json "${POST_CRITIC_RAW}" "${POST_CRITIC_PRIMARY_JSON}" 'post-worker' "${worker_rc}" "${verify_rc}"; then
    record_failure post_critic invalid_output \
      'Critic 응답이 작업별 항목·증거 JSON 스키마를 충족하지 못함' \
      '다른 Critic의 경계 재심을 시도하고 복구되지 않으면 사용자 확인 상태로 중단' \
      "$(basename "${POST_CRITIC_PRIMARY_JSON}")"
  fi

  cp "${POST_CRITIC_PRIMARY_JSON}" "${POST_CRITIC_JSON}.unguarded"
  adjudication_json="$(python3 "${CRITIC_ENGINE}" should-adjudicate \
    --assessment "${POST_CRITIC_PRIMARY_JSON}" --margin "${ADJUDICATION_MARGIN}" 2>/dev/null || true)"
  if [[ "$(jq -r '.needed // false' <<<"${adjudication_json:-{}}" 2>/dev/null || printf false)" == 'true' ]]; then
    primary_critic_model="$(cat "${POST_CRITIC_RAW}.model" 2>/dev/null || true)"
    adjudicator_excludes="${primary_critic_model}"
    if [[ -n "${worker_model}" && "${worker_model}" != "${primary_critic_model}" ]]; then
      adjudicator_excludes="${adjudicator_excludes}|${worker_model}"
    fi
    if has_available_role_model_excluding critic "${adjudicator_excludes}"; then
      ADJUDICATOR_INPUT="${RUN_DIR}/critic-post-${iteration}.adjudicator.input.md"
      ADJUDICATOR_RAW="${RUN_DIR}/critic-post-${iteration}.adjudicator.raw"
      ADJUDICATOR_JSON="${RUN_DIR}/critic-post-${iteration}.adjudicator.json"
      {
        printf '%s\n' \
          '# Boundary adjudication' \
          '1차 평가가 통과선 경계이거나 Hard Gate가 불명확합니다. 아래 원본 증거와 1차 계산 결과를 독립적으로 재검토합니다.' \
          '1차 결론을 그대로 복사하지 말고 CRITIC_RUBRIC.md의 전체 항목·증거 JSON 계약을 다시 출력합니다.' \
          '' '# Trigger reason'
        jq -r '.reason' <<<"${adjudication_json}"
        printf '\n# Primary deterministic assessment\n'
        cat "${POST_CRITIC_PRIMARY_JSON}"
        printf '\n# Original evidence packet\n'
        cat "${POST_CRITIC_INPUT}"
      } > "${ADJUDICATOR_INPUT}"
      if run_agent_with_fallback critic 'Post-Critic' "${ADJUDICATOR_INPUT}" "${ADJUDICATOR_RAW}" run "${adjudicator_excludes}" && \
        evaluate_critic_json "${ADJUDICATOR_RAW}" "${ADJUDICATOR_JSON}" 'post-worker' "${worker_rc}" "${verify_rc}"; then
        jq \
          --arg primaryModel "${primary_critic_model}" \
          --arg adjudicatorModel "$(cat "${ADJUDICATOR_RAW}.model" 2>/dev/null || true)" \
          --arg reason "$(jq -r '.reason' <<<"${adjudication_json}")" \
          --argjson primaryScore "$(jq -r '.score' "${POST_CRITIC_PRIMARY_JSON}")" \
          '. + {adjudication:{performed:true,reason:$reason,primaryModel:$primaryModel,adjudicatorModel:$adjudicatorModel,primaryScore:$primaryScore}}' \
          "${ADJUDICATOR_JSON}" > "${POST_CRITIC_JSON}.unguarded"
        ralph_observe_event adjudication_completed "${iteration}" post_critic completed critic \
          "$(cat "${ADJUDICATOR_RAW}.model" 2>/dev/null || true)" 0 \
          '통과선 경계 결과를 Worker 및 1차 Critic과 다른 모델이 재심했습니다.' "$(basename "${ADJUDICATOR_JSON}")" \
          "$(jq -r '.score' "${ADJUDICATOR_JSON}")" "$(jq -r '.verdict' "${ADJUDICATOR_JSON}")"
      else
        append_progress post_critic warning \
          '경계 재심 Critic 호출 또는 출력 계약 검증에 실패' \
          '1차 결정적 평가를 유지하고 재심 실패 증거를 보존' "$(basename "${ADJUDICATOR_RAW:-$POST_CRITIC_RAW}.stderr")"
      fi
    else
      append_progress post_critic warning \
        '통과선 경계 재심에 사용할 독립 Critic 모델이 없음' \
        '개인 critic fallback chain에 Worker·1차 Critic과 다른 모델을 추가' 'run.json'
    fi
  fi

  python3 "${CRITIC_ENGINE}" guard --assessment "${POST_CRITIC_JSON}.unguarded" \
    --history "${ASSESSMENT_HISTORY_FILE}" --output "${POST_CRITIC_JSON}"
  jq -c . "${POST_CRITIC_JSON}" >> "${ASSESSMENT_HISTORY_FILE}"

  decision="$(jq -r '.decision' "${POST_CRITIC_JSON}")"
  verdict="$(jq -r '.verdict' "${POST_CRITIC_JSON}")"
  score="$(jq -r '.score | floor' "${POST_CRITIC_JSON}")"
  append_lesson "${POST_CRITIC_JSON}" "${iteration}"
  if [[ "${decision}" != 'pass' ]]; then
    critic_causes="$(jq -r '[.failures[]? | (.cause // .required_change // .criterion // empty)] | map(select(length > 0)) | join("; ")' "${POST_CRITIC_JSON}")"
    record_failure post_critic critic_rejection \
      "${critic_causes:-결정적 채점 엔진이 완료 조건 미충족으로 판정함}" \
      "$([[ "${decision}" == 'needs_operator' ]] && printf '사용자 확인 후 재개' || printf 'requiredChange와 guardrails 교훈을 다음 Meta-Prompter에 전달')" \
      "$(basename "${POST_CRITIC_JSON}")"
  fi
  final_critic_model="$(jq -r '.adjudication.adjudicatorModel // empty' "${POST_CRITIC_JSON}")"
  final_critic_model="${final_critic_model:-$(cat "${POST_CRITIC_RAW}.model" 2>/dev/null || true)}"
  ralph_observe_event stage_completed "${iteration}" post_critic completed critic \
    "${final_critic_model}" 0 \
    "$(jq -r '.summary // "Post-Critic 평가 완료"' "${POST_CRITIC_JSON}" | tr '\n' ' ')" "$(basename "${POST_CRITIC_JSON}")" \
    "${score}" "${verdict}"

  printf 'Iteration %s 결과: worker_rc=%s verify_rc=%s decision=%s score=%s\n' \
    "${iteration}" "${worker_rc}" "${verify_rc}" "${decision}" "${score}"

  if [[ "${worker_rc}" -ne 0 ]]; then
    iteration_status='worker_fallback_exhausted'
  elif [[ "${decision}" == 'pass' ]]; then
    iteration_status='passed'
  elif [[ "${decision}" == 'needs_operator' ]]; then
    iteration_status='needs_operator'
  elif [[ "${iteration}" -ge "${MAX_ITERATIONS}" ]]; then
    iteration_status='max_iterations_reached'
  else
    iteration_status='retrying'
  fi

  case "${iteration_status}" in
    passed)
      append_progress iteration passed \
        "verifier 통과, Critic ${score}점/${MIN_CRITIC_SCORE}점 이상" \
        'run 성공 종료' "$(basename "${POST_CRITIC_JSON}")"
      ;;
    retrying)
      append_progress iteration retrying \
        "worker_rc=${worker_rc}, verify_rc=${verify_rc}, verdict=${verdict}, score=${score}/${MIN_CRITIC_SCORE}" \
        '실패 증거를 다음 Critic·Meta-Prompter·Worker 입력에 전달' \
        "$(basename "${POST_CRITIC_JSON}")"
      ;;
    needs_operator)
      append_progress iteration needs_operator \
        "$(jq -r '.summary' "${POST_CRITIC_JSON}")" \
        '환경·권한·범위 또는 반복 정체를 사용자가 확인한 뒤 새 run으로 재개' \
        "$(basename "${POST_CRITIC_JSON}")"
      ;;
    max_iterations_reached)
      record_failure iteration max_iterations_reached \
        "최대 ${MAX_ITERATIONS}회 안에 verifier와 Critic 통과 조건을 함께 충족하지 못함" \
        '작업을 더 작게 분해하거나 Operator Note로 가설·검증 방법을 변경' \
        "$(basename "${POST_CRITIC_JSON}")"
      ;;
    worker_fallback_exhausted)
      append_progress iteration failed \
        "Worker fallback chain 소진(worker_rc=${worker_rc})" \
        'run 실패 종료' "$(basename "${WORKER_OUTPUT}.stderr")"
      ;;
  esac

  write_state "${iteration}" "${iteration_status}" "${score}"
  checkpoint_iteration "${iteration}" "${iteration_status}" "${score}" \
    "${worker_rc}" "${verify_rc}" "${verdict}" || exit 8

  if [[ "${iteration_status}" == 'worker_fallback_exhausted' ]]; then
    ralph_observe_event run_completed "${iteration}" run failed '' '' 0 \
      'Worker fallback chain을 모두 소진했습니다.' '' "${score}" "${verdict}"
    printf 'FAILED: Worker fallback chain을 모두 소진했습니다. 증거 디렉터리: %s\n' "${RUN_DIR}" >&2
    exit 4
  fi

  if [[ "${iteration_status}" == 'needs_operator' ]]; then
    ralph_observe_event run_completed "${iteration}" run needs_operator '' '' 0 \
      '자동 반복으로 해결할 수 없는 조건이 감지되어 사용자 확인을 기다립니다.' \
      "$(basename "${POST_CRITIC_JSON}")" "${score}" "${verdict}"
    printf 'NEEDS OPERATOR: 사용자 확인 후 새 run으로 재개하세요. 증거 디렉터리: %s\n' "${RUN_DIR}" >&2
    exit 7
  fi

  if [[ "${iteration_status}" == 'passed' ]]; then
    ralph_observe_event run_completed "${iteration}" run passed '' '' 0 \
      'Verifier와 Critic 통과 조건을 모두 만족했습니다.' "git-checkpoint-${iteration}.json" "${score}" "${verdict}"
    printf 'SUCCESS: Ralph Loop 통과. 증거 디렉터리: %s\n' "${RUN_DIR}"
    exit 0
  fi

  iteration=$((iteration + 1))
done

write_state "${MAX_ITERATIONS}" 'max_iterations_reached' "${score:-0}"
ralph_observe_event run_completed "${MAX_ITERATIONS}" run failed '' '' 0 \
  '최대 반복 횟수에 도달했습니다.' '' "${score:-0}" fail
printf 'FAILED: 최대 반복 횟수에 도달했습니다. 증거 디렉터리: %s\n' "${RUN_DIR}" >&2
exit 5
