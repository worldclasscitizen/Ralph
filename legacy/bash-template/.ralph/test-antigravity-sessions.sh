#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADAPTER="${SCRIPT_DIR}/antigravity-agent.sh"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ralph-agy-session-test.XXXXXX")"
PROJECT_ROOT="${TEMP_ROOT}/repo"
FAKE_BIN="${TEMP_ROOT}/bin"

cleanup() {
  rm -rf "${TEMP_ROOT}"
}
trap cleanup EXIT INT TERM

mkdir -p "${PROJECT_ROOT}" "${FAKE_BIN}"
PROJECT_ROOT="$(cd "${PROJECT_ROOT}" && pwd)"
RUN_DIR="${PROJECT_ROOT}/.ralph/runs/test-run"
mkdir -p "${RUN_DIR}"

cat > "${FAKE_BIN}/agy" <<'FAKE_AGY'
#!/usr/bin/env bash
set -Eeuo pipefail

count=0
if [[ -f "${FAKE_AGY_COUNT_FILE}" ]]; then
  count="$(cat "${FAKE_AGY_COUNT_FILE}")"
fi
count=$((count + 1))
printf '%s\n' "${count}" > "${FAKE_AGY_COUNT_FILE}"
printf '%s\n' "$*" >> "${FAKE_AGY_LOG}"
printf '%s\n' "$(pwd)" >> "${FAKE_AGY_CWD_LOG}"
cat >> "${FAKE_AGY_PROMPT_LOG}"
printf '\n' >> "${FAKE_AGY_PROMPT_LOG}"

conversation_id=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--conversation" && $# -ge 2 ]]; then
    conversation_id="$2"
    shift 2
  else
    shift
  fi
done

if [[ "${FAKE_AGY_EXPIRE_ON_RESUME:-0}" == "1" && -n "${conversation_id}" && \
      ! -f "${FAKE_AGY_EXPIRE_MARKER}" ]]; then
  : > "${FAKE_AGY_EXPIRE_MARKER}"
  printf 'conversation not found: %s\n' "${conversation_id}" >&2
  exit 1
fi

if [[ -z "${conversation_id}" ]]; then
  conversation_id="conv-new-${count}"
fi
jq -nc \
  --arg conversation "${conversation_id}" \
  --arg response "fake-response-${count}" \
  '{event:"result",result:{status:"SUCCESS",response:$response,conversation_id:$conversation}}'
FAKE_AGY
chmod +x "${FAKE_BIN}/agy"

export PATH="${FAKE_BIN}:${PATH}"
export FAKE_AGY_COUNT_FILE="${TEMP_ROOT}/agy-count.txt"
export FAKE_AGY_LOG="${TEMP_ROOT}/agy-args.log"
export FAKE_AGY_CWD_LOG="${TEMP_ROOT}/agy-cwd.log"
export FAKE_AGY_PROMPT_LOG="${TEMP_ROOT}/agy-prompts.log"
export FAKE_AGY_EXPIRE_MARKER="${TEMP_ROOT}/agy-expired-once"

run_adapter() {
  local role="$1"
  local stage="$2"
  local prompt="$3"
  local max_turns="${4:-12}"
  printf '%s\n' "${prompt}" | \
    RALPH_PROJECT_ROOT="${PROJECT_ROOT}" \
    RALPH_RUN_DIR="${RUN_DIR}" \
    RALPH_TASK_ID=backend_core \
    RALPH_ROLE="${role}" \
    RALPH_STAGE="${stage}" \
    RALPH_MODEL_ALIAS=gemini-flash \
    RALPH_SESSION_MODE=hybrid \
    RALPH_SESSION_MAX_TURNS="${max_turns}" \
    RALPH_SESSION_PERSISTENT_ROLES='metaPrompter|worker' \
      "${ADAPTER}" gemini-3.7-flash-high plan high
}

[[ "$(run_adapter worker Worker 'first worker turn')" == 'fake-response-1' ]]
worker_session="${RUN_DIR}/sessions/backend_core--worker--worker--gemini-flash.json"
jq -e '.conversationId == "conv-new-1" and .turns == 1 and .role == "worker" and .stage == "Worker"' \
  "${worker_session}" >/dev/null

[[ "$(run_adapter worker Worker 'second worker turn')" == 'fake-response-2' ]]
jq -e '.conversationId == "conv-new-1" and .turns == 2' "${worker_session}" >/dev/null
sed -n '2p' "${FAKE_AGY_LOG}" | grep -F -- '--conversation conv-new-1' >/dev/null

[[ "$(run_adapter metaPrompter Meta-Prompter 'independent meta turn')" == 'fake-response-3' ]]
meta_session="${RUN_DIR}/sessions/backend_core--metaprompter--meta-prompter--gemini-flash.json"
jq -e '.conversationId == "conv-new-3" and .turns == 1 and .role == "metaPrompter"' \
  "${meta_session}" >/dev/null
if sed -n '3p' "${FAKE_AGY_LOG}" | grep -F -- '--conversation' >/dev/null; then
  printf 'ERROR: 다른 node의 AGY conversation이 Meta-Prompter로 누출됐습니다.\n' >&2
  exit 1
fi

[[ "$(run_adapter critic Post-Critic 'stateless critic turn')" == 'fake-response-4' ]]
if find "${RUN_DIR}/sessions" -name '*critic*' -type f -print -quit | grep -q .; then
  printf 'ERROR: 독립 평가자 Critic의 AGY session이 저장됐습니다.\n' >&2
  exit 1
fi

FAKE_AGY_EXPIRE_ON_RESUME=1 run_adapter worker Worker 'recover expired worker session' \
  > "${TEMP_ROOT}/recovered.out"
[[ "$(cat "${TEMP_ROOT}/recovered.out")" == 'fake-response-6' ]]
sed -n '5p' "${FAKE_AGY_LOG}" | grep -F -- '--conversation conv-new-1' >/dev/null
if sed -n '6p' "${FAKE_AGY_LOG}" | grep -F -- '--conversation' >/dev/null; then
  printf 'ERROR: 만료 session 복구 호출이 이전 conversation을 다시 사용했습니다.\n' >&2
  exit 1
fi
jq -e '.conversationId == "conv-new-6" and .turns == 1' "${worker_session}" >/dev/null
jq -s -e '
  any(.[]; .event == "create" and .role == "worker") and
  any(.[]; .event == "resume" and .role == "worker") and
  any(.[]; .event == "create" and .role == "metaPrompter") and
  (any(.[]; .role == "critic") | not) and
  any(.[]; .event == "reset_invalid_conversation" and .role == "worker")
' "${RUN_DIR}/session-events.jsonl" >/dev/null

[[ "$(run_adapter worker Worker 'rotate worker session' 1)" == 'fake-response-7' ]]
if sed -n '7p' "${FAKE_AGY_LOG}" | grep -F -- '--conversation' >/dev/null; then
  printf 'ERROR: max turns에 도달한 AGY session이 회전되지 않았습니다.\n' >&2
  exit 1
fi
jq -e '.conversationId == "conv-new-7" and .turns == 1' "${worker_session}" >/dev/null
jq -s -e 'any(.[]; .event == "rotate_max_turns" and .role == "worker")' \
  "${RUN_DIR}/session-events.jsonl" >/dev/null

if grep -Fvx "${PROJECT_ROOT}" "${FAKE_AGY_CWD_LOG}" >/dev/null; then
  printf 'ERROR: AGY가 프로젝트 루트 밖에서 실행됐습니다.\n' >&2
  exit 1
fi
grep -F "작업 루트 절대 경로: ${PROJECT_ROOT}" "${FAKE_AGY_PROMPT_LOG}" >/dev/null
grep -F '현재 저장소 파일·Git 상태·검증 결과가 이전 세션 기억보다 우선한다.' \
  "${FAKE_AGY_PROMPT_LOG}" >/dev/null

printf 'OK: AGY exact session 재개, node 격리, 만료 복구, max-turn 회전, 절대 경로 경계를 검증했습니다.\n'
