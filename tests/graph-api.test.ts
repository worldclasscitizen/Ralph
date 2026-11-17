import { it, expect, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/workspace/manager.js";
import { saveConfig, statePaths } from "../src/state.js";
import { planRun } from "../src/nodes/planner.js";
import { validateContract } from "../src/contracts.js";
import { startDashboard } from "../src/dashboard.js";
import { submitCommand, pendingCommands } from "../src/runtime/commands.js";
import { storeFor } from "../src/runtime/supervisor.js";
import { migrateGraphState } from "../src/migration/graph.js";
import { DEFAULT_BUDGET } from "../src/graph/schema.js";
import { registerProject } from "../src/registry.js";
import type { ProjectConfig } from "../src/types.js";

async function initializeProject(root: string) {
  await git(root, ["init"]);
  await saveConfig(root, {
    schemaVersion: 1,
    projectRoot: root,
    preset: "balanced",
    initializedAt: new Date().toISOString(),
    connections: [],
    routes: {},
    overrides: {},
    verifierCommands: [],
    catalogVersion: 1,
  } as unknown as ProjectConfig);
}

it("provides graph snapshots, cursor streams and protected commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-api-"));
  await initializeProject(root);
  const contract = validateContract(
    {
      taskType: "planning_architecture",
      goal: "Explain",
      acceptanceCriteria: ["Explain"],
    },
    root,
  );
  const plan = await planRun(root, "Explain", { contract, mode: "answer" });
  const store = await storeFor(root, plan.runId);
  const dashboard = await startDashboard(root, { port: 0 });
  try {
    const api = (path: string, init?: RequestInit) =>
      fetch(`${dashboard.url}api/v2/${path}`, init);
    expect(
      ((await api("runs").then((r) => r.json())) as any).runs[0].runId,
    ).toBe(plan.runId);
    expect(
      ((await api(`runs/${plan.runId}/graph`).then((r) => r.json())) as any)
        .nodes[0].kind,
    ).toBe("read");
    expect(
      (
        await api("session", {
          headers: { Origin: "https://untrusted.invalid" },
        })
      ).status,
    ).toBe(403);
    const command = {
      commandId: "test-command",
      expectedRevision: 1,
      type: "stop" as const,
    };
    expect(
      (
        await api(`runs/${plan.runId}/commands`, {
          method: "POST",
          body: JSON.stringify(command),
        })
      ).status,
    ).toBe(403);
    const { controlToken } = (await api("session").then((r) =>
      r.json(),
    )) as any;
    expect(
      (
        await api(`runs/${plan.runId}/commands`, {
          method: "POST",
          headers: { "X-Ralph-Token": controlToken },
          body: JSON.stringify(command),
        })
      ).status,
    ).toBe(202);
    await submitCommand(store, command);
    expect(await pendingCommands(store)).toHaveLength(1);
    await expect(
      submitCommand(store, { ...command, type: "cancel" }),
    ).rejects.toThrow(/reused/);
    const controller = new AbortController();
    const response = await api(`runs/${plan.runId}/events?after=1`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toContain("id: 2");
    controller.abort();
    await reader.cancel().catch(() => {});
    expect(await api("metrics").then((r) => r.json())).toEqual([]);
    expect(await api("providers").then((r) => r.json())).toEqual([]);
    expect((await api(`runs/${plan.runId}/artifacts/invalid`)).status).toBe(
      400,
    );
    const dry = await migrateGraphState(root, true),
      written = await migrateGraphState(root, false),
      again = await migrateGraphState(root, false);
    expect(dry.id).toBe(written.id);
    expect(again.id).toBe(written.id);
    expect(written.sourceDeleted).toBe(false);
  } finally {
    dashboard.server.closeAllConnections();
    await new Promise<void>((r) => dashboard.server.close(() => r()));
  }
}, 15000);

it("keeps older runs in the dashboard across newly registered projects", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ralph-session-history-"));
  const root = join(temp, "primary"), other = join(temp, "secondary");
  for (const project of [root, other]) {
    await mkdir(project);
    await initializeProject(project);
  }
  vi.stubEnv("RALPH_CONFIG_HOME", join(temp, "config"));
  const dashboard = await startDashboard(root, { port: 0, all: true });
  try {
    const contract = validateContract(
      { taskType: "planning_architecture", goal: "Older graph", acceptanceCriteria: ["Explain"] },
      other,
    );
    const plan = await planRun(other, contract.goal, { contract, mode: "answer" });
    await Promise.all([
      registerProject(other),
      registerProject(join(temp, "removed")),
    ]);
    const { runs } = await statePaths(root);
    const current = new Date(Date.now() + 60_000).toISOString();
    await Promise.all(Array.from({ length: 30 }, async (_, index) => {
      const id = `legacy-${index}`;
      await mkdir(join(runs, id), { recursive: true });
      await writeFile(join(runs, id, "state.json"), JSON.stringify({
        id, taskType: "legacy run", status: "pass", startedAt: current,
      }));
    }));

    const api = (path: string) => fetch(`${dashboard.url}api/v2/${path}`);
    const page = await api("runs").then((r) => r.json()) as any;
    expect(page).toMatchObject({ total: 31 });
    expect(page.runs).toHaveLength(30);
    expect(page.runs.some((run: any) => run.runId === plan.runId)).toBe(false);
    const sidebar = await api("runs?view=sidebar").then((r) => r.json()) as any;
    expect(sidebar.runs.at(-1)).toMatchObject({
      runId: plan.runId, goal: contract.goal, projectRoot: other, projectName: "secondary",
    });
    const scope = new URLSearchParams({ project: other });
    const details = await api(`runs/${plan.runId}/graph?${scope}`).then((r) => r.json());
    expect(details).toMatchObject({ runId: plan.runId });
    expect((await api(`runs/${plan.runId}/graph`)).status).toBe(404);
    expect((await api(`runs?project=${encodeURIComponent(temp)}`)).status).toBe(403);
  } finally {
    dashboard.server.closeAllConnections();
    await new Promise<void>((resolve) => dashboard.server.close(() => resolve()));
    vi.unstubAllEnvs();
  }
});
