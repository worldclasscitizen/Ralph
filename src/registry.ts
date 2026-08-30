import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { globalConfigDir } from "./config.js";
import { readJson, writeJson } from "./util.js";

interface Registry { schemaVersion: 1; projects: Array<{ root: string; registeredAt: string }> }

function registryPath(): string { return join(globalConfigDir(), "projects.json"); }

export async function registerProject(root: string): Promise<void> {
  await mkdir(globalConfigDir(), { recursive: true });
  let registry: Registry = { schemaVersion: 1, projects: [] };
  try { registry = await readJson<Registry>(registryPath()); } catch { /* first registration */ }
  registry.projects = [{ root, registeredAt: new Date().toISOString() }, ...registry.projects.filter((item) => item.root !== root)];
  await writeJson(registryPath(), registry);
}

export async function registeredProjects(): Promise<string[]> {
  try { return (await readJson<Registry>(registryPath())).projects.map((item) => item.root); } catch { return []; }
}
