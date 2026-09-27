import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "../src/catalog.js";
import { refreshProjectConfig } from "../src/config.js";
import {
  credentialSource,
  getCredential,
  removeCredential,
  setCredential,
} from "../src/credentials.js";
import type { Prompt } from "../src/interaction/prompt.js";
import {
  catalogModelsFor,
  loginCommand,
  providerStatusRows,
  runProviderSetup,
  statusLabel,
} from "../src/setup.js";
import { loadConfig, saveConfig } from "../src/state.js";
import type { ConnectionConfig, ProjectConfig } from "../src/types.js";
import { runCommand } from "../src/util.js";

interface Scripted {
  one?: string[];
  many?: string[][];
  secret?: string[];
}

/** Answers are queued in call order so a test states exactly what the user would type. */
function scriptedPrompt(script: Scripted = {}, interactive = true): Prompt {
  const next = <T>(queue: T[] | undefined, name: string): T => {
    const value = queue?.shift();
    if (value === undefined)
      throw new Error(`unexpected ${name} prompt in this test`);
    return value;
  };
  return {
    interactive,
    info: () => {},
    async selectOne() {
      return next(script.one, "selectOne");
    },
    async selectMany() {
      return next(script.many, "selectMany");
    },
    async askSecret() {
      return next(script.secret, "askSecret");
    },
    async confirm() {
      return true;
    },
  };
}

const API_CONNECTIONS: ConnectionConfig[] = [
  {
    id: "deepseek:api",
    adapter: "deepseek-api",
    provider: "deepseek",
    enabled: false,
    mode: "api",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "http://127.0.0.1:1",
  },
  {
    id: "zai:general",
    adapter: "zai-general-api",
    provider: "zai",
    enabled: false,
    mode: "api",
    apiKeyEnv: "GLM_GENERAL_API_KEY",
    baseUrl: "http://127.0.0.1:1",
  },
  {
    id: "zai:coding-plan",
    adapter: "zai-coding-plan",
    provider: "zai",
    enabled: false,
    mode: "api",
    apiKeyEnv: "GLM_API_KEY",
    baseUrl: "http://127.0.0.1:1",
  },
];

const homes: string[] = [];

async function project(connections: ConnectionConfig[] = API_CONNECTIONS) {
  const root = await mkdtemp(join(tmpdir(), "ralph-setup-"));
  homes.push(root);
  await runCommand("git", ["init"], { cwd: root });
  const config: ProjectConfig = {
    schemaVersion: 1,
    projectRoot: root,
    preset: "balanced",
    initializedAt: new Date().toISOString(),
    connections: connections.map((connection) => ({ ...connection })),
    routes: {} as ProjectConfig["routes"],
    overrides: {},
    routePolicies: {},
    verifierCommands: ["git diff --check"],
    catalogVersion: 5,
  };
  await saveConfig(root, config);
  return { root, config };
}

describe("provider setup", () => {
  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "ralph-home-"));
    homes.push(home);
    vi.stubEnv("RALPH_CONFIG_HOME", home);
    vi.stubEnv("RALPH_CREDENTIAL_STORE", "file");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("GLM_API_KEY", "");
    vi.stubEnv("GLM_GENERAL_API_KEY", "");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const path of homes.splice(0))
      await rm(path, { recursive: true, force: true });
  });

  it("stores an API key without a keychain and keeps only the chosen models", async () => {
    const { root, config } = await project();
    const result = await runProviderSetup(root, config, scriptedPrompt({}, false), {
      providers: ["deepseek"],
      method: "api",
      apiKeys: { "*": "sk-test-deepseek" },
      models: { "*": ["deepseek-flash"] },
      liveDiscovery: false,
    });
    expect(await credentialSource("deepseek:api", "DEEPSEEK_API_KEY")).toBe("file");
    const saved = await loadConfig(root);
    const connection = saved.connections.find((item) => item.id === "deepseek:api")!;
    expect(connection.enabled).toBe(true);
    expect(connection.models).toEqual(["deepseek-flash"]);
    expect(result.changed.some((line) => line.includes("키를"))).toBe(true);
    const routed = Object.values(saved.routes).flat();
    expect(routed.length).toBeGreaterThan(0);
    expect(routed.every((entry) => entry.connectionId === "deepseek:api")).toBe(true);
    expect(routed.every((entry) => entry.modelId === "deepseek-flash")).toBe(true);
  });

  it("refuses to guess in a non-interactive run", async () => {
    const { root, config } = await project();
    await expect(
      runProviderSetup(root, config, scriptedPrompt({}, false), {}),
    ).rejects.toThrow(/--provider/);
  });

  it("requires a key when nothing is stored and no key is supplied", async () => {
    const { root, config } = await project();
    await expect(
      runProviderSetup(root, config, scriptedPrompt({}, false), {
        providers: ["deepseek"],
        method: "api",
        liveDiscovery: false,
      }),
    ).rejects.toThrow(/API 키/);
  });

  it("rejects a method the provider does not offer", async () => {
    const { root, config } = await project();
    await expect(
      runProviderSetup(root, config, scriptedPrompt({}, false), {
        providers: ["deepseek"],
        method: "login",
        liveDiscovery: false,
      }),
    ).rejects.toThrow(/지원하지 않습니다/);
  });

  it("rejects model ids that the catalog does not offer for that adapter", async () => {
    const { root, config } = await project();
    await expect(
      runProviderSetup(root, config, scriptedPrompt({}, false), {
        providers: ["deepseek"],
        method: "api",
        apiKeys: { "*": "sk-test" },
        models: { "*": ["not-a-real-model"] },
        liveDiscovery: false,
      }),
    ).rejects.toThrow(/사용할 모델이 없습니다/);
  });

  it("walks an interactive user through provider, connection, key and models", async () => {
    const { root, config } = await project();
    const result = await runProviderSetup(
      root,
      config,
      scriptedPrompt({
        many: [["zai"], ["glm-5.3", "glm-5.3-flash"]],
        one: ["zai:general"],
        secret: ["glm-test-key"],
      }),
      { liveDiscovery: false },
    );
    const saved = await loadConfig(root);
    const connection = saved.connections.find(
      (item) => item.id === "zai:general",
    )!;
    expect(connection.enabled).toBe(true);
    expect(connection.models).toEqual(["glm-5.3", "glm-5.3-flash"]);
    expect(await getCredential("zai:general")).toBe("glm-test-key");
    expect(result.changed.join(" ")).toContain("zai:general");
  });

  it("aborts the login method when the CLI is not installed", async () => {
    const { root, config } = await project([
      {
        id: "google:antigravity-login",
        adapter: "antigravity-builtin",
        provider: "google",
        enabled: false,
        mode: "builtin",
      },
    ]);
    await expect(
      runProviderSetup(root, config, scriptedPrompt({}, false), {
        providers: ["google"],
        method: "login",
        liveDiscovery: false,
      }),
    ).rejects.toThrow(/CLI/);
  });

  it("reports provider, method, credential store and catalog models", async () => {
    const { config } = await project();
    await setCredential("zai:general", "glm-key");
    const catalog = await loadCatalog();
    const rows = await providerStatusRows(config, catalog);
    const deepseek = rows.find((row) => row.connectionId === "deepseek:api")!;
    expect(deepseek.method).toBe("api");
    expect(deepseek.authentication).toBe("unauthenticated");
    expect(statusLabel(deepseek)).toBe("API 키 필요");
    const zai = rows.find((row) => row.connectionId === "zai:general")!;
    expect(zai.authentication).toBe("authenticated");
    expect(statusLabel(zai)).toMatch(/연결됨/);
    const zaiConnection = config.connections.find(
      (item) => item.id === "zai:general",
    )!;
    expect(catalogModelsFor(catalog, zaiConnection)).toContain("glm-5.3-flash");
    expect(zai.models).toContain("glm-5.3");
  });

  it("keeps an explicit model selection across a config refresh", async () => {
    const { config } = await project();
    await setCredential("deepseek:api", "sk-test");
    config.connections[0]!.models = ["deepseek-flash"];
    config.connections[0]!.enabled = true;
    const refreshed = await refreshProjectConfig(config, "balanced");
    const connection = refreshed.connections.find(
      (item) => item.id === "deepseek:api",
    )!;
    expect(connection.models).toEqual(["deepseek-flash"]);
    expect(connection.enabled).toBe(true);
  });
});

describe("credential fallback store", () => {
  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "ralph-home-"));
    homes.push(home);
    vi.stubEnv("RALPH_CONFIG_HOME", home);
    vi.stubEnv("RALPH_CREDENTIAL_STORE", "file");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const path of homes.splice(0))
      await rm(path, { recursive: true, force: true });
  });

  it("round-trips a secret and removes it", async () => {
    expect(await setCredential("test:api", "  secret-value  ")).toBe("file");
    expect(await getCredential("test:api")).toBe("secret-value");
    expect(await credentialSource("test:api")).toBe("file");
    await removeCredential("test:api");
    expect(await getCredential("test:api")).toBeUndefined();
    expect(await credentialSource("test:api")).toBeUndefined();
  });

  it("prefers a stored secret over an empty environment variable", async () => {
    vi.stubEnv("TEST_API_KEY", "");
    await setCredential("env:api", "stored");
    expect(await getCredential("env:api", "TEST_API_KEY")).toBe("stored");
  });
});

describe("login command mapping", () => {
  it("covers the login-capable adapters only", () => {
    expect(loginCommand("claude-code-builtin")).toEqual(["claude", ["auth", "login"]]);
    expect(loginCommand("gemini-cli-builtin")).toEqual(["gemini", []]);
    expect(loginCommand("codex-builtin")).toEqual(["codex", ["login"]]);
    expect(loginCommand("deepseek-api")).toBeUndefined();
    expect(loginCommand("antigravity-builtin")).toBeUndefined();
  });
});
