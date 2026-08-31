import { homedir } from "node:os";
import { join } from "node:path";
import { access, readFile } from "node:fs/promises";
import type { ConnectionConfig, ExecutionProfile, ProjectConfig } from "./types.js";
import { commandExists } from "./util.js";
import { buildRoutes } from "./router.js";
import { loadCatalog } from "./catalog.js";
import { getCredential } from "./credentials.js";
import { createAdapter } from "./providers/index.js";
import { saveConfig } from "./state.js";

export function globalConfigDir(): string {
  if (process.env.RALPH_CONFIG_HOME) return process.env.RALPH_CONFIG_HOME;
  if (process.platform === "win32") return join(process.env.APPDATA ?? homedir(), "ralph");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "ralph");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ralph");
}

export async function detectConnections(): Promise<ConnectionConfig[]> {
  const candidates: Array<{ command: string; connection: ConnectionConfig }> = [
    {
      command: "codex",
      connection: { id: "openai:codex-login", adapter: "codex-builtin", provider: "openai", enabled: true, mode: "builtin" },
    },
    {
      command: "claude",
      connection: { id: "anthropic:claude-login", adapter: "claude-code-builtin", provider: "anthropic", enabled: true, mode: "builtin" },
    },
    {
      command: "agy",
      connection: { id: "google:antigravity-login", adapter: "antigravity-builtin", provider: "google", enabled: true, mode: "builtin" },
    },
    {
      command: "gemini",
      connection: { id: "google:gemini-cli-login", adapter: "gemini-cli-builtin", provider: "google", enabled: true, mode: "builtin" },
    },
  ];
  const detected: ConnectionConfig[] = [];
  for (const candidate of candidates) if (await commandExists(candidate.command)) detected.push(candidate.connection);

  const apiConnections: ConnectionConfig[] = [
    { id: "openai:api", adapter: "openai-api", provider: "openai", enabled: false, mode: "api", apiKeyEnv: "OPENAI_API_KEY", baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1" },
    { id: "anthropic:api", adapter: "anthropic-api", provider: "anthropic", enabled: false, mode: "api", apiKeyEnv: "ANTHROPIC_API_KEY", baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com" },
    { id: "google:api", adapter: "gemini-api", provider: "google", enabled: false, mode: "api", apiKeyEnv: "GEMINI_API_KEY", baseUrl: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta" },
    { id: "deepseek:api", adapter: "deepseek-api", provider: "deepseek", enabled: false, mode: "api", apiKeyEnv: "DEEPSEEK_API_KEY", baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com" },
    { id: "zai:general", adapter: "zai-general-api", provider: "zai", enabled: false, mode: "api", apiKeyEnv: "GLM_GENERAL_API_KEY", baseUrl: process.env.GLM_GENERAL_BASE_URL ?? "https://api.z.ai/api/paas/v4" },
    { id: "zai:coding-plan", adapter: "zai-coding-plan", provider: "zai", enabled: false, mode: "api", apiKeyEnv: "GLM_API_KEY", baseUrl: process.env.GLM_BASE_URL ?? "https://api.z.ai/api/coding/paas/v4" },
  ];
  for (const connection of apiConnections) connection.enabled = Boolean(await getCredential(connection.id, connection.apiKeyEnv));
  return [...detected, ...apiConnections];
}

async function discoverModels(config: ProjectConfig): Promise<ConnectionConfig[]> {
  return await Promise.all(config.connections.map(async (connection) => {
    if (!connection.enabled || connection.mode === "process") return connection;
    try {
      const models = await createAdapter(connection, config).listModels();
      const ids = [...new Set(models.map((model) => model.modelId).filter(Boolean))];
      return ids.length ? { ...connection, models: ids } : connection;
    } catch {
      return connection;
    }
  }));
}

async function syncApiAuthentication(connections: ConnectionConfig[]): Promise<ConnectionConfig[]> {
  return await Promise.all(connections.map(async (connection) => connection.mode === "api"
    ? { ...connection, enabled: Boolean(await getCredential(connection.id, connection.apiKeyEnv)) }
    : connection));
}

async function syncAuthentication(config: ProjectConfig): Promise<ConnectionConfig[]> {
  const apiSynced = await syncApiAuthentication(config.connections);
  const provisional = { ...config, connections: apiSynced };
  return await Promise.all(apiSynced.map(async (connection) => {
    if (connection.mode === "api" || connection.mode === "process") return connection;
    try {
      const auth = await createAdapter(connection, provisional).authStatus();
      return { ...connection, enabled: auth.status !== "unauthenticated" && auth.status !== "unavailable" };
    } catch {
      return { ...connection, enabled: false };
    }
  }));
}

export async function createProjectConfig(
  projectRoot: string,
  preset: ExecutionProfile = "balanced",
  extraConnections: ConnectionConfig[] = [],
): Promise<ProjectConfig> {
  const catalog = await loadCatalog();
  const detected = await detectConnections();
  const connectionMap = new Map([...detected, ...extraConnections].map((item) => [item.id, item]));
  const connections = [...connectionMap.values()];
  let config: ProjectConfig = {
    schemaVersion: 1,
    projectRoot,
    preset,
    initializedAt: new Date().toISOString(),
    connections,
    routes: buildRoutes(catalog, connections, preset),
    overrides: {},
    routePolicies: {},
    verifierCommands: await inferVerifierCommands(projectRoot),
    verification: { frozenInvariants: await inferFrozenInvariants(projectRoot) },
    catalogVersion: catalog.version,
  };
  config = { ...config, connections: await syncAuthentication(config) };
  const discoveredConnections = await discoverModels(config);
  config = { ...config, connections: discoveredConnections, routes: buildRoutes(catalog, discoveredConnections, preset) };
  await saveConfig(projectRoot, config);
  return config;
}

async function inferFrozenInvariants(projectRoot: string): Promise<string[]> {
  const candidates = ["openapi.json", "openapi.yaml", "openapi.yml", "schema.prisma", "prisma/schema.prisma"];
  const found: string[] = [];
  for (const candidate of candidates) {
    try { await access(join(projectRoot, candidate)); found.push(candidate); }
    catch { /* Optional invariant file. */ }
  }
  return found;
}

async function inferVerifierCommands(projectRoot: string): Promise<string[]> {
  const commands = ["git diff --check"];
  try {
    const pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    for (const name of ["test", "lint", "typecheck", "build"]) if (pkg.scripts?.[name]) commands.push(`npm run ${name}`);
  } catch {
    // Package scripts are optional.
  }
  return commands;
}

export async function setPreset(config: ProjectConfig, preset: ExecutionProfile): Promise<ProjectConfig> {
  config = normalizeProjectConfig(config);
  const catalog = await loadCatalog();
  return {
    ...config,
    preset,
    routes: buildRoutes(catalog, config.connections, preset, config.overrides),
    catalogVersion: catalog.version,
  };
}

export async function refreshProjectConfig(config: ProjectConfig, preset: ExecutionProfile): Promise<ProjectConfig> {
  config = normalizeProjectConfig(config);
  const catalog = await loadCatalog();
  const connections = await syncAuthentication(config);
  const authChanged = connections.some((connection, index) => connection.enabled !== config.connections[index]?.enabled);
  if (config.preset === preset && config.catalogVersion === catalog.version && !authChanged) return config;
  return {
    ...config,
    preset,
    connections,
    routes: buildRoutes(catalog, connections, preset, config.overrides),
    catalogVersion: catalog.version,
  };
}

export function normalizeProjectConfig(config: ProjectConfig): ProjectConfig {
  const routes = config.routes as ProjectConfig["routes"] & { router?: ProjectConfig["routes"]["contractPlanner"] };
  if (!routes.router) routes.router = routes.contractPlanner ?? routes.metaPrompter ?? [];
  return {
    ...config,
    routes,
    routePolicies: config.routePolicies ?? {},
    verification: config.verification ?? { frozenInvariants: [] },
  };
}
