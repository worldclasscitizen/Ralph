#!/usr/bin/env bash
set -Eeuo pipefail

# Ralph의 stdin 프롬프트를 Antigravity CLI stream-json 규격으로 변환한다.
# 같은 run/task/node/model 조합은 exact conversation_id로만 재개하며,
# 최종 응답 텍스트만 stdout으로 돌려준다.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${RALPH_PROJECT_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
MODEL_ID="${1:-gemini-3.7-flash-high}"
AGENT_MODE="${2:-plan}"
EFFORT="${3:-high}"
SESSION_MODE="${RALPH_SESSION_MODE:-stateless}"
SESSION_MAX_TURNS="${RALPH_SESSION_MAX_TURNS:-12}"
SESSION_PERSISTENT_ROLES="${RALPH_SESSION_PERSISTENT_ROLES:-metaPrompter|worker}"
RUN_DIR="${RALPH_RUN_DIR:-}"
TASK_ID="${RALPH_TASK_ID:-}"
ROLE="${RALPH_ROLE:-}"
STAGE="${RALPH_STAGE:-}"
MODEL_ALIAS="${RALPH_MODEL_ALIAS:-}"

if ! command -v agy >/dev/null 2>&1; then
  printf 'ERROR: Antigravity CLI(agy)가 없습니다. START_HERE.md의 설치 절차를 따르세요.\n' >&2
  exit 2
fi
if [[ ! -d "${PROJECT_ROOT}" ]]; then
  printf 'ERROR: Antigravity 작업 루트가 없습니다: %s\n' "${PROJECT_ROOT}" >&2
  exit 2
fi
PROJECT_ROOT="$(cd "${PROJECT_ROOT}" && pwd)"
if ! [[ "${SESSION_MAX_TURNS}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'ERROR: RALPH_SESSION_MAX_TURNS는 양의 정수여야 합니다.\n' >&2
  exit 2
fi

PROMPT_BODY="$(cat)"
if [[ -z "${PROMPT_BODY}" ]]; then
  printf 'ERROR: stdin 프롬프트가 비어 있습니다.\n' >&2
  exit 2
fi
PROMPT_BODY="# Antigravity workspace boundary
작업 루트 절대 경로: ${PROJECT_ROOT}
모든 파일 산출물은 이 작업 루트 아래에만 생성하거나 수정하라.
현재 저장소 파일·Git 상태·검증 결과가 이전 세션 기억보다 우선한다.

${PROMPT_BODY}"

TEMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TEMP_DIR}"
}
trap cleanup EXIT INT TERM

INPUT_FILE="${TEMP_DIR}/input.jsonl"
OUTPUT_FILE="${TEMP_DIR}/output.jsonl"
ERROR_FILE="${TEMP_DIR}/stderr.log"

# agy는 quota·rate limit 오류를 stderr가 아닌 stdout result event에 담으므로
# Ralph 분류기가 볼 수 있게 stderr로 옮기고 transient 오류는 구조화해 표시한다.
report_result_error() {
  local message="$1"
  [[ -n "${message}" ]] || return 0
  printf '%s\n' "${message}" >&2
  if grep -Eiq 'quota|rate[ _-]?limit|resource exhausted|too many requests|(^|[^0-9])429([^0-9]|$)' <<< "${message}"; then
    printf '%s\n' 'RALPH_AGENT_ERROR {"class":"rate_limit","source":"antigravity"}' >&2
  fi
}

result_error_from_output() {
  jq -r 'select(.event == "result") | .result.error // empty' "${OUTPUT_FILE}" 2>/dev/null | tail -n 1 || true
}

jq -cn --arg content "${PROMPT_BODY}" \
  '{event:"user", message:{content:$content}}' > "${INPUT_FILE}"

session_enabled=false
session_file=""
session_events_file=""
conversation_id=""
session_turns=0
session_resumed=false

slugify() {
  printf '%s' "$1" | tr '[:upper:] ' '[:lower:]_' | tr -cd 'a-z0-9._-'
}

record_session_event() {
  local event="$1"
  local conversation="$2"
  local turns="$3"
  [[ -n "${session_events_file}" ]] || return 0
  jq -nc \
    --arg timestamp "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --arg event "${event}" \
    --arg task "${TASK_ID}" \
    --arg role "${ROLE}" \
    --arg stage "${STAGE}" \
    --arg modelAlias "${MODEL_ALIAS}" \
    --arg conversationId "${conversation}" \
    --argjson turns "${turns}" \
    '{timestamp:$timestamp,event:$event,task:$task,role:$role,stage:$stage,modelAlias:$modelAlias,conversationId:$conversationId,turns:$turns}' \
    >> "${session_events_file}"
}

archive_session_file() {
  local reason="$1"
  local archived
  [[ -n "${session_file}" && -f "${session_file}" ]] || return 0
  archived="${session_file%.json}.${reason}.$(date '+%Y%m%d-%H%M%S').$$.json"
  mv "${session_file}" "${archived}"
}

if [[ "|${SESSION_PERSISTENT_ROLES}|" == *"|${ROLE}|"* && \
      "${SESSION_MODE}" == "hybrid" && -n "${RUN_DIR}" && -n "${TASK_ID}" && \
      -n "${ROLE}" && -n "${STAGE}" && -n "${MODEL_ALIAS}" ]]; then
  session_enabled=true
  session_dir="${RUN_DIR}/sessions"
  mkdir -p "${session_dir}"
  session_key="$(slugify "${TASK_ID}--${ROLE}--${STAGE}--${MODEL_ALIAS}")"
  session_file="${session_dir}/${session_key}.json"
  session_events_file="${RUN_DIR}/session-events.jsonl"

  if [[ -f "${session_file}" ]]; then
    if jq -e \
      --arg task "${TASK_ID}" --arg role "${ROLE}" --arg stage "${STAGE}" --arg model "${MODEL_ALIAS}" \
      '.task == $task and .role == $role and .stage == $stage and .modelAlias == $model and
       (.conversationId | type == "string") and (.conversationId | length > 0) and
       (.turns | type == "number")' "${session_file}" >/dev/null 2>&1; then
      conversation_id="$(jq -r '.conversationId' "${session_file}")"
      session_turns="$(jq -r '.turns' "${session_file}")"
      if [[ "${session_turns}" -ge "${SESSION_MAX_TURNS}" ]]; then
        record_session_event rotate_max_turns "${conversation_id}" "${session_turns}"
        archive_session_file max-turns
        conversation_id=""
        session_turns=0
      else
        session_resumed=true
      fi
    else
      record_session_event reset_invalid_state "" 0
      archive_session_file invalid-state
    fi
  fi
fi

run_agy() {
  local resume_id="$1"
  local agy_args=(
    --input-format stream-json
    --output-format stream-json
    --model "${MODEL_ID}"
    --mode "${AGENT_MODE}"
    --effort "${EFFORT}"
    --print-timeout 10m
  )
  if [[ -n "${resume_id}" ]]; then
    agy_args+=(--conversation "${resume_id}")
  fi
  : > "${OUTPUT_FILE}"
  : > "${ERROR_FILE}"
  set +e
  (
    cd "${PROJECT_ROOT}"
    agy "${agy_args[@]}" < "${INPUT_FILE}" > "${OUTPUT_FILE}" 2> "${ERROR_FILE}"
  )
  agy_rc=$?
  set -e
}

is_invalid_conversation_error() {
  {
    sed -n '1,120p' "${ERROR_FILE}" 2>/dev/null || true
    sed -n '1,80p' "${OUTPUT_FILE}" 2>/dev/null || true
  } | grep -Eiq 'conversation.{0,40}(not found|invalid|expired|deleted)|unknown conversation|failed to resume|cannot resume'
}

run_agy "${conversation_id}"
initial_status=""
if [[ "${agy_rc}" -eq 0 ]]; then
  initial_status="$(jq -r 'select(.event == "result") | .result.status // empty' "${OUTPUT_FILE}" | tail -n 1)"
fi
if [[ -n "${conversation_id}" && ( "${agy_rc}" -ne 0 || "${initial_status}" != "SUCCESS" ) ]] && \
   is_invalid_conversation_error; then
  record_session_event reset_invalid_conversation "${conversation_id}" "${session_turns}"
  archive_session_file invalid-conversation
  conversation_id=""
  session_turns=0
  session_resumed=false
  run_agy ""
fi

if [[ "${agy_rc}" -ne 0 ]]; then
  sed -n '1,80p' "${ERROR_FILE}" >&2
  report_result_error "$(result_error_from_output)"
  exit "${agy_rc}"
fi

if ! RESULT_JSON="$(jq -c 'select(.event == "result") | .result' "${OUTPUT_FILE}" 2>/dev/null | tail -n 1)"; then
  printf 'ERROR: Antigravity CLI result event JSON을 해석하지 못했습니다.\n' >&2
  printf '%s\n' 'RALPH_AGENT_ERROR {"class":"server_error","source":"antigravity","reason":"malformed_result"}' >&2
  exit 4
fi
if [[ -z "${RESULT_JSON}" ]]; then
  printf 'ERROR: Antigravity CLI가 result event를 반환하지 않았습니다.\n' >&2
  printf '%s\n' 'RALPH_AGENT_ERROR {"class":"server_error","source":"antigravity","reason":"missing_result"}' >&2
  sed -n '1,80p' "${ERROR_FILE}" >&2
  exit 4
fi

STATUS="$(jq -r '.status // "ERROR"' <<< "${RESULT_JSON}")"
if [[ "${STATUS}" != "SUCCESS" ]]; then
  report_result_error "$(jq -r '.error // "Antigravity agent failed"' <<< "${RESULT_JSON}")"
  exit 4
fi

RESPONSE_TEXT="$(jq -r 'if (.response? | type) == "string" then .response else "" end' <<< "${RESULT_JSON}")"
if [[ -z "$(printf '%s' "${RESPONSE_TEXT}" | tr -d '[:space:]')" ]]; then
  printf 'ERROR: Antigravity CLI가 SUCCESS를 반환했지만 최종 응답 본문이 비어 있습니다.\n' >&2
  printf '%s\n' 'RALPH_AGENT_ERROR {"class":"empty_response","source":"antigravity","reason":"success_without_response"}' >&2
  exit 74
fi

# agy 버전에 따라 usage 위치와 key 표기가 다를 수 있어 알려진 공식 필드를 모두 정규화한다.
USAGE_JSON="$(jq -sc '
  [ .. | objects | select(
      has("input_tokens") or has("inputTokens") or has("promptTokenCount") or
      has("output_tokens") or has("outputTokens") or has("candidatesTokenCount") or
      has("total_tokens") or has("totalTokens") or has("totalTokenCount")
    ) ] | last // {}
' "${OUTPUT_FILE}" 2>/dev/null || printf '{}')"
jq -nc \
  --arg provider google \
  --arg modelAlias "${RALPH_MODEL_ALIAS:-}" \
  --arg modelId "${MODEL_ID}" \
  --arg source antigravity_stream_json \
  --argjson usage "${USAGE_JSON}" \
  '{provider:$provider,modelAlias:$modelAlias,modelId:$modelId,source:$source,usage:$usage}' \
  | python3 "${SCRIPT_DIR}/record-usage.py" || true

if [[ "${session_enabled}" == true ]]; then
  returned_conversation_id="$(jq -r '.conversation_id // .conversationId // empty' <<< "${RESULT_JSON}")"
  if [[ -z "${returned_conversation_id}" ]]; then
    returned_conversation_id="${conversation_id}"
  fi
  if [[ -n "${returned_conversation_id}" ]]; then
    if [[ "${session_resumed}" == true ]]; then
      session_turns=$((session_turns + 1))
      session_event=resume
    else
      session_turns=1
      session_event=create
    fi
    session_tmp="${session_file}.tmp"
    jq -n \
      --arg task "${TASK_ID}" \
      --arg role "${ROLE}" \
      --arg stage "${STAGE}" \
      --arg modelAlias "${MODEL_ALIAS}" \
      --arg conversationId "${returned_conversation_id}" \
      --argjson turns "${session_turns}" \
      '{task:$task,role:$role,stage:$stage,modelAlias:$modelAlias,conversationId:$conversationId,turns:$turns}' \
      > "${session_tmp}"
    mv "${session_tmp}" "${session_file}"
    record_session_event "${session_event}" "${returned_conversation_id}" "${session_turns}"
  else
    record_session_event missing_conversation_id "" 0
    printf 'WARNING: AGY 결과에 conversation_id가 없어 이번 노드는 stateless로 계속됩니다.\n' >&2
  fi
fi

printf '%s\n' "${RESPONSE_TEXT}"
