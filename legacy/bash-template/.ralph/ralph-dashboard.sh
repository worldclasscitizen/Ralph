#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVER="${SCRIPT_DIR}/dashboard/server.py"

usage() {
  printf '%s\n' \
    'Usage: .ralph/ralph-dashboard.sh [--open] [--port PORT] [--check]' \
    '' \
    '  --open       기본 브라우저에서 로컬 대시보드를 연다.' \
    '  --port PORT  로컬 포트. 기본값은 7331이다.' \
    '  --check      서버를 띄우지 않고 파일과 snapshot 생성을 검사한다.' \
    '  --help       이 도움말을 출력한다.'
}

args=(--project-root "${PROJECT_ROOT}")
while [[ $# -gt 0 ]]; do
  case "$1" in
    --open|--check)
      args+=("$1")
      shift
      ;;
    --port)
      if [[ $# -lt 2 || ! "$2" =~ ^[0-9]+$ ]]; then
        printf 'ERROR: --port 뒤에 숫자가 필요합니다.\n' >&2
        exit 2
      fi
      args+=(--port "$2")
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

if ! command -v python3 >/dev/null 2>&1; then
  printf 'ERROR: Python 3가 필요합니다.\n' >&2
  exit 2
fi

exec python3 "${SERVER}" "${args[@]}"
