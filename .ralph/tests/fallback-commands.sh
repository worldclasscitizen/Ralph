#!/usr/bin/env bash

TEST_COMMANDS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_AGENT="${TEST_COMMANDS_DIR}/../test-fallback-router.sh"

ralph_command_for() {
  local role="$1"
  local model_alias="$2"

  case "${role}:${model_alias}" in
    critic:gemini-flash|critic:openai-sol|metaPrompter:deepseek-pro|metaPrompter:openai-sol|worker:openai-sol|worker:openai-terra)
      printf "'%s' --fake-agent '%s' '%s'\n" "${TEST_AGENT}" "${role}" "${model_alias}"
      ;;
    *)
      return 1
      ;;
  esac
}

export RALPH_VERIFY_CMD='true'
