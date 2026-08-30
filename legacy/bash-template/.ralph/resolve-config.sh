#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEAM_CONFIG="${RALPH_TEAM_CONFIG:-${PROJECT_ROOT}/.antigravity/config.json}"
LOCAL_CONFIG="${RALPH_LOCAL_CONFIG:-${PROJECT_ROOT}/.antigravity/config.local.json}"

MODE="resolved"
TASK_ID=""
MODEL_ALIAS=""

usage() {
  printf '%s\n' \
    'Usage: .ralph/resolve-config.sh [--check|--resolved|--task TASK_ID|--model MODEL_ALIAS|--ralph]' \
    '' \
    '  --check       공용 규격에 대해 개인 설정의 모든 참조와 허용값을 검사한다.' \
    '  --resolved    공용 카탈로그와 개인 선택을 해석한 전체 JSON을 출력한다.' \
    '  --task ID     개인 taskPipelines에서 모델·추론 폴백 순서를 출력한다.' \
    '  --model ID    개인 설정에 선택된 모델 alias를 출력한다.' \
    '  --ralph       개인 Ralph 역할과 기본 실행 정책을 출력한다.'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      MODE="check"
      shift
      ;;
    --resolved)
      MODE="resolved"
      shift
      ;;
    --task)
      if [[ $# -lt 2 ]]; then
        printf 'ERROR: --task 뒤에 task ID가 필요합니다.\n' >&2
        exit 2
      fi
      MODE="task"
      TASK_ID="$2"
      shift 2
      ;;
    --model)
      if [[ $# -lt 2 ]]; then
        printf 'ERROR: --model 뒤에 model alias가 필요합니다.\n' >&2
        exit 2
      fi
      MODE="model"
      MODEL_ALIAS="$2"
      shift 2
      ;;
    --ralph)
      MODE="ralph"
      shift
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

if ! command -v jq >/dev/null 2>&1; then
  printf 'ERROR: jq가 필요합니다.\n' >&2
  exit 2
fi

for required_file in "${TEAM_CONFIG}" "${LOCAL_CONFIG}"; do
  if [[ ! -f "${required_file}" ]]; then
    printf 'ERROR: 필수 설정 파일이 없습니다: %s\n' "${required_file}" >&2
    exit 2
  fi
  jq empty "${required_file}"
done

team_version="$(jq -r '.schemaVersion // empty' "${TEAM_CONFIG}")"
team_kind="$(jq -r '.kind // empty' "${TEAM_CONFIG}")"
local_version="$(jq -r '.schemaVersion // empty' "${LOCAL_CONFIG}")"
local_kind="$(jq -r '.kind // empty' "${LOCAL_CONFIG}")"
local_spec="$(jq -r '.spec // empty' "${LOCAL_CONFIG}")"

if [[ "${team_version}" != "3.0" || "${local_version}" != "3.0" ]]; then
  printf 'ERROR: 공용 규격과 개인 설정의 schemaVersion은 모두 3.0이어야 합니다. spec=%s local=%s\n' \
    "${team_version:-missing}" "${local_version:-missing}" >&2
  exit 2
fi
if [[ "${team_kind}" != "ralph-orchestration-spec" ]]; then
  printf 'ERROR: config.json kind가 올바르지 않습니다: %s\n' "${team_kind:-missing}" >&2
  exit 2
fi
if [[ "${local_kind}" != "ralph-orchestration-local-config" ]]; then
  printf 'ERROR: config.local.json kind가 올바르지 않습니다: %s\n' "${local_kind:-missing}" >&2
  exit 2
fi
if [[ "${local_spec}" != "./config.json" ]]; then
  printf 'ERROR: config.local.json은 spec="./config.json"이어야 합니다.\n' >&2
  exit 2
fi

validation_errors="$(jq -nr \
  --slurpfile spec "${TEAM_CONFIG}" \
  --slurpfile local "${LOCAL_CONFIG}" '
  $spec[0] as $spec |
  $local[0] as $local |
  [
    if ($spec.providerCatalog | type) == "object" and ($spec.providerCatalog | length) > 0
      then empty else "공용 providerCatalog가 비어 있거나 객체가 아닙니다." end,
    if ($spec.modelCatalog | type) == "object" and ($spec.modelCatalog | length) > 0
      then empty else "공용 modelCatalog가 비어 있거나 객체가 아닙니다." end,
    if ($spec.taskCatalog | type) == "object" and ($spec.taskCatalog | length) > 0
      then empty else "공용 taskCatalog가 비어 있거나 객체가 아닙니다." end,
    if ($local.providers | type) == "object" and ($local.providers | length) > 0
      then empty else "개인 providers가 비어 있거나 객체가 아닙니다." end,
    if ($local.models | type) == "object" and ($local.models | length) > 0
      then empty else "개인 models가 비어 있거나 객체가 아닙니다." end,
    if ($local.taskPipelines | type) == "object" and ($local.taskPipelines | length) > 0
      then empty else "개인 taskPipelines가 비어 있거나 객체가 아닙니다." end,
    if ($spec.routingPolicy.maxAttemptsPerModel | type) == "number" and $spec.routingPolicy.maxAttemptsPerModel >= 1
      then empty else "공용 maxAttemptsPerModel은 1 이상의 정수여야 합니다." end,
    if ($spec.routingPolicy.initialBackoffSeconds | type) == "number" and
       ($spec.routingPolicy.maxBackoffSeconds | type) == "number" and
       $spec.routingPolicy.initialBackoffSeconds >= 0 and
       $spec.routingPolicy.maxBackoffSeconds >= $spec.routingPolicy.initialBackoffSeconds
      then empty else "공용 fallback backoff 범위가 올바르지 않습니다." end,
    if ($spec.routingPolicy.retryableErrors | type) == "array" and ($spec.routingPolicy.retryableErrors | length) > 0
      then empty else "공용 retryableErrors가 비어 있거나 배열이 아닙니다." end,
    if ($spec.workerHarnessPolicy.maxModelTurns | type) == "number" and
       ($spec.workerHarnessPolicy.maxToolCalls | type) == "number" and
       $spec.workerHarnessPolicy.maxModelTurns >= 1 and
       $spec.workerHarnessPolicy.maxToolCalls >= 1
      then empty else "공용 Worker harness 왕복·tool call 상한이 올바르지 않습니다." end,
    if ($spec.workerHarnessPolicy.protectedPaths | type) == "array" and
       ($spec.workerHarnessPolicy.protectedPaths | length) > 0
      then empty else "공용 Worker harness 보호 경로가 비어 있습니다." end,
    if ($spec.workerHarnessPolicy.verifier.argv | type) == "array" and
       ($spec.workerHarnessPolicy.verifier.argv | length) > 0
      then empty else "공용 Worker harness verifier가 비어 있습니다." end,
    if $spec.gitCheckpointPolicy.enabled == true and
       $spec.gitCheckpointPolicy.requireCleanWorktree == true and
       $spec.gitCheckpointPolicy.commitEveryIteration == true and
       $spec.gitCheckpointPolicy.allowEmptyCommits == true and
       $spec.gitCheckpointPolicy.autoPush == false and
       (($spec.gitCheckpointPolicy.commitMessagePrefix // "") | length) > 0
      then empty else "공용 Git checkpoint 정책은 clean 시작점·이터레이션별 커밋·autoPush 금지를 강제해야 합니다." end,
    if $spec.sessionPolicy.mode == "hybrid" and
       $spec.sessionPolicy.enabledAdapters == ["antigravity-agent"] and
       $spec.sessionPolicy.canonicalState == "files-and-git" and
       $spec.sessionPolicy.scope == "ralph-run-task-node-model" and
       $spec.sessionPolicy.isolateNodes == true and
       $spec.sessionPolicy.persistentRoles == ["metaPrompter", "worker"] and
       $spec.sessionPolicy.statelessRoles == ["critic"] and
       $spec.sessionPolicy.resumeByExactConversationId == true and
       $spec.sessionPolicy.neverUseMostRecentConversation == true and
       $spec.sessionPolicy.fallbackToFreshSession == true and
       ($spec.sessionPolicy.maxTurnsPerSession | type) == "number" and
       $spec.sessionPolicy.maxTurnsPerSession >= 1
      then empty else "공용 sessionPolicy는 파일·Git 우선, node/model 격리, exact conversation 재개를 강제해야 합니다." end,

    ($spec.providerCatalog | to_entries[] |
      . as $provider |
      if (($provider.value.connectionSpec.allowedModes // []) | index($provider.value.connectionSpec.defaults.mode // "")) == null
        then "Provider 기본 mode가 allowedModes에 없습니다: \($provider.key)"
      else empty end),

    ($spec.modelCatalog | to_entries[] |
      . as $model |
      if $spec.providerCatalog[$model.value.provider] == null
        then "공용 모델이 존재하지 않는 Provider를 참조합니다: \($model.key) -> \($model.value.provider)"
      elif (($model.value.reasoningSpec.allowedValues // []) | index($model.value.reasoningSpec.recommendedValue // "")) == null
        then "공용 모델 recommendedValue가 allowedValues에 없습니다: \($model.key)"
      else empty end),

    ($local.providers | to_entries[] |
      . as $provider |
      ($spec.providerCatalog[$provider.value.catalogProvider] // null) as $catalog |
      (($catalog.connectionSpec.defaults // {}) * ($provider.value.connection // {})) as $connection |
      if $provider.key != ($provider.value.catalogProvider // "")
        then "개인 Provider alias와 catalogProvider는 같아야 합니다: \($provider.key)"
      elif $catalog == null
        then "개인 Provider가 공용 catalog에 없습니다: \($provider.key)"
      elif $provider.value.enabled != true
        then "개인 providers에는 실제 사용할 Provider만 enabled=true로 작성합니다: \($provider.key)"
      elif (($catalog.connectionSpec.allowedModes // []) | index($connection.mode // "")) == null
        then "개인 Provider mode가 허용되지 않습니다: \($provider.key) -> \($connection.mode)"
      elif $connection.mode == "api" and (($connection.apiKeyEnv // "") | length) == 0
        then "API Provider에 apiKeyEnv가 없습니다: \($provider.key)"
      else empty end),

    ($local.models | to_entries[] |
      . as $selection |
      ($spec.modelCatalog[$selection.value.catalogModel] // null) as $catalog |
      if $catalog == null
        then "개인 모델이 공용 catalog에 없습니다: \($selection.key) -> \($selection.value.catalogModel)"
      elif $local.providers[$catalog.provider] == null
        then "개인 모델의 Provider가 providers에 선택되지 않았습니다: \($selection.key) -> \($catalog.provider)"
      elif (($catalog.reasoningSpec.allowedValues // []) | index($selection.value.reasoningEffort // "")) == null
        then "개인 reasoningEffort가 허용값이 아닙니다: \($selection.key) -> \($selection.value.reasoningEffort)"
      elif $catalog.provider == "anthropic" and
           (($local.providers.anthropic.connection.mode // $spec.providerCatalog.anthropic.connectionSpec.defaults.mode) == "builtin") and
           $selection.value.reasoningEffort == "xhigh"
        then "Claude Code builtin은 xhigh CLI 값을 지원하지 않습니다. max를 사용하세요: \($selection.key)"
      else empty end),

    ($spec.taskCatalog | keys[] as $task_id |
      if (($local.taskPipelines[$task_id] // []) | length) == 0
        then "개인 설정에 task pipeline이 없습니다: \($task_id)"
      else empty end),

    ($local.taskPipelines | to_entries[] |
      . as $pipeline |
      if $spec.taskCatalog[$pipeline.key] == null
        then "개인 설정이 존재하지 않는 task를 참조합니다: \($pipeline.key)"
      elif ($pipeline.value | type) != "array" or ($pipeline.value | length) == 0
        then "개인 task pipeline이 비어 있습니다: \($pipeline.key)"
      else empty end),

    ($local.taskPipelines | to_entries[] |
      . as $pipeline |
      $pipeline.value[]? as $model_alias |
      if $local.models[$model_alias] == null
        then "task pipeline이 선택하지 않은 모델 alias를 참조합니다: \($pipeline.key) -> \($model_alias)"
      else empty end),

    ("critic", "metaPrompter") as $role |
      if (($local.ralph.fallbackChains[$role] // []) | length) == 0
        then "Ralph 역할별 fallback chain이 비어 있습니다: \($role)"
      else empty end,
    ($local.ralph.fallbackChains // {} | to_entries[] |
      . as $chain |
      $chain.value[]? as $model_alias |
      if $local.models[$model_alias] == null
        then "Ralph fallback chain이 선택하지 않은 모델 alias를 참조합니다: \($chain.key) -> \($model_alias)"
      else empty end),
    if $spec.taskCatalog[$local.ralph.defaults.task] == null
      then "Ralph 기본 task가 공용 taskCatalog에 없습니다: \($local.ralph.defaults.task)" else empty end,
    if ($local.ralph.defaults.maxIterations | type) == "number" and $local.ralph.defaults.maxIterations >= 1
      then empty else "Ralph maxIterations는 1 이상의 정수여야 합니다." end,
    if ($local.ralph.defaults.minimumCriticScore | type) == "number" and
       $local.ralph.defaults.minimumCriticScore >= 0 and $local.ralph.defaults.minimumCriticScore <= 100
      then empty else "Ralph minimumCriticScore는 0..100이어야 합니다." end
  ] | .[]
')"

if [[ -n "${validation_errors}" ]]; then
  printf 'ERROR: 공용 규격과 개인 설정의 참조 무결성 검사에 실패했습니다.\n' >&2
  while IFS= read -r validation_error; do
    printf '  - %s\n' "${validation_error}" >&2
  done <<EOF
${validation_errors}
EOF
  exit 2
fi

resolved_file="$(mktemp "${TMPDIR:-/tmp}/ralph-orchestration-config.XXXXXX")"
cleanup() {
  rm -f "${resolved_file}"
}
trap cleanup EXIT INT TERM

jq -n \
  --slurpfile spec "${TEAM_CONFIG}" \
  --slurpfile local "${LOCAL_CONFIG}" '
  $spec[0] as $spec |
  $local[0] as $local |
  {
    schemaVersion: "3.0",
    kind: "ralph-orchestration-resolved-config",
    ownerLabel: $local.ownerLabel,
    routingPolicy: $spec.routingPolicy,
    workerHarnessPolicy: $spec.workerHarnessPolicy,
    gitCheckpointPolicy: $spec.gitCheckpointPolicy,
    sessionPolicy: $spec.sessionPolicy,
    providers: (
      reduce ($local.providers | to_entries[]) as $provider ({};
        .[$provider.key] = {
          catalogProvider: $provider.value.catalogProvider,
          label: $spec.providerCatalog[$provider.value.catalogProvider].label,
          enabled: true,
          connection: (
            $spec.providerCatalog[$provider.value.catalogProvider].connectionSpec.defaults
            * $provider.value.connection
          )
        }
      )
    ),
    models: (
      reduce ($local.models | to_entries[]) as $selection ({};
        ($spec.modelCatalog[$selection.value.catalogModel]) as $catalog |
        .[$selection.key] = {
          catalogModel: $selection.value.catalogModel,
          provider: $catalog.provider,
          modelId: $catalog.modelId,
          reasoning: {
            parameter: $catalog.reasoningSpec.parameter,
            value: $selection.value.reasoningEffort,
            allowedValues: $catalog.reasoningSpec.allowedValues
          },
          note: ($catalog.note // null)
        }
      )
    ),
    tasks: $spec.taskCatalog,
    taskPipelines: $local.taskPipelines,
    ralph: $local.ralph,
    resolution: {
      teamSpec: ".antigravity/config.json",
      personalConfig: ".antigravity/config.local.json",
      rule: "public-spec-validates-personal-selection"
    }
  }
' > "${resolved_file}"

case "${MODE}" in
  resolved)
    jq . "${resolved_file}"
    ;;
  task)
    if ! jq -e --arg task "${TASK_ID}" '.tasks[$task] != null' "${resolved_file}" >/dev/null; then
      printf 'ERROR: 지원하지 않는 task ID입니다: %s\n' "${TASK_ID}" >&2
      exit 2
    fi
    jq -c --arg task "${TASK_ID}" '
      . as $config |
      {
        taskId: $task,
        taskLabel: $config.tasks[$task].label,
        models: [
          $config.taskPipelines[$task][] as $alias |
          $config.models[$alias] |
          {
            alias: $alias,
            provider: .provider,
            modelId: .modelId,
            reasoning: .reasoning
          }
        ]
      }
    ' "${resolved_file}"
    ;;
  model)
    if ! jq -e --arg alias "${MODEL_ALIAS}" '.models[$alias] != null' "${resolved_file}" >/dev/null; then
      printf 'ERROR: 개인 설정에 선택되지 않은 model alias입니다: %s\n' "${MODEL_ALIAS}" >&2
      exit 2
    fi
    jq -c --arg alias "${MODEL_ALIAS}" '
      .models[$alias] | {alias: $alias, catalogModel, provider, modelId, reasoning}
    ' "${resolved_file}"
    ;;
  ralph)
    jq -c '.ralph' "${resolved_file}"
    ;;
  check)
    jq -r '
      . as $config |
      "OK: 공용 AI 규격과 개인 설정의 참조 무결성이 유효합니다.",
      "Owner: \($config.ownerLabel)",
      "Enabled providers: \($config.providers | keys | join(", "))",
      "Ralph critic fallback: \($config.ralph.fallbackChains.critic | join(" -> "))",
      "Ralph meta fallback: \($config.ralph.fallbackChains.metaPrompter | join(" -> "))",
      "Resolved personal task routes:",
      ($config.taskPipelines | to_entries[] |
        "  \(.key): " + ([.value[] as $alias | $config.models[$alias] |
          "\(.modelId)[\(.reasoning.value)]"] | join(" -> ")))
    ' "${resolved_file}"
    ;;
esac
