#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_ROOT="${1:-}"

usage() {
  printf 'Usage: %s /absolute/path/to/git-project\n' "$0"
}

if [[ -z "${TARGET_ROOT}" || "${TARGET_ROOT}" != /* ]]; then
  usage >&2
  exit 2
fi
if [[ ! -d "${TARGET_ROOT}" ]]; then
  printf 'ERROR: 대상 디렉터리가 없습니다: %s\n' "${TARGET_ROOT}" >&2
  exit 2
fi
if ! git -C "${TARGET_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'ERROR: 대상은 Git 저장소여야 합니다: %s\n' "${TARGET_ROOT}" >&2
  exit 2
fi

TARGET_ROOT="$(cd "${TARGET_ROOT}" && pwd)"
if [[ "${TARGET_ROOT}" == "${TEMPLATE_ROOT}" ]]; then
  printf 'ERROR: 템플릿 저장소 자체에는 설치할 수 없습니다.\n' >&2
  exit 2
fi

for protected_target in "${TARGET_ROOT}/.ralph" "${TARGET_ROOT}/.antigravity"; do
  if [[ -e "${protected_target}" ]]; then
    printf 'ERROR: 기존 제어 파일을 덮어쓰지 않습니다: %s\n' "${protected_target}" >&2
    exit 2
  fi
done

cp -pR "${TEMPLATE_ROOT}/.ralph" "${TARGET_ROOT}/.ralph"
cp -pR "${TEMPLATE_ROOT}/.antigravity" "${TARGET_ROOT}/.antigravity"
mkdir -p "${TARGET_ROOT}/docs"
cp -p "${TEMPLATE_ROOT}/docs/RALPH_CONTROL_CENTER.md" "${TARGET_ROOT}/docs/RALPH_CONTROL_CENTER.md"
cp -p "${TEMPLATE_ROOT}/START_HERE.md" "${TARGET_ROOT}/RALPH_START_HERE.md"

if [[ -e "${TARGET_ROOT}/.env.example" ]]; then
  cp -p "${TEMPLATE_ROOT}/.env.example" "${TARGET_ROOT}/.env.ralph.example"
  env_example='.env.ralph.example'
else
  cp -p "${TEMPLATE_ROOT}/.env.example" "${TARGET_ROOT}/.env.example"
  env_example='.env.example'
fi

IGNORE_MARKER='# Ralph orchestration local state'
touch "${TARGET_ROOT}/.gitignore"
if ! grep -F -q "${IGNORE_MARKER}" "${TARGET_ROOT}/.gitignore"; then
  {
    printf '\n%s\n' "${IGNORE_MARKER}"
    printf '%s\n' \
      '.antigravity/config.local.json' \
      '.ralph/commands.local.sh' \
      '.ralph/OPERATOR_NOTE.local.md' \
      '.ralph/runs/' \
      '.ralph/state.json' \
      '.ralph/.lock/' \
      '.env'
  } >> "${TARGET_ROOT}/.gitignore"
fi

printf 'OK: Ralph 제어면을 설치했습니다: %s\n' "${TARGET_ROOT}"
printf '다음: RALPH_START_HERE.md를 AI에게 읽히고 %s의 Provider 값을 검토하세요.\n' "${env_example}"
