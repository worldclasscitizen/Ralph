#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/git-checkpoint.sh"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ralph-git-checkpoint-test.XXXXXX")"
REPO="${TEMP_ROOT}/repo"
RUN_DIR="${TEMP_ROOT}/runs/test-run"

cleanup() {
  rm -rf "${TEMP_ROOT}"
}
trap cleanup EXIT INT TERM

mkdir -p "${REPO}" "${RUN_DIR}"
git -C "${REPO}" init -q
git -C "${REPO}" config user.name 'Ralph Test'
git -C "${REPO}" config user.email 'ralph-test@example.invalid'
printf 'baseline\n' > "${REPO}/tracked.txt"
git -C "${REPO}" add tracked.txt
git -C "${REPO}" commit -q -m 'test: baseline'

RALPH_PROJECT_ROOT="${REPO}" RALPH_RUN_DIR="${RUN_DIR}" \
  "${HELPER}" prepare > "${TEMP_ROOT}/prepare.json"
jq -e '.branch == "main" or .branch == "master"' "${TEMP_ROOT}/prepare.json" >/dev/null
jq -e '.baselineCommit | length == 40' "${RUN_DIR}/git-baseline.json" >/dev/null

printf 'iteration one\n' > "${REPO}/tracked.txt"
printf 'new file\n' > "${REPO}/created.txt"
checkpoint_one="$(
  RALPH_PROJECT_ROOT="${REPO}" RALPH_RUN_DIR="${RUN_DIR}" \
    "${HELPER}" commit 1 backend_core test-run retrying 70 0 1 fail 'chore(ralph)'
)"
[[ "${checkpoint_one}" =~ ^[0-9a-f]{40}$ ]]
[[ "$(git -C "${REPO}" rev-list --count HEAD)" -eq 2 ]]
[[ "$(git -C "${REPO}" log -1 --pretty=%s)" == 'chore(ralph): backend_core iteration 1 retrying' ]]
[[ -z "$(git -C "${REPO}" status --porcelain=v1 --untracked-files=all)" ]]
jq -e --arg commit "${checkpoint_one}" \
  '.commit == $commit and .iteration == 1 and .status == "retrying" and .criticScore == 70' \
  "${RUN_DIR}/git-checkpoint-1.json" >/dev/null

checkpoint_two="$(
  RALPH_PROJECT_ROOT="${REPO}" RALPH_RUN_DIR="${RUN_DIR}" \
    "${HELPER}" commit 2 backend_core test-run passed 95 0 0 pass 'chore(ralph)'
)"
[[ "${checkpoint_two}" =~ ^[0-9a-f]{40}$ ]]
[[ "$(git -C "${REPO}" rev-list --count HEAD)" -eq 3 ]]
[[ "$(git -C "${REPO}" diff-tree --no-commit-id --name-only -r HEAD | wc -l | tr -d ' ')" -eq 0 ]]

printf 'dirty\n' >> "${REPO}/tracked.txt"
if RALPH_PROJECT_ROOT="${REPO}" RALPH_RUN_DIR="${RUN_DIR}" \
  "${HELPER}" prepare >/dev/null 2> "${TEMP_ROOT}/dirty.err"; then
  printf 'ERROR: dirty worktree에서 prepare가 성공했습니다.\n' >&2
  exit 1
fi
git -C "${REPO}" restore tracked.txt

printf '{"private_key":"not-a-real-key"}\n' > "${REPO}/credentials.json"
git -C "${REPO}" add credentials.json
if RALPH_PROJECT_ROOT="${REPO}" RALPH_RUN_DIR="${RUN_DIR}" \
  "${HELPER}" commit 3 backend_core test-run retrying 40 0 1 fail 'chore(ralph)' \
  >/dev/null 2> "${TEMP_ROOT}/sensitive.err"; then
  printf 'ERROR: 민감 파일 경로가 checkpoint에 포함됐습니다.\n' >&2
  exit 1
fi
[[ "$(git -C "${REPO}" rev-list --count HEAD)" -eq 3 ]]

printf 'OK: clean baseline, 이터레이션별 empty 포함 commit, 민감 파일 차단을 검증했습니다.\n'
