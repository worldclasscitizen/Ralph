#!/usr/bin/env bash
set -Eeuo pipefail

# antigravity-agent.sh가 agy의 오류·빈 SUCCESS 응답을 Ralph 실패로 노출하는지 검증한다.
# 실제 agy 대신 PATH 앞에 가짜 agy를 두어 외부 호출 없이 돈다.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ralph-agy-test.XXXXXX")"
cleanup() {
  rm -rf "${TEMP_ROOT}"
}
trap cleanup EXIT INT TERM

mkdir -p "${TEMP_ROOT}/bin" "${TEMP_ROOT}/repo"
cat > "${TEMP_ROOT}/bin/agy" <<'FAKE'
#!/usr/bin/env bash
cat >/dev/null
case "${FAKE_AGY_SCENARIO:-quota}" in
  quota)
    # 실제 agy와 같이 quota 오류를 stderr가 아닌 stdout result event에 담는다.
    printf '%s\n' '{"event":"init","conversation_id":"test","init":{"model":"gemini-3.7-flash-high"}}'
    printf '%s\n' '{"event":"result","result":{"conversation_id":"test","status":"ERROR","response":"","error":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 165h16m5s.","num_turns":1}}'
    exit 1
    ;;
  empty)
    printf '%s\n' '{"event":"init","conversation_id":"test-empty","init":{"model":"gemini-3.7-flash-high"}}'
    printf '%s\n' '{"event":"result","result":{"conversation_id":"test-empty","status":"SUCCESS","response":"  ","num_turns":1}}'
    exit 0
    ;;
  success)
    printf '%s\n' '{"event":"init","conversation_id":"test-success","init":{"model":"gemini-3.7-flash-high"}}'
    printf '%s\n' '{"event":"result","result":{"conversation_id":"test-success","status":"SUCCESS","response":"VALID_CRITIC_JSON","num_turns":1}}'
    exit 0
    ;;
  *)
    exit 64
    ;;
esac
FAKE
chmod +x "${TEMP_ROOT}/bin/agy"

set +e
printf 'Reply with exactly: OK\n' | PATH="${TEMP_ROOT}/bin:${PATH}" \
  RALPH_PROJECT_ROOT="${TEMP_ROOT}/repo" \
  "${SCRIPT_DIR}/antigravity-agent.sh" gemini-3.7-flash-high plan high \
  > "${TEMP_ROOT}/stdout.log" 2> "${TEMP_ROOT}/stderr.log"
agent_rc=$?
set -e

if [[ "${agent_rc}" -eq 0 ]]; then
  printf 'ERROR: agy가 실패했는데 래퍼가 성공(0)으로 끝났습니다.\n' >&2
  exit 1
fi

if ! grep -q 'Individual quota reached' "${TEMP_ROOT}/stderr.log"; then
  printf 'ERROR: agy result.error가 래퍼 stderr로 전달되지 않았습니다. stderr:\n' >&2
  cat "${TEMP_ROOT}/stderr.log" >&2
  exit 1
fi

if ! grep -Eq '^RALPH_AGENT_ERROR \{.*"class":"rate_limit"' "${TEMP_ROOT}/stderr.log"; then
  printf 'ERROR: quota 오류가 RALPH_AGENT_ERROR class=rate_limit 구조로 표시되지 않았습니다. stderr:\n' >&2
  cat "${TEMP_ROOT}/stderr.log" >&2
  exit 1
fi

set +e
printf 'Critic JSON을 출력해.\n' | FAKE_AGY_SCENARIO=empty PATH="${TEMP_ROOT}/bin:${PATH}" \
  RALPH_PROJECT_ROOT="${TEMP_ROOT}/repo" \
  "${SCRIPT_DIR}/antigravity-agent.sh" gemini-3.7-flash-high plan high \
  > "${TEMP_ROOT}/stdout-empty.log" 2> "${TEMP_ROOT}/stderr-empty.log"
empty_rc=$?
set -e

if [[ "${empty_rc}" -eq 0 || -s "${TEMP_ROOT}/stdout-empty.log" ]]; then
  printf 'ERROR: 빈 SUCCESS 응답을 래퍼가 성공 또는 유효한 stdout으로 처리했습니다.\n' >&2
  exit 1
fi
if ! grep -Eq '^RALPH_AGENT_ERROR \{.*"class":"empty_response"' "${TEMP_ROOT}/stderr-empty.log"; then
  printf 'ERROR: 빈 SUCCESS 응답이 empty_response로 구조화되지 않았습니다. stderr:\n' >&2
  cat "${TEMP_ROOT}/stderr-empty.log" >&2
  exit 1
fi

printf 'Critic JSON을 출력해.\n' | FAKE_AGY_SCENARIO=success PATH="${TEMP_ROOT}/bin:${PATH}" \
  RALPH_PROJECT_ROOT="${TEMP_ROOT}/repo" \
  "${SCRIPT_DIR}/antigravity-agent.sh" gemini-3.7-flash-high plan high \
  > "${TEMP_ROOT}/stdout-success.log" 2> "${TEMP_ROOT}/stderr-success.log"
grep -qx 'VALID_CRITIC_JSON' "${TEMP_ROOT}/stdout-success.log"

printf 'OK: agy quota 오류와 빈 SUCCESS 응답을 구조화된 실패로 노출하고 정상 본문만 성공 처리합니다.\n'
