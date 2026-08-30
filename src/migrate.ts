import { appendFile, cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createProjectConfig } from "./config.js";
import { loadCatalog } from "./catalog.js";
import { validateContract } from "./contracts.js";
import { ensureState, saveContract } from "./state.js";
import type { ProjectConfig, RouteEntry, TaskType } from "./types.js";
import { atomicWrite, readJson, sha256, writeJson } from "./util.js";

async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }

export async function migrateLegacy(projectRoot: string): Promise<Record<string, unknown>> {
  const paths = await ensureState(projectRoot);
  const manifestPath = join(paths.root, "migration-manifest.json");
  if (await exists(manifestPath)) {
    return { ...(await readJson<Record<string, unknown>>(manifestPath)), alreadyMigrated: true };
  }
  const manifest: Record<string, unknown> = { migratedAt: new Date().toISOString(), source: "legacy-bash", files: [] as unknown[] };
  let config: ProjectConfig;
  try {
    const localPath = join(projectRoot, ".antigravity", "config.local.json");
    const raw = await readFile(localPath, "utf8");
    (manifest.files as unknown[]).push({ path: ".antigravity/config.local.json", sha256: sha256(raw), secretCopied: false });
    config = await createProjectConfig(projectRoot);
    const legacy = JSON.parse(raw) as {
      models?: Record<string, { catalogModel?: string; reasoningEffort?: string }>;
      taskPipelines?: Partial<Record<TaskType, string[]>>;
      ralph?: { defaults?: { task?: string; maxIterations?: number; minimumCriticScore?: number }; fallbackChains?: { critic?: string[]; metaPrompter?: string[] } };
    };
    try {
      const team = JSON.parse(await readFile(join(projectRoot, ".antigravity", "config.json"), "utf8")) as { modelCatalog?: Record<string, { provider?: string; modelId?: string }> };
      const catalog = await loadCatalog();
      const resolveAliases = (aliases: string[]): RouteEntry[] => aliases.flatMap((alias) => {
        const selected = legacy.models?.[alias];
        const legacyModel = selected?.catalogModel ? team.modelCatalog?.[selected.catalogModel] : undefined;
        if (!legacyModel?.modelId) return [];
        const current = catalog.models.find((item) => item.modelId === legacyModel.modelId && Date.parse(item.expiresAt) >= Date.now());
        if (!current) return [];
        const connection = config.connections.find((item) => item.provider === current.provider || (item.provider === "zai" && String(legacyModel.provider).startsWith("zai")));
        if (!connection) return [];
        const effort = selected?.reasoningEffort && current.supportedEfforts.includes(selected.reasoningEffort) ? selected.reasoningEffort : current.recommendedEffort;
        return [{ connectionId: connection.id, provider: current.provider, modelId: current.modelId, displayName: current.displayName, reasoningEffort: effort, score: 100, source: "override" as const }];
      }).slice(0, 3);
      for (const [task, aliases] of Object.entries(legacy.taskPipelines ?? {})) {
        const route = resolveAliases(aliases ?? []);
        if (route.length) config.overrides[task as TaskType] = route;
      }
      const critic = resolveAliases(legacy.ralph?.fallbackChains?.critic ?? []);
      const meta = resolveAliases(legacy.ralph?.fallbackChains?.metaPrompter ?? []);
      if (critic.length) { config.overrides.critic = critic; config.overrides.adjudicator = critic; }
      if (meta.length) { config.overrides.metaPrompter = meta; config.overrides.contractPlanner = meta; }
      config.routes = { ...config.routes, ...config.overrides };
      await writeJson(paths.config, config);
    } catch {
      // Legacy team catalog가 없거나 만료되면 최신 자동 경로를 유지합니다.
    }
    await writeJson(join(paths.root, "legacy-config-reference.json"), { defaults: legacy.ralph?.defaults ?? {}, note: "모델은 최신 서명 카탈로그로 다시 계산했습니다. 비밀값은 가져오지 않았습니다." });
  } catch {
    config = await createProjectConfig(projectRoot);
  }

  const promptPath = join(projectRoot, ".ralph", "PROMPT.md");
  if (await exists(promptPath)) {
    const prompt = await readFile(promptPath, "utf8");
    const contract = validateContract({ taskType: "backend_core", goal: "Legacy PROMPT.md에서 가져온 작업", include: [], exclude: [".git/**"], requirements: [prompt.slice(0, 20_000)], acceptanceCriteria: ["Legacy 계약 내용을 검토하고 새 실행 전에 다시 승인합니다."], verifierCommands: config.verifierCommands, requiredArtifacts: [], attachments: [], constraints: ["legacy-import"], executionProfile: config.preset }, projectRoot);
    await saveContract(projectRoot, contract);
    (manifest.files as unknown[]).push({ path: ".ralph/PROMPT.md", sha256: sha256(prompt), contractId: contract.id });
  }
  for (const name of ["progress.txt", "guardrails.md"]) {
    const source = join(projectRoot, ".ralph", name);
    if (await exists(source)) {
      const content = await readFile(source, "utf8");
      if (name === "guardrails.md") await appendFile(paths.guardrails, `\n## Legacy import\n\n${content}\n`);
      else await atomicWrite(join(paths.root, "legacy-progress.txt"), content);
      (manifest.files as unknown[]).push({ path: `.ralph/${name}`, sha256: sha256(content) });
    }
  }
  const runs = join(projectRoot, ".ralph", "runs");
  if (await exists(runs)) {
    const target = join(paths.runs, "legacy");
    await mkdir(target, { recursive: true });
    await cp(runs, target, { recursive: true, force: false, errorOnExist: false });
    await writeJson(join(target, "manifest.json"), { readOnly: true, importedAt: new Date().toISOString() });
  }
  const sessions = join(projectRoot, ".ralph", "sessions");
  if (await exists(sessions)) await cp(sessions, join(paths.sessions, "legacy"), { recursive: true, force: false, errorOnExist: false });
  const outputFiles = [paths.config, paths.guardrails, join(paths.root, "legacy-config-reference.json"), join(paths.root, "legacy-progress.txt")];
  manifest.outputs = [];
  for (const path of outputFiles) {
    if (await exists(path)) {
      const content = await readFile(path, "utf8");
      (manifest.outputs as unknown[]).push({ path, sha256: sha256(content) });
    }
  }
  await writeJson(manifestPath, manifest);
  return manifest;
}

export async function cleanupLegacy(projectRoot: string): Promise<void> {
  for (const path of [join(projectRoot, ".ralph"), join(projectRoot, ".antigravity")]) await rm(path, { recursive: true, force: true });
}
