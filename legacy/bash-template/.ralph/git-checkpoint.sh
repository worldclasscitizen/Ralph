#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${RALPH_PROJECT_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
RUN_DIR="${RALPH_RUN_DIR:-}"

usage() {
  printf '%s\n' \
    'Usage:' \
    '  .ralph/git-checkpoint.sh prepare' \
    '  .ralph/git-checkpoint.sh commit ITERATION TASK RUN_ID STATUS SCORE WORKER_RC VERIFY_RC VERDICT PREFIX'
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 8
}

ensure_repository() {
  git -C "${PROJECT_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1 || \
    fail "Ralph Git checkpoint는 Git 저장소에서만 실행할 수 있습니다: ${PROJECT_ROOT}"
  git -C "${PROJECT_ROOT}" rev-parse --verify HEAD >/dev/null 2>&1 || \
    fail 'Ralph 실행 전에 기준 커밋이 하나 이상 필요합니다.'
}

ensure_branch_and_no_git_operation() {
  local marker
  local marker_path

  git -C "${PROJECT_ROOT}" symbolic-ref --quiet --short HEAD >/dev/null 2>&1 || \
    fail 'detached HEAD에서는 Ralph checkpoint를 만들지 않습니다. 작업 브랜치로 전환하세요.'

  for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
    if git -C "${PROJECT_ROOT}" rev-parse --quiet --verify "${marker}" >/dev/null 2>&1; then
      fail "진행 중인 Git 작업(${marker})을 먼저 끝내거나 취소하세요."
    fi
  done

  for marker in rebase-merge rebase-apply; do
    marker_path="$(git -C "${PROJECT_ROOT}" rev-parse --git-path "${marker}")"
    if [[ -e "${marker_path}" ]]; then
      fail "진행 중인 Git rebase(${marker})를 먼저 끝내거나 취소하세요."
    fi
  done
}

is_sensitive_path() {
  local path="$1"
  case "${path}" in
    .env.example|*/.env.example)
      return 1
      ;;
    .env|.env.*|*/.env|*/.env.*|credentials.json|*/credentials.json|\
    .antigravity/config.local.json|.ralph/commands.local.sh|.ralph/OPERATOR_NOTE.local.md|\
    *.pem|*.key|*.p12|*.pfx)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

validate_path_stream() {
  local path
  local invalid=0
  while IFS= read -r -d '' path; do
    if is_sensitive_path "${path}"; then
      printf 'ERROR: 자동 checkpoint에서 민감 파일 경로를 커밋하지 않습니다: %s\n' "${path}" >&2
      invalid=1
    fi
  done
  [[ "${invalid}" -eq 0 ]]
}

validate_pending_paths() {
  local invalid=0
  validate_path_stream < <(git -C "${PROJECT_ROOT}" diff --name-only -z) || invalid=1
  validate_path_stream < <(git -C "${PROJECT_ROOT}" diff --cached --name-only -z) || invalid=1
  validate_path_stream < <(git -C "${PROJECT_ROOT}" ls-files --others --exclude-standard -z) || invalid=1
  [[ "${invalid}" -eq 0 ]]
}

unstage_checkpoint_changes() {
  git -C "${PROJECT_ROOT}" restore --staged -- . >/dev/null 2>&1 || true
}

prepare_checkpoint_run() {
  local status_output
  local branch
  local baseline
  local metadata_tmp

  ensure_repository
  ensure_branch_and_no_git_operation
  git -C "${PROJECT_ROOT}" var GIT_AUTHOR_IDENT >/dev/null 2>&1 || \
    fail 'Git user.name과 user.email을 설정한 뒤 Ralph를 실행하세요.'

  status_output="$(git -C "${PROJECT_ROOT}" status --porcelain=v1 --untracked-files=all)"
  if [[ -n "${status_output}" ]]; then
    printf '%s\n' "${status_output}" >&2
    fail 'Ralph는 깨끗한 Git 기준점에서만 시작합니다. 현재 변경을 검토하고 먼저 커밋하세요.'
  fi

  branch="$(git -C "${PROJECT_ROOT}" symbolic-ref --quiet --short HEAD)"
  baseline="$(git -C "${PROJECT_ROOT}" rev-parse HEAD)"
  if [[ -n "${RUN_DIR}" ]]; then
    mkdir -p "${RUN_DIR}"
    metadata_tmp="${RUN_DIR}/git-baseline.json.tmp"
    jq -n \
      --arg branch "${branch}" \
      --arg baselineCommit "${baseline}" \
      '{branch:$branch,baselineCommit:$baselineCommit}' > "${metadata_tmp}"
    mv "${metadata_tmp}" "${RUN_DIR}/git-baseline.json"
  fi
  jq -nc --arg branch "${branch}" --arg baselineCommit "${baseline}" \
    '{branch:$branch,baselineCommit:$baselineCommit}'
}

commit_iteration() {
  local iteration="$1"
  local task="$2"
  local run_id="$3"
  local status="$4"
  local score="$5"
  local worker_rc="$6"
  local verify_rc="$7"
  local verdict="$8"
  local prefix="$9"
  local secret_files
  local commit_sha
  local parent_sha
  local metadata_tmp
  local prefix_pattern='^[A-Za-z0-9._()/ -]+$'

  [[ "${iteration}" =~ ^[1-9][0-9]*$ ]] || fail 'checkpoint iteration은 양의 정수여야 합니다.'
  [[ "${score}" =~ ^([0-9]|[1-9][0-9]|100)$ ]] || fail 'checkpoint score는 0..100 정수여야 합니다.'
  [[ "${worker_rc}" =~ ^-?[0-9]+$ && "${verify_rc}" =~ ^-?[0-9]+$ ]] || \
    fail 'checkpoint exit code가 정수가 아닙니다.'
  [[ "${task}" =~ ^[a-z0-9_]+$ && "${run_id}" =~ ^[A-Za-z0-9._-]+$ && \
     "${status}" =~ ^[a-z0-9_]+$ && "${verdict}" =~ ^[a-z]+$ ]] || \
    fail 'checkpoint 메타데이터에 허용되지 않은 문자가 있습니다.'
  [[ "${prefix}" =~ ${prefix_pattern} ]] || fail 'checkpoint commitMessagePrefix가 안전하지 않습니다.'

  ensure_repository
  ensure_branch_and_no_git_operation
  if ! validate_pending_paths; then
    fail '민감 파일을 제거하거나 안전한 예제 파일로 바꾼 뒤 다시 실행하세요.'
  fi

  git -C "${PROJECT_ROOT}" add -A -- .
  if ! git -C "${PROJECT_ROOT}" diff --cached --check; then
    unstage_checkpoint_changes
    fail 'staged diff 검사에 실패해 checkpoint를 만들지 않았습니다.'
  fi

  secret_files="$(git -C "${PROJECT_ROOT}" grep --cached -Il -E \
    '(sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[0-9A-Za-z]{20,}|github_pat_[0-9A-Za-z_]{20,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)' \
    -- . ':(exclude)*.example' 2>/dev/null || true)"
  if [[ -n "${secret_files}" ]]; then
    printf '%s\n' "${secret_files}" >&2
    unstage_checkpoint_changes
    fail '비밀값으로 의심되는 staged 파일이 있어 checkpoint를 중단했습니다.'
  fi

  git -C "${PROJECT_ROOT}" commit --allow-empty \
    -m "${prefix}: ${task} iteration ${iteration} ${status}" \
    -m "Ralph-Run: ${run_id}
Ralph-Task: ${task}
Ralph-Iteration: ${iteration}
Worker-Exit: ${worker_rc}
Verifier-Exit: ${verify_rc}
Critic-Verdict: ${verdict}
Critic-Score: ${score}" >&2

  commit_sha="$(git -C "${PROJECT_ROOT}" rev-parse HEAD)"
  parent_sha="$(git -C "${PROJECT_ROOT}" rev-parse HEAD^)"
  if [[ -n "$(git -C "${PROJECT_ROOT}" status --porcelain=v1 --untracked-files=all)" ]]; then
    fail 'checkpoint commit 후 작업 트리가 깨끗하지 않습니다. Git hook이 추가 변경을 만들었는지 확인하세요.'
  fi
  if [[ -n "${RUN_DIR}" ]]; then
    mkdir -p "${RUN_DIR}"
    metadata_tmp="${RUN_DIR}/git-checkpoint-${iteration}.json.tmp"
    jq -n \
      --arg commit "${commit_sha}" \
      --arg parent "${parent_sha}" \
      --arg task "${task}" \
      --arg runId "${run_id}" \
      --arg status "${status}" \
      --arg verdict "${verdict}" \
      --argjson iteration "${iteration}" \
      --argjson score "${score}" \
      --argjson workerExit "${worker_rc}" \
      --argjson verifierExit "${verify_rc}" \
      '{commit:$commit,parent:$parent,task:$task,runId:$runId,status:$status,iteration:$iteration,criticScore:$score,criticVerdict:$verdict,workerExit:$workerExit,verifierExit:$verifierExit}' \
      > "${metadata_tmp}"
    mv "${metadata_tmp}" "${RUN_DIR}/git-checkpoint-${iteration}.json"
  fi
  printf '%s\n' "${commit_sha}"
}

action="${1:-}"
case "${action}" in
  prepare)
    [[ "$#" -eq 1 ]] || { usage >&2; exit 2; }
    prepare_checkpoint_run
    ;;
  commit)
    shift
    [[ "$#" -eq 9 ]] || { usage >&2; exit 2; }
    commit_iteration "$@"
    ;;
  --help|-h)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
