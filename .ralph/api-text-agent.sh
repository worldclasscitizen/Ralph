#!/usr/bin/env bash
set -Eeuo pipefail

# 텍스트 출력만 필요한 Critic/Meta-Prompter용 OpenAI-compatible API 어댑터다.
# 저장소를 직접 수정해야 하는 Worker에는 이 스크립트를 사용하지 않는다.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"

PROVIDER="${1:-}"
MODEL_ID="${2:-}"
EFFORT="${3:-high}"

if [[ -z "${PROVIDER}" || -z "${MODEL_ID}" ]]; then
  printf 'Usage: .ralph/api-text-agent.sh <deepseek|glm-general> <model-id> [effort]\n' >&2
  exit 2
fi

if [[ -f "${ENV_FILE}" ]]; then
  # 이 파일은 사용자가 직접 관리하는 신뢰된 로컬 환경 파일이다.
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
fi

case "${PROVIDER}" in
  deepseek)
    API_KEY="${DEEPSEEK_API_KEY:-}"
    BASE_URL="${DEEPSEEK_BASE_URL:-https://api.deepseek.com}"
    ;;
  glm-general)
    API_KEY="${GLM_GENERAL_API_KEY:-}"
    BASE_URL="${GLM_GENERAL_BASE_URL:-https://api.z.ai/api/paas/v4}"
    ;;
  *)
    printf 'ERROR: 지원하지 않는 provider입니다: %s\n' "${PROVIDER}" >&2
    exit 2
    ;;
esac

if [[ -z "${API_KEY}" ]]; then
  printf 'ERROR: %s API 키가 .env에 설정되지 않았습니다.\n' "${PROVIDER}" >&2
  exit 2
fi

PROMPT_BODY="$(cat)"
if [[ -z "${PROMPT_BODY}" ]]; then
  printf 'ERROR: stdin 프롬프트가 비어 있습니다.\n' >&2
  exit 2
fi

TEMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TEMP_DIR}"
}
trap cleanup EXIT INT TERM

REQUEST_FILE="${TEMP_DIR}/request.json"
RESPONSE_FILE="${TEMP_DIR}/response.json"
AUTH_HEADER_FILE="${TEMP_DIR}/authorization.header"
CONNECT_TIMEOUT_SECONDS="${RALPH_API_CONNECT_TIMEOUT_SECONDS:-15}"
MAX_TIME_SECONDS="${RALPH_API_MAX_TIME_SECONDS:-180}"

umask 077
printf 'Authorization: Bearer %s\n' "${API_KEY}" > "${AUTH_HEADER_FILE}"

jq -n \
  --arg model "${MODEL_ID}" \
  --arg content "${PROMPT_BODY}" \
  --arg effort "${EFFORT}" \
  '{
    model: $model,
    messages: [{role: "user", content: $content}],
    thinking: {type: "enabled"},
    reasoning_effort: $effort,
    stream: false
  }' > "${REQUEST_FILE}"

set +e
curl_rc=0
http_status="$(curl --silent --show-error --fail-with-body \
  --connect-timeout "${CONNECT_TIMEOUT_SECONDS}" \
  --max-time "${MAX_TIME_SECONDS}" \
  --request POST \
  --url "${BASE_URL%/}/chat/completions" \
  --header "@${AUTH_HEADER_FILE}" \
  --header 'Content-Type: application/json' \
  --data-binary "@${REQUEST_FILE}" \
  --output "${RESPONSE_FILE}" \
  --write-out '%{http_code}')" || curl_rc=$?
set -e

if [[ "${curl_rc}" -ne 0 ]]; then
  error_message="$(jq -r '.error.message // .message // "API request failed"' "${RESPONSE_FILE}" 2>/dev/null || true)"
  printf 'ERROR: %s 요청 실패(http=%s curl=%s): %s\n' \
    "${PROVIDER}" "${http_status:-000}" "${curl_rc}" "${error_message}" >&2
  exit "${curl_rc}"
fi

CONTENT="$(jq -r '.choices[0].message.content // empty' "${RESPONSE_FILE}")"
if [[ -z "${CONTENT}" ]]; then
  error_message="$(jq -r '.error.message // .message // "응답 content 없음"' "${RESPONSE_FILE}" 2>/dev/null || true)"
  printf 'ERROR: %s\n' "${error_message}" >&2
  exit 4
fi

printf '%s\n' "${CONTENT}"
