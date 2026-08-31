import { cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../integrations", import.meta.url));

const TARGETS: Record<string, { source: string; target: string }> = {
  codex: { source: join(ROOT, "codex", "SKILL.md"), target: join(homedir(), ".agents", "skills", "ralph", "SKILL.md") },
  claude: { source: join(ROOT, "claude", "ralph.md"), target: join(homedir(), ".claude", "commands", "ralph.md") },
  antigravity: { source: join(ROOT, "antigravity", "SKILL.md"), target: join(homedir(), ".antigravity", "skills", "ralph", "SKILL.md") },
  gemini: { source: join(ROOT, "gemini", "SKILL.md"), target: join(homedir(), ".gemini", "skills", "ralph", "SKILL.md") },
};

export async function installIntegrations(names: string[]): Promise<string[]> {
  const selected = names.length ? names : Object.keys(TARGETS);
  const installed: string[] = [];
  for (const name of selected) {
    const item = TARGETS[name];
    if (!item) throw new Error(`지원하지 않는 통합입니다: ${name}`);
    await mkdir(dirname(item.target), { recursive: true });
    await cp(item.source, item.target, { force: true });
    installed.push(`${name}: ${item.target}`);
  }
  return installed;
}

export async function uninstallIntegrations(names: string[]): Promise<string[]> {
  const selected = names.length ? names : Object.keys(TARGETS);
  for (const name of selected) {
    const item = TARGETS[name];
    if (!item) throw new Error(`지원하지 않는 통합입니다: ${name}`);
    await rm(item.target, { force: true });
  }
  return selected;
}

export async function integrationStatus(): Promise<Array<{ name: string; target: string; installed: boolean }>> {
  const { access } = await import("node:fs/promises");
  return await Promise.all(Object.entries(TARGETS).map(async ([name, item]) => {
    try { await access(item.target); return { name, target: item.target, installed: true }; }
    catch { return { name, target: item.target, installed: false }; }
  }));
}
