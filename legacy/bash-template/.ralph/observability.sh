#!/usr/bin/env bash

# Ralph의 판단이나 종료 코드에 영향을 주지 않는 best-effort 관찰 이벤트 기록기다.
# 이 파일의 모든 공개 함수는 기록 실패와 무관하게 항상 성공을 반환해야 한다.

RALPH_OBSERVE_EVENTS_FILE=""
RALPH_OBSERVE_RUN_FILE=""
RALPH_OBSERVE_RUN_ID=""
RALPH_OBSERVE_TASK=""
RALPH_OBSERVE_PROJECT_ROOT=""

ralph_observe_init() {
  RALPH_OBSERVE_EVENTS_FILE="$1"
  RALPH_OBSERVE_RUN_FILE="$2"
  RALPH_OBSERVE_RUN_ID="$3"
  RALPH_OBSERVE_TASK="$4"
  RALPH_OBSERVE_PROJECT_ROOT="$5"
  { mkdir -p "$(dirname "${RALPH_OBSERVE_EVENTS_FILE}")" && touch "${RALPH_OBSERVE_EVENTS_FILE}"; } 2>/dev/null || true
  return 0
}

ralph_observe_event() {
  local event_type="${1:-event}"
  local iteration="${2:-0}"
  local stage="${3:-run}"
  local status="${4:-info}"
  local role="${5:-}"
  local model_alias="${6:-}"
  local attempt="${7:-0}"
  local summary="${8:-}"
  local artifact="${9:-}"
  local score="${10:-}"
  local verdict="${11:-}"
  local payload=""

  if [[ -z "${RALPH_OBSERVE_EVENTS_FILE}" ]] || ! command -v jq >/dev/null 2>&1; then
    return 0
  fi
  [[ "${iteration}" =~ ^[0-9]+$ ]] || iteration=0
  [[ "${attempt}" =~ ^[0-9]+$ ]] || attempt=0

  payload="$(jq -nc \
    --arg id "$(date -u '+%Y%m%dT%H%M%SZ')-$$-${RANDOM:-0}" \
    --arg timestamp "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --arg type "${event_type}" \
    --arg runId "${RALPH_OBSERVE_RUN_ID}" \
    --arg task "${RALPH_OBSERVE_TASK}" \
    --arg stage "${stage}" \
    --arg status "${status}" \
    --arg role "${role}" \
    --arg modelAlias "${model_alias}" \
    --arg summary "${summary}" \
    --arg artifact "${artifact}" \
    --arg score "${score}" \
    --arg verdict "${verdict}" \
    --argjson iteration "${iteration}" \
    --argjson attempt "${attempt}" \
    '{id:$id,timestamp:$timestamp,type:$type,runId:$runId,task:$task,iteration:$iteration,stage:$stage,status:$status,role:$role,modelAlias:$modelAlias,attempt:$attempt,summary:$summary,artifact:$artifact,score:(if $score == "" then null else ($score|tonumber? // $score) end),verdict:(if $verdict == "" then null else $verdict end)}' \
    2>/dev/null || true)"
  if [[ -n "${payload}" ]]; then
    printf '%s\n' "${payload}" >> "${RALPH_OBSERVE_EVENTS_FILE}" 2>/dev/null || true
  fi
  return 0
}

ralph_observe_run_metadata() {
  local max_iterations="${1:-0}"
  local minimum_score="${2:-0}"
  local baseline_commit="${3:-}"
  local branch="${4:-}"
  local route_json="${5:-null}"
  local run_directory="${6:-}"
  local tmp_file=""

  if [[ -z "${RALPH_OBSERVE_RUN_FILE}" ]] || ! command -v jq >/dev/null 2>&1; then
    return 0
  fi
  [[ "${max_iterations}" =~ ^[0-9]+$ ]] || max_iterations=0
  [[ "${minimum_score}" =~ ^[0-9]+$ ]] || minimum_score=0
  if ! jq -e . >/dev/null 2>&1 <<<"${route_json}"; then
    route_json='null'
  fi

  tmp_file="${RALPH_OBSERVE_RUN_FILE}.tmp.$$"
  jq -n \
    --arg runId "${RALPH_OBSERVE_RUN_ID}" \
    --arg task "${RALPH_OBSERVE_TASK}" \
    --arg projectRoot "${RALPH_OBSERVE_PROJECT_ROOT}" \
    --arg runDirectory "${run_directory}" \
    --arg startedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --arg branch "${branch}" \
    --arg baselineCommit "${baseline_commit}" \
    --argjson maxIterations "${max_iterations}" \
    --argjson minimumCriticScore "${minimum_score}" \
    --argjson route "${route_json}" \
    '{schemaVersion:1,runId:$runId,task:$task,projectRoot:$projectRoot,runDirectory:$runDirectory,startedAt:$startedAt,branch:$branch,baselineCommit:$baselineCommit,maxIterations:$maxIterations,minimumCriticScore:$minimumCriticScore,route:$route}' \
    > "${tmp_file}" 2>/dev/null || true
  if [[ -s "${tmp_file}" ]]; then
    mv "${tmp_file}" "${RALPH_OBSERVE_RUN_FILE}" 2>/dev/null || true
  else
    rm -f "${tmp_file}" 2>/dev/null || true
  fi
  return 0
}
