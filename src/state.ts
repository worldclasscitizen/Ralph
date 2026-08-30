import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { gitPath } from "./git.js";
import type { ProjectConfig, RalphEvent, RunState, TaskContract } from "./types.js";
import { atomicWrite, now, readJson, writeJson } from "./util.js";

export interface StatePaths {
  root: string;
  config: string;
  contracts: string;
  runs: string;
  sessions: string;
  progress: string;
  guardrails: string;
  locks: string;
  dashboard: string;
}

export async function statePaths(projectRoot: string): Promise<StatePaths> {
  const root = await gitPath(projectRoot, "ralph");
  return {
    root,
    config: join(root, "config.json"),
    contracts: join(root, "contracts"),
    runs: join(root, "runs"),
    sessions: join(root, "sessions"),
    progress: join(root, "progress.jsonl"),
    guardrails: join(root, "guardrails.md"),
    locks: join(root, "locks"),
    dashboard: join(root, "dashboard"),
  };
}

export async function ensureState(projectRoot: string): Promise<StatePaths> {
  const paths = await statePaths(projectRoot);
  await Promise.all([
    mkdir(paths.contracts, { recursive: true }),
    mkdir(paths.runs, { recursive: true }),
    mkdir(paths.sessions, { recursive: true }),
    mkdir(paths.locks, { recursive: true }),
    mkdir(paths.dashboard, { recursive: true }),
  ]);
  try {
    await stat(paths.guardrails);
  } catch {
    await atomicWrite(
      paths.guardrails,
      "# Ralph guardrails\n\n일반화할 수 있고 증거로 확인된 재발 방지 교훈만 기록합니다.\n",
    );
  }
  return paths;
}

export async function saveConfig(projectRoot: string, config: ProjectConfig): Promise<void> {
  const paths = await ensureState(projectRoot);
  await writeJson(paths.config, config);
}

export async function loadConfig(projectRoot: string): Promise<ProjectConfig> {
  const paths = await ensureState(projectRoot);
  return await readJson<ProjectConfig>(paths.config);
}

export async function saveContract(projectRoot: string, contract: TaskContract): Promise<string> {
  const paths = await ensureState(projectRoot);
  const path = join(paths.contracts, `${contract.id}.json`);
  await writeJson(path, contract);
  return path;
}

export async function loadContract(projectRoot: string, id: string): Promise<TaskContract> {
  const paths = await ensureState(projectRoot);
  return await readJson<TaskContract>(join(paths.contracts, `${id}.json`));
}

export async function saveRun(projectRoot: string, run: RunState): Promise<void> {
  const paths = await ensureState(projectRoot);
  const dir = join(paths.runs, run.id);
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, "state.json"), run);
}

export async function loadRun(projectRoot: string, runId: string): Promise<RunState> {
  const paths = await ensureState(projectRoot);
  return await readJson<RunState>(join(paths.runs, runId, "state.json"));
}

export async function appendEvent(projectRoot: string, event: RalphEvent): Promise<void> {
  const paths = await ensureState(projectRoot);
  const runDir = join(paths.runs, event.runId);
  await mkdir(runDir, { recursive: true });
  const line = `${JSON.stringify(event)}\n`;
  await Promise.all([appendFile(join(runDir, "events.jsonl"), line), appendFile(paths.progress, line)]);
}

export async function emitEvent(
  projectRoot: string,
  event: Omit<RalphEvent, "timestamp">,
): Promise<void> {
  await appendEvent(projectRoot, { timestamp: now(), ...event });
}

export async function listRuns(projectRoot: string): Promise<RunState[]> {
  const paths = await ensureState(projectRoot);
  const names = await readdir(paths.runs).catch(() => []);
  const states: RunState[] = [];
  for (const name of names) {
    try {
      states.push(await readJson<RunState>(join(paths.runs, name, "state.json")));
    } catch {
      // 불완전한 legacy run은 목록에서 제외합니다.
    }
  }
  return states.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function readEvents(projectRoot: string, runId: string): Promise<RalphEvent[]> {
  const paths = await ensureState(projectRoot);
  try {
    const text = await readFile(join(paths.runs, runId, "events.jsonl"), "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RalphEvent);
  } catch {
    return [];
  }
}

export async function deleteRun(projectRoot: string, runId: string): Promise<void> {
  const run = await loadRun(projectRoot, runId);
  if (run.status === "running") throw new Error("실행 중인 기록은 삭제할 수 없습니다.");
  if (await activeRun(projectRoot)) throw new Error("다른 실행이 진행 중일 때는 progress 원장 충돌을 막기 위해 기록을 삭제할 수 없습니다.");
  const paths = await ensureState(projectRoot);
  await rm(join(paths.runs, runId), { recursive: true, force: true });
  await rm(join(paths.sessions, runId), { recursive: true, force: true });
  try {
    const retained = (await readFile(paths.progress, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => { try { return (JSON.parse(line) as RalphEvent).runId !== runId; } catch { return true; } });
    await atomicWrite(paths.progress, retained.length ? `${retained.join("\n")}\n` : "");
  } catch {
    // progress 원장이 아직 없으면 삭제할 항목도 없습니다.
  }
}

export async function activeRun(projectRoot: string): Promise<RunState | undefined> {
  return (await listRuns(projectRoot)).find((run) => run.status === "running");
}

export async function writeLock(projectRoot: string, run: RunState): Promise<void> {
  const paths = await ensureState(projectRoot);
  await rm(join(paths.locks, "stop-requested"), { force: true });
  await writeJson(join(paths.locks, "active.json"), {
    runId: run.id,
    pid: run.pid,
    startedAt: run.startedAt,
    projectRoot,
  });
}

export async function removeLock(projectRoot: string): Promise<void> {
  const paths = await ensureState(projectRoot);
  await rm(join(paths.locks, "active.json"), { force: true });
  await rm(join(paths.locks, "stop-requested"), { force: true });
}

export async function requestStop(projectRoot: string): Promise<void> {
  const paths = await ensureState(projectRoot);
  await atomicWrite(join(paths.locks, "stop-requested"), `${now()}\n`);
}

export async function isStopRequested(projectRoot: string): Promise<boolean> {
  const paths = await ensureState(projectRoot);
  try {
    await stat(join(paths.locks, "stop-requested"));
    return true;
  } catch {
    return false;
  }
}

export async function readLock(projectRoot: string): Promise<{ runId: string; pid: number } | undefined> {
  const paths = await ensureState(projectRoot);
  try {
    return await readJson(join(paths.locks, "active.json"));
  } catch {
    return undefined;
  }
}

export function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
