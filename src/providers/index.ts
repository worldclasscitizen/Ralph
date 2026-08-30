import type { ConnectionConfig, ProjectConfig, ProviderAdapter } from "../types.js";
import { AntigravityBuiltinAdapter, ClaudeBuiltinAdapter, CodexBuiltinAdapter, GeminiCliBuiltinAdapter } from "./cli.js";
import { GenericProcessAdapter, OpenAICompatibleAdapter } from "./api.js";
import { AnthropicMessagesAdapter, GeminiApiAdapter, OpenAIResponsesAdapter } from "./native-api.js";

export function createAdapter(connection: ConnectionConfig, config: ProjectConfig): ProviderAdapter {
  switch (connection.adapter) {
    case "codex-builtin": return new CodexBuiltinAdapter();
    case "claude-code-builtin": return new ClaudeBuiltinAdapter();
    case "antigravity-builtin": return new AntigravityBuiltinAdapter();
    case "gemini-cli-builtin": return new GeminiCliBuiltinAdapter();
    case "openai-api": return new OpenAIResponsesAdapter(connection, config.verifierCommands);
    case "anthropic-api": return new AnthropicMessagesAdapter(connection, config.verifierCommands);
    case "gemini-api": return new GeminiApiAdapter(connection, config.verifierCommands);
    case "deepseek-api":
    case "zai-general-api":
    case "zai-coding-plan":
    case "openai-compatible": return new OpenAICompatibleAdapter(connection, config.verifierCommands);
    case "generic-process": return new GenericProcessAdapter(connection);
    default: return new OpenAICompatibleAdapter(connection, config.verifierCommands);
  }
}

export function adapterMap(config: ProjectConfig): Map<string, ProviderAdapter> {
  return new Map(config.connections.filter((item) => item.enabled).map((connection) => [connection.id, createAdapter(connection, config)]));
}
