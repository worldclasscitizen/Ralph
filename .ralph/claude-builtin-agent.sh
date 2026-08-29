#!/usr/bin/env bash
set -Eeuo pipefail

# Claude.ai 구독으로 로그인된 Claude Code만 사용하는 stdin/stdout 어댑터다.
# Anthropic API나 GLM 호환 endpoint 환경변수는 이 프로세스에서 제거한다.

MODEL_ID="${1:-}"
EFFORT="${2:-high}"
PERMISSION_MODE="${3:-plan}"
CLAUDE_BIN="${RALPH_CLAUDE_BIN:-$(command -v claude || true)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "${MODEL_ID}" ]]; then
  printf 'Usage: .ralph/claude-builtin-agent.sh <model-id> [low|medium|high|max] [plan|acceptEdits]\n' >&2
  exit 2
fi

case "${EFFORT}" in
  low|medium|high|max) ;;
  *)
    printf 'ERROR: Claude Code effort는 low, medium, high, max 중 하나여야 합니다: %s\n' "${EFFORT}" >&2
    exit 2
    ;;
esac

case "${PERMISSION_MODE}" in
  plan|acceptEdits) ;;
  *)
    printf 'ERROR: Claude Code permission mode는 plan 또는 acceptEdits여야 합니다: %s\n' "${PERMISSION_MODE}" >&2
    exit 2
    ;;
esac

if [[ -z "${CLAUDE_BIN}" || ! -x "${CLAUDE_BIN}" ]]; then
  printf 'ERROR: Claude Code CLI를 찾을 수 없습니다. claude를 설치하고 로그인하세요.\n' >&2
  exit 69
fi

clean_env=(env
  -u ANTHROPIC_API_KEY
  -u ANTHROPIC_AUTH_TOKEN
  -u ANTHROPIC_BASE_URL
  -u ANTHROPIC_DEFAULT_OPUS_MODEL
  -u ANTHROPIC_DEFAULT_SONNET_MODEL
  -u ANTHROPIC_DEFAULT_HAIKU_MODEL
  -u CLAUDE_CODE_USE_BEDROCK
  -u CLAUDE_CODE_USE_VERTEX
  -u CLAUDE_CODE_USE_FOUNDRY
)

set +e
AUTH_STATUS="$("${clean_env[@]}" "${CLAUDE_BIN}" --setting-sources '' auth status 2>/dev/null)"
auth_rc=$?
set -e
if [[ "${auth_rc}" -ne 0 ]] || ! jq -e '
  .loggedIn == true and
  .authMethod == "claude.ai" and
  .apiProvider == "firstParty"
' <<<"${AUTH_STATUS}" >/dev/null 2>&1; then
  printf 'ERROR: Claude.ai 구독 로그인이 확인되지 않았습니다. claude auth login 후 다시 실행하세요.\n' >&2
  exit 77
fi

claude_args=(
  --print
  --model "${MODEL_ID}"
  --effort "${EFFORT}"
  --permission-mode "${PERMISSION_MODE}"
  --output-format json
  --no-session-persistence
  --no-chrome
  --disable-slash-commands
  --setting-sources ""
  --strict-mcp-config
  --mcp-config '{"mcpServers":{}}'
)

if [[ "${PERMISSION_MODE}" == "plan" ]]; then
  claude_args+=(--tools "")
else
  claude_args+=(--tools default)
fi

TEMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "${TEMP_DIR}"; }
trap cleanup EXIT INT TERM
RESULT_FILE="${TEMP_DIR}/result.json"
ERROR_FILE="${TEMP_DIR}/stderr.log"

set +e
"${clean_env[@]}" "${CLAUDE_BIN}" "${claude_args[@]}" >"${RESULT_FILE}" 2>"${ERROR_FILE}"
command_rc=$?
set -e
sed -n '1,160p' "${ERROR_FILE}" >&2
if [[ "${command_rc}" -ne 0 ]]; then
  sed -n '1,80p' "${RESULT_FILE}" >&2
  exit "${command_rc}"
fi
if ! jq -e 'type == "object"' "${RESULT_FILE}" >/dev/null 2>&1; then
  printf 'ERROR: Claude Code JSON 결과를 해석하지 못했습니다.\n' >&2
  exit 4
fi

jq -nc \
  --arg provider anthropic \
  --arg modelAlias "${RALPH_MODEL_ALIAS:-}" \
  --arg modelId "${MODEL_ID}" \
  --arg source claude_code_json \
  --slurpfile result "${RESULT_FILE}" \
  '{provider:$provider,modelAlias:$modelAlias,modelId:$modelId,source:$source,usage:($result[0].usage // {})}' \
  | python3 "${SCRIPT_DIR}/record-usage.py" || true

RESPONSE_TEXT="$(jq -r '.result // .response // ""' "${RESULT_FILE}")"
if [[ -z "$(printf '%s' "${RESPONSE_TEXT}" | tr -d '[:space:]')" ]]; then
  printf 'ERROR: Claude Code가 성공했지만 최종 응답 본문이 비어 있습니다.\n' >&2
  printf '%s\n' 'RALPH_AGENT_ERROR {"class":"empty_response","source":"claude"}' >&2
  exit 74
fi
printf '%s\n' "${RESPONSE_TEXT}"
