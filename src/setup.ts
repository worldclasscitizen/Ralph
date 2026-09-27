import { loadCatalog } from "./catalog.js";
import { recomputeProjectConfig } from "./config.js";
import {
  credentialSource,
  describeStore,
  getCredential,
  setCredential,
} from "./credentials.js";
import { probeProvider } from "./gateway/capabilities.js";
import { createAdapter } from "./providers/index.js";
import { saveConfig } from "./state.js";
import { RalphError } from "./util.js";
import type { Prompt, PromptOption } from "./interaction/prompt.js";
import type {
  ConnectionConfig,
  ExecutionProfile,
  ModelCatalog,
  ProjectConfig,
} from "./types.js";

export interface ProviderStatusRow {
  provider: string;
  connectionId: string;
  adapter: string;
  method: "login" | "api";
  installed: boolean;
  authentication: string;
  enabled: boolean;
  support: string;
  store?: string;
  version?: string;
  /** Routable catalog models for this connection. */
  models: string[];
  /** Ids the connection lists but the signed catalog does not contain. */
  unavailableModels?: string[];
}

/** Pure grouping used by both the status table and the wizard. */
export function connectionMethod(connection: ConnectionConfig): "login" | "api" {
  return connection.mode === "api" ? "api" : "login";
}

export function catalogModelsFor(
  catalog: ModelCatalog,
  connection: ConnectionConfig,
): string[] {
  return catalog.models
    .filter((model) => model.adapter === connection.adapter)
    .map((model) => model.modelId);
}

export async function providerStatusRows(
  config: ProjectConfig,
  catalog?: ModelCatalog,
): Promise<ProviderStatusRow[]> {
  const resolved = catalog ?? (await loadCatalog());
  const rows: ProviderStatusRow[] = [];
  for (const connection of config.connections) {
    const capability = await probeProvider(
      connection,
      createAdapter(connection, config),
    );
    const method = connectionMethod(connection);
    const catalogModels = catalogModelsFor(resolved, connection);
    const models = connection.models?.length
      ? connection.models.filter((id) => catalogModels.includes(id))
      : catalogModels;
    const unavailableModels = (connection.models ?? []).filter(
      (id) => !catalogModels.includes(id),
    );
    rows.push({
      provider: connection.provider,
      connectionId: connection.id,
      adapter: connection.adapter,
      method,
      installed: capability.installed,
      authentication: capability.authentication,
      enabled: connection.enabled,
      support: capability.support,
      ...(method === "api"
        ? {
            store: describeStore(
              await credentialSource(connection.id, connection.apiKeyEnv),
            ),
          }
        : {}),
      ...(capability.version ? { version: capability.version } : {}),
      models,
      ...(unavailableModels.length ? { unavailableModels } : {}),
    });
  }
  return rows;
}

export function statusLabel(row: ProviderStatusRow): string {
  if (row.method === "api")
    return row.authentication === "authenticated"
      ? `연결됨 (API 키: ${row.store})`
      : "API 키 필요";
  if (!row.installed) return "CLI 미설치";
  if (row.authentication === "authenticated") return "로그인됨";
  if (row.authentication === "unauthenticated") return "로그인 필요";
  return "상태 확인 불가";
}

export function formatStatusTable(
  rows: ProviderStatusRow[],
  catalog?: ModelCatalog,
): string {
  const lines = ["", "공급자 연동 상태", ""];
  for (const row of rows) {
    const method = row.method === "api" ? "API" : "로그인";
    lines.push(
      `- ${row.provider} · ${row.connectionId} · ${method} · ${statusLabel(row)} · 지원 ${row.support}${row.version ? ` · ${row.version}` : ""}`,
    );
    const names = row.models.map((id) => modelLabel(catalog, id));
    lines.push(`    모델: ${names.join(", ") || "없음"}`);
    if (row.unavailableModels?.length)
      lines.push(
        `    카탈로그 외 (라우팅 불가): ${row.unavailableModels.join(", ")}`,
      );
  }
  lines.push("");
  return lines.join("\n");
}

function modelLabel(catalog: ModelCatalog | undefined, modelId: string): string {
  const model = catalog?.models.find((item) => item.modelId === modelId);
  return model && model.displayName !== modelId
    ? `${model.displayName} (${modelId})`
    : modelId;
}

export function loginCommand(adapter: string): [string, string[]] | undefined {
  const mapping: Record<string, [string, string[]] | undefined> = {
    "codex-builtin": ["codex", ["login"]],
    "claude-code-builtin": ["claude", ["auth", "login"]],
    "gemini-cli-builtin": ["gemini", []],
  };
  return mapping[adapter];
}

export interface SetupOptions {
  providers?: string[];
  method?: "login" | "api";
  connectionIds?: string[];
  /** Keyed by connection id, or "*" to apply the same value to every resolved connection. */
  apiKeys?: Record<string, string>;
  models?: Record<string, string[]>;
  login?: boolean;
  /** Ask the installed CLI/API for models beyond the signed catalog. Defaults to interactive mode. */
  liveDiscovery?: boolean;
}

export interface SetupResult {
  config: ProjectConfig;
  changed: string[];
  rows: ProviderStatusRow[];
}

export async function modelOptions(
  config: ProjectConfig,
  connection: ConnectionConfig,
  catalog?: ModelCatalog,
  live = true,
): Promise<PromptOption[]> {
  const resolved = catalog ?? (await loadCatalog());
  const options: PromptOption[] = catalogModelsFor(resolved, connection).map(
    (modelId) => ({
      value: modelId,
      label: modelLabel(resolved, modelId),
      note: "카탈로그",
    }),
  );
  if (!live) return options;
  try {
    const discovered = await createAdapter(connection, config).listModels();
    for (const model of discovered)
      if (model.modelId && !options.some((option) => option.value === model.modelId))
        // Visible so the gap is obvious, but never selectable: the router only
        // routes signed catalog entries, so picking this would be a dead end.
        options.push({
          value: model.modelId,
          label: model.displayName ?? model.modelId,
          note: "CLI가 보고했지만 카탈로그에 없어 선택할 수 없음",
          disabled: true,
        });
  } catch {
    // Live discovery is optional; the signed catalog stays authoritative.
  }
  return options;
}

function providerOptions(rows: ProviderStatusRow[]): PromptOption[] {
  const providers = [...new Set(rows.map((row) => row.provider))];
  return providers.map((provider) => {
    const own = rows.filter((row) => row.provider === provider);
    const connected = own.filter((row) => row.enabled).length;
    return {
      value: provider,
      label: provider,
      note: `${connected ? `${connected}개 연결됨` : "미연결"} · ${own.map((row) => `${row.connectionId}(${statusLabel(row)})`).join(", ")}`,
    };
  });
}

async function applyApi(
  connection: ConnectionConfig,
  apiKey: string | undefined,
): Promise<string> {
  if (apiKey?.trim()) {
    const store = await setCredential(connection.id, apiKey.trim());
    connection.enabled = true;
    return store === "keychain"
      ? `${connection.id}: 키를 OS 키체인에 저장`
      : `${connection.id}: 키를 ${describeStore("file")}에 저장`;
  }
  if (!(await getCredential(connection.id, connection.apiKeyEnv)))
    throw new RalphError(
      `${connection.id}에는 API 키가 필요합니다. --key-stdin으로 전달하거나 대화형으로 입력해 주세요.`,
      "credential_missing",
      2,
    );
  connection.enabled = true;
  return `${connection.id}: 기존 저장 키 사용`;
}

async function finish(
  root: string,
  config: ProjectConfig,
  preset: ExecutionProfile,
  catalog: ModelCatalog,
): Promise<ProjectConfig> {
  const refreshed = await recomputeProjectConfig(config, preset);
  const withCatalog = { ...refreshed, catalogVersion: catalog.version };
  await saveConfig(root, withCatalog);
  return withCatalog;
}

/**
 * Resolve and apply a provider selection. Interactive prompts are supplied by the
 * caller so the same logic serves the CLI, host integrations and non-interactive runs.
 */
export async function runProviderSetup(
  root: string,
  config: ProjectConfig,
  prompt: Prompt,
  options: SetupOptions = {},
  loginRunner?: (command: string, args: string[]) => Promise<number>,
): Promise<SetupResult> {
  const catalog = await loadCatalog();
  const rows = await providerStatusRows(config, catalog);
  prompt.info(formatStatusTable(rows, catalog));
  const known = [...new Set(rows.map((row) => row.provider))];

  const nonInteractive = !prompt.interactive;
  if (nonInteractive && !options.providers?.length)
    throw new RalphError(
      "비대화형 실행에서는 --provider로 공급자를 지정해야 합니다.",
      "interactive_required",
      2,
    );

  const providers = options.providers?.length
    ? options.providers
    : await prompt.selectMany(
        "연동할 공급자를 선택하세요:",
        providerOptions(rows),
        known.filter((provider) =>
          rows.some((row) => row.provider === provider && row.enabled),
        ),
      );
  for (const provider of providers)
    if (!known.includes(provider))
      throw new RalphError(
        `알 수 없는 공급자입니다: ${provider}. 사용 가능: ${known.join(", ")}`,
        "invalid_argument",
        2,
      );

  const changed: string[] = [];
  const preset = config.preset;
  for (const provider of providers) {
    const candidates = rows.filter((row) => row.provider === provider);
    let method = options.method;
    if (!method) {
      const methods = [...new Set(candidates.map((row) => row.method))];
      method =
        methods.length === 1
          ? methods[0]!
          : (await prompt.selectOne(
              `${provider} 연동 방식을 선택하세요:`,
              methods.map((item) => ({
                value: item,
                label: item === "api" ? "API 키" : "CLI 로그인",
                note: item === "api" ? "키를 저장하고 API로 호출" : "설치된 CLI의 로그인 세션 사용",
              })),
            )) as "login" | "api";
    }
    const matching = candidates.filter((row) => row.method === method);
    if (!matching.length)
      throw new RalphError(
        `${provider}는 ${method === "api" ? "API" : "로그인"} 방식을 지원하지 않습니다.`,
        "invalid_argument",
        2,
      );
    const requested = options.connectionIds?.filter((id) =>
      matching.some((row) => row.connectionId === id),
    );
    const target =
      requested?.[0] ??
      (matching.length === 1
        ? matching[0]!.connectionId
        : await prompt.selectOne(
            `${provider} 연결을 선택하세요:`,
            matching.map((row) => ({
              value: row.connectionId,
              label: row.connectionId,
              note: statusLabel(row),
            })),
          ));
    const connection = config.connections.find((item) => item.id === target);
    if (!connection)
      throw new RalphError(
        `${target} 연결이 프로젝트 설정에 없습니다. ralph init을 먼저 실행해 주세요.`,
        "invalid_config",
        2,
      );
    const row = matching.find((item) => item.connectionId === target)!;

    if (method === "api") {
      let key = options.apiKeys?.[target] ?? options.apiKeys?.["*"];
      if (!key && !row.enabled && !options.apiKeys) {
        if (nonInteractive)
          throw new RalphError(
            `${target}에 API 키가 없습니다. --key-stdin으로 전달해 주세요.`,
            "credential_missing",
            2,
          );
        key = await prompt.askSecret(`${target} API 키를 입력하세요: `);
      }
      changed.push(await applyApi(connection, key));
    } else {
      if (!row.installed) {
        // An installed-CLI problem for one provider must not discard the others.
        if (!prompt.interactive)
          throw new RalphError(
            `${target}의 CLI가 설치되어 있지 않습니다. 설치 후 다시 실행해 주세요.`,
            "cli_missing",
            2,
          );
        prompt.info(
          `${target}의 CLI가 설치되어 있지 않아 건너뜁니다. 설치 후 ralph auth setup을 다시 실행해 주세요.`,
        );
        continue;
      }
      const command = loginCommand(connection.adapter);
      if (row.authentication !== "authenticated" && command) {
        const shouldLogin = options.login ?? true;
        if (shouldLogin && loginRunner) {
          prompt.info(`${connection.id}: ${command[0]} ${command.join(" ")} 실행`);
          const code = await loginRunner(command[0], command[1]);
          if (code !== 0)
            throw new RalphError(
              `${connection.id} 로그인이 완료되지 않았습니다 (종료 코드 ${code}).`,
              "login_failed",
              code,
            );
          changed.push(`${connection.id}: CLI 로그인 완료`);
        } else {
          // --no-login never runs the provider CLI; the printed status shows the real state.
          changed.push(
            `${connection.id}: CLI 로그인을 실행하지 않았습니다 (${command[0]} ${command.slice(1).join(" ")}로 로그인 필요)`,
          );
        }
        if (row.authentication === "unknown")
          prompt.info(
            `${connection.id}: 로그인 상태를 확인할 수 없습니다. 첫 호출에서 판정되며, 실패하면 해당 CLI에서 로그인해 주세요.`,
          );
      } else {
        changed.push(`${connection.id}: 기존 로그인 세션 사용`);
      }
      connection.enabled = true;
    }

    const optionsFor = await modelOptions(
      config,
      connection,
      catalog,
      options.liveDiscovery ?? prompt.interactive,
    );
    const selectable = optionsFor.filter((option) => !option.disabled);
    const unavailable = optionsFor.filter((option) => option.disabled);
    if (unavailable.length)
      prompt.info(
        `${connection.id}: ${unavailable.map((option) => option.value).join(", ")}는(은) 카탈로그에 없어 선택할 수 없습니다. 카탈로그 갱신이 필요합니다.`,
      );
    const preselected = connection.models?.length
      ? connection.models.filter((id) => selectable.some((option) => option.value === id))
      : selectable.map((option) => option.value);
    const requestedModels =
      options.models?.[target] ?? options.models?.["*"];
    const chosen = requestedModels?.length
      ? requestedModels.filter((id) =>
          selectable.some((option) => option.value === id),
        )
      : nonInteractive
        ? preselected
        : await prompt.selectMany(
            `${connection.id}에서 사용할 모델을 선택하세요:`,
            optionsFor,
            preselected,
          );
    if (!chosen.length)
      throw new RalphError(
        `${connection.id}에 사용할 모델이 없습니다. 카탈로그를 확인해 주세요.`,
        "invalid_argument",
        2,
      );
    connection.models = [...new Set(chosen)];
    changed.push(`${connection.id}: 모델 ${connection.models.join(", ")}`);
    // Save incrementally so one failing provider cannot discard the others.
    config = await finish(root, config, preset, catalog);
  }

  const saved = config;
  const refreshedRows = await providerStatusRows(saved, catalog);
  return { config: saved, changed, rows: refreshedRows };
}
