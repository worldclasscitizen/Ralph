#!/usr/bin/env bash
set -Eeuo pipefail

# 저장된 Codex 로그인으로 codex exec를 호출하고 최종 응답과 token usage를 분리한다.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_ID="${1:-}"
EFFORT="${2:-high}"
SANDBOX_MODE="${3:-read-only}"
CODEX_BIN="${RALPH_CODEX_BIN:-$(command -v codex || true)}"

if [[ -z "${MODEL_ID}" ]]; then
  printf 'Usage: .ralph/codex-builtin-agent.sh <model-id> [effort] [read-only|workspace-write]\n' >&2
  exit 2
fi
case "${EFFORT}" in
  none|low|medium|high|xhigh|max|ultra) ;;
  *) printf 'ERROR: 지원하지 않는 Codex reasoning effort입니다: %s\n' "${EFFORT}" >&2; exit 2 ;;
esac
case "${SANDBOX_MODE}" in
  read-only|workspace-write) ;;
  *) printf 'ERROR: Codex sandbox는 read-only 또는 workspace-write여야 합니다: %s\n' "${SANDBOX_MODE}" >&2; exit 2 ;;
esac
if [[ -z "${CODEX_BIN}" || ! -x "${CODEX_BIN}" ]]; then
  printf 'ERROR: Codex CLI를 찾을 수 없습니다. 설치 후 codex login을 실행하세요.\n' >&2
  exit 69
fi

TEMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "${TEMP_DIR}"; }
trap cleanup EXIT INT TERM
EVENTS_FILE="${TEMP_DIR}/events.jsonl"
RESPONSE_FILE="${TEMP_DIR}/response.txt"
ERROR_FILE="${TEMP_DIR}/stderr.log"

set +e
"${CODEX_BIN}" exec \
  --ephemeral \
  --sandbox "${SANDBOX_MODE}" \
  --model "${MODEL_ID}" \
  -c "model_reasoning_effort=\"${EFFORT}\"" \
  --color never \
  --json \
  --output-last-message "${RESPONSE_FILE}" \
  - >"${EVENTS_FILE}" 2>"${ERROR_FILE}"
command_rc=$?
set -e

sed -n '1,160p' "${ERROR_FILE}" >&2
if [[ "${command_rc}" -ne 0 ]]; then
  sed -n '1,80p' "${EVENTS_FILE}" >&2
  exit "${command_rc}"
fi

USAGE_JSON="$(jq -sc '
  [ .[] | select(.type == "turn.completed" and (.usage | type) == "object") | .usage ] as $rows |
  if ($rows | length) == 0 then {} else {
    input_tokens: ([$rows[]?.input_tokens // 0] | add // 0),
    cached_input_tokens: ([$rows[]?.cached_input_tokens // 0] | add // 0),
    output_tokens: ([$rows[]?.output_tokens // 0] | add // 0),
    reasoning_output_tokens: ([$rows[]?.reasoning_output_tokens // 0] | add // 0),
    total_tokens: ([$rows[]?.total_tokens // 0] | add // 0)
  } end
' "${EVENTS_FILE}" 2>/dev/null || printf '{}')"
jq -nc \
  --arg provider openai \
  --arg modelAlias "${RALPH_MODEL_ALIAS:-}" \
  --arg modelId "${MODEL_ID}" \
  --arg source codex_exec_json \
  --argjson usage "${USAGE_JSON}" \
  '{provider:$provider,modelAlias:$modelAlias,modelId:$modelId,source:$source,usage:$usage}' \
  | python3 "${SCRIPT_DIR}/record-usage.py" || true

if [[ ! -s "${RESPONSE_FILE}" ]]; then
  printf 'ERROR: Codex가 성공했지만 최종 응답 본문이 비어 있습니다.\n' >&2
  printf '%s\n' 'RALPH_AGENT_ERROR {"class":"empty_response","source":"codex"}' >&2
  exit 74
fi
cat "${RESPONSE_FILE}"
