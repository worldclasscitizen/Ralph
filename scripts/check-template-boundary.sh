#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

unexpected_paths=()
while IFS= read -r path; do
  case "${path}" in
    .github/*|assets/*|docs/*|integrations/*|legacy/*|scripts/*|src/*|tests/*|.env.example|.gitignore|AGENTS.md|CLAUDE.md|GEMINI.md|LICENSE|README.md|README.ko.md|START_HERE.md|package.json|package-lock.json|tsconfig.json)
      ;;
    *)
      unexpected_paths+=("${path}")
      ;;
  esac
done < <(git ls-files --cached --others --exclude-standard)

if (( ${#unexpected_paths[@]} > 0 )); then
  printf 'ERROR: 범용 오케스트레이션 허용 목록 밖의 추적 파일이 있습니다.\n' >&2
  printf '  - %s\n' "${unexpected_paths[@]}" >&2
  exit 1
fi

if git ls-files --cached --others --exclude-standard | rg -v '^legacy/bash-template/\.ralph/tests/' | rg -q '(^|/)(runs|logs|__pycache__)(/|$)|(^|/)state\.json$|config\.local\.json$|commands\.local\.sh$|OPERATOR_NOTE\.local\.md$'; then
  printf 'ERROR: 개인 설정 또는 실행 상태 파일이 Git에 추적되어 있습니다.\n' >&2
  exit 1
fi

printf 'OK: 추적 파일이 범용 npm 오케스트레이션 패키지 경계 안에 있습니다.\n'
