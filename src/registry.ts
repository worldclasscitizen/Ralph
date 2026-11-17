import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { globalConfigDir } from "./config.js";
import { readJson, sha256, writeJson } from "./util.js";

interface ProjectRegistration { root: string; registeredAt: string }

export async function registerProject(root: string): Promise<void> {
  const path = join(globalConfigDir(), "projects", `${sha256(root)}.json`);
  // Projects register independently, including when two CLI processes start together.
  await writeJson(path, { root, registeredAt: new Date().toISOString() });
}

export async function registeredProjects(): Promise<string[]> {
  const home = globalConfigDir();
  const directory = join(home, "projects");
  const [legacy, files] = await Promise.all([
    readJson<{ projects: ProjectRegistration[] }>(join(home, "projects.json")).catch(() => undefined),
    readdir(directory).catch(() => []),
  ]);
  const entries = await Promise.all(
    files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) =>
      readJson<ProjectRegistration>(join(directory, name)).catch(() => undefined),
    ),
  );
  return [...new Set(
    [...entries, ...(Array.isArray(legacy?.projects) ? legacy.projects : [])].flatMap((entry) =>
      typeof entry?.root === "string" ? [entry.root] : [],
    ),
  )];
}
