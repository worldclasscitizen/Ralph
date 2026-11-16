import { it, expect, vi } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WorkspaceManager,
  IntegrationConflict,
  git,
} from "../src/workspace/manager.js";
import { saveConfig } from "../src/state.js";
import { validateContract } from "../src/contracts.js";
import { planRun } from "../src/nodes/planner.js";
import { approvePlan } from "../src/interaction/approval.js";
import { startRun, resumeGraphRun } from "../src/runtime/supervisor.js";
import type { ProjectConfig, RouteEntry } from "../src/types.js";
import { singleGraph } from "../src/graph/compiler.js";
import { storeFor } from "../src/runtime/supervisor.js";
import { workerContract } from "../src/loop/runner.js";
import { criticPrompt } from "../src/prompts.js";
import { ProviderGateway } from "../src/gateway/gateway.js";
import { loadRubric } from "../src/evaluator.js";
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ralph-graph-e2e-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "baseline\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "baseline"]);
  const route: RouteEntry = {
    connectionId: "mock:process",
    provider: "mock",
    modelId: "mock-1",
    displayName: "Mock",
    reasoningEffort: "high",
    score: 100,
    source: "override",
  };
  const routes = Object.fromEntries(
    [
      "planning_architecture",
      "frontend_visual",
      "backend_core",
      "tdd_debugging",
      "static_review",
      "delivery_evidence",
      "contractPlanner",
      "router",
      "critic",
      "metaPrompter",
      "worker",
      "adjudicator",
    ].map((key) => [key, [route]]),
  ) as ProjectConfig["routes"];
  const config: ProjectConfig = {
    schemaVersion: 1,
    projectRoot: root,
    preset: "balanced",
    initializedAt: new Date().toISOString(),
    connections: [
      {
        id: route.connectionId,
        adapter: "generic-process",
        provider: "mock",
        enabled: true,
        mode: "process",
        command: [process.execPath, resolve("tests/fixtures/mock-agent.mjs")],
      },
    ],
    routes,
    overrides: {},
    verifierCommands: [
      `node -e "require('node:fs').accessSync('ralph-smoke.txt')"`,
      "git diff --check",
    ],
    catalogVersion: 2,
  };
  await saveConfig(root, config);
  const contract = validateContract(
    {
      taskType: "backend_core",
      goal: "Create smoke artifact",
      include: ["ralph-smoke.txt"],
      exclude: [".git/**"],
      acceptanceCriteria: ["Artifact exists"],
      verifierCommands: config.verifierCommands,
      requiredArtifacts: ["ralph-smoke.txt"],
    },
    root,
  );
  return { root, config, contract };
}
it("executes the real graph loop in isolated workspaces and delivers once", async () => {
  const { root, contract } = await fixture();
  const plan = await planRun(root, contract.goal, { contract, mode: "single" });
  await expect(startRun(plan)).rejects.toThrow(/approve/);
  const state = await startRun(approvePlan(plan));
  expect(state.message).toBeUndefined();
  expect(state.status).toBe("completed");
  const store = await storeFor(root, plan.runId);
  const worker = plan.graph.nodes.find((n) => n.kind === "worker")!;
  const validation = plan.graph.nodes.find((n) => n.kind === "validate")!;
  const workerEvidence = await store.artifact(state.nodes[worker.nodeId]!.result!.evidenceIds[0]!) as any;
  expect(workerEvidence.scope.stage).toBe("worker");
  expect(workerEvidence.execution).toMatchObject({ exitCode: 0, connectionId: "mock:process", modelId: "mock-1" });
  const finalEvidence = await store.artifact(state.nodes[validation.nodeId]!.result!.evidenceIds[0]!) as any;
  expect(finalEvidence.scope).toMatchObject({ stage: "integration", completedWorkers: [{ nodeId: worker.nodeId, outcome: "completed", evidenceIds: state.nodes[worker.nodeId]!.result!.evidenceIds }] });
  expect(finalEvidence.verifier.commands.map((c: any) => c.command)).toEqual(expect.arrayContaining(plan.envelope.verifierIds));
  expect(
    (await readFile(join(root, "ralph-smoke.txt"), "utf8")).replaceAll(
      "\r\n",
      "\n",
    ),
  ).toBe("ok\n");
  const head = await git(root, ["rev-parse", "HEAD"]);
  expect((await resumeGraphRun(root, plan.runId)).status).toBe("completed");
  expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
}, 30000);

it("projects local acceptance while preserving global requirements for final assessment and all safety constraints", async () => {
  const parent = validateContract({ taskType: "backend_core", goal: "Deliver two modules", include: ["left.mjs", "right.mjs"], exclude: ["*.test.mjs"], requirements: ["Use two workers", "Both modules pass full validation"], constraints: ["Never modify tests"], acceptanceCriteria: ["Both modules pass"], verifierCommands: ["left-check", "right-check"], requiredArtifacts: ["left.mjs", "right.mjs"] }, "/project");
  const original = structuredClone(parent);
  const node = singleGraph("test", { taskType: parent.taskType, goal: "Implement left", readPaths: ["**"], writePaths: ["left.mjs"], acceptanceCriteria: ["Left boundary cases pass"], verifierIds: ["left-check"], requiredCapabilities: [], inputArtifacts: [], budget: { maxIterations: 6 } }).nodes[0]!;
  const local = workerContract(parent, node, "/worktree");
  expect(local).toMatchObject({ requirements: node.acceptanceCriteria, verifierCommands: ["left-check"], requiredArtifacts: ["left.mjs"], constraints: original.constraints, exclude: original.exclude });
  expect(parent).toEqual(original);
  const evidence = { head: "head", status: "M left.mjs", diff: "patch", verifier: "left-check exit=0", execution: { exitCode: 0, connectionId: "connection", modelId: "model" }, scope: { stage: "worker" as const, nodeId: node.nodeId, inputHead: "base", dependencies: [] } };
  for (const phase of ["post", "adjudication"] as const) {
    const prompt = await criticPrompt(local, phase, evidence);
    expect(prompt).not.toContain("Both modules pass full validation");
    expect(prompt).toContain('"exitCode":0');
    const task = JSON.parse(prompt.match(/작업별 rubric:\n([^\n]+)/)![1]!);
    const rubric = await loadRubric(parent.taskType);
    expect(task.criteria.map(({ id, weight }: any) => ({ id, weight }))).toEqual(rubric.task.criteria.map(({ id, weight }) => ({ id, weight })));
    expect(task.hardGates).toEqual(rubric.task.hardGates);
  }
  const final = await criticPrompt(parent, "post", { ...evidence, scope: { ...evidence.scope, stage: "integration" } });
  expect(final).toContain("Both modules pass full validation");
  expect(final).toContain("right-check");
});

it.each(["validation", "merge"])(
  "executes fan-out and repairs %s failure while keeping original generations",
  async (failure) => {
    const { root, config } = await fixture();
    const checkLeft = `node -e "require('fs').accessSync('left.txt')"`;
    const checkRight = `node -e "require('fs').accessSync('right.txt')"`;
    const checkCombined = `node -e "if(require('fs').readFileSync('left.txt','utf8').trim()!=='ok')process.exit(1)"`;
    config.verifierCommands = [
      checkLeft,
      checkRight,
      checkCombined,
      "git diff --check",
    ];
    await saveConfig(root, config);
    const contract = validateContract(
      {
        taskType: "backend_core",
        goal: "Produce two independently verified artifacts and verify their integration",
        include: ["left.txt", "right.txt"],
        acceptanceCriteria: ["left and right contain ok"],
        verifierCommands: config.verifierCommands,
        requiredArtifacts: ["left.txt", "right.txt"],
      },
      root,
    );
    const task = {
      taskType: contract.taskType,
      goal: contract.goal,
      readPaths: ["**"],
      writePaths: ["left.txt"],
      acceptanceCriteria: ["left exists"],
      requiredCapabilities: [],
      inputArtifacts: [],
      verifierIds: [checkLeft],
      budget: { maxIterations: 6 },
    };
    const graph = singleGraph("proposed", task);
    graph.nodes[0]!.nodeId = "left";
    graph.edges[0]!.from = "left";
    graph.nodes.splice(1, 0, {
      ...graph.nodes[0]!,
      nodeId: "right",
      writePaths: ["right.txt"],
      acceptanceCriteria: ["right exists"],
      verifierIds: [checkRight],
    });
    graph.edges.push({ from: "right", to: "integrate", kind: "artifact" });
    const plan = await planRun(root, contract.goal, { contract, graph });
    const prepare = WorkspaceManager.prototype.prepare;
    let injected = false;
    const spy = vi
      .spyOn(WorkspaceManager.prototype, "prepare")
      .mockImplementation(async function (...args) {
        const input = await prepare.apply(this, args);
        if (failure === "merge" && args[0] === "integrate" && !injected) {
          injected = true;
          await writeFile(
            join(input.root, "left.txt"),
            "<<<<<<< ours\ninitial\n=======\nok\n>>>>>>> theirs\n",
          );
          const head = await this.checkpoint(input.root, "integrate", 0, 0);
          throw new IntegrationConflict({
            ...input,
            inputHead: head,
            conflictErrors: [
              {
                nodeId: "left",
                message: "Injected Git conflict boundary",
                patch: "preserved in source snapshot",
              },
            ],
          });
        }
        return input;
      });
    let result;
    try {
      result = await startRun(approvePlan(plan));
    } finally {
      spy.mockRestore();
    }
    expect(result.message).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result.revision).toBe(2);
    expect(result.nodes.left?.generation).toBe(0);
    expect(result.nodes.right?.generation).toBe(0);
    expect(result.nodes.repair?.status).toBe("completed");
    expect(result.nodes.validate?.generation).toBe(1);
    expect((await readFile(join(root, "left.txt"), "utf8")).trim()).toBe("ok");
    const store = await storeFor(root, plan.runId),
      events = await store.readAfter();
    expect(
      events.filter(
        (e) =>
          e.type === "invocation.started" &&
          e.payload.nodeId === "left" &&
          e.payload.role === "worker",
      ),
    ).toHaveLength(1);
    expect(events.filter((e) => e.type === "graph.revised")).toHaveLength(2);
    expect((await resumeGraphRun(root, plan.runId)).resultHead).toBe(
      result.resultHead,
    );
  },
  30000,
);

it.each(["dirty", "head", "saved-plan"])(
  "blocks changed %s inputs after approval",
  async (change) => {
    const { root, contract } = await fixture();
    const plan = approvePlan(
      await planRun(root, contract.goal, { contract, mode: "single" }),
    );
    if (change === "saved-plan") {
      const store = await storeFor(root, plan.runId);
      await writeFile(
        join(store.directory, "plan.json"),
        JSON.stringify({ ...plan, baseBranch: "other" }),
      );
    } else {
      await writeFile(join(root, "user.txt"), "User data");
      if (change === "head") {
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "User commit"]);
      }
    }
    const state = await startRun(plan);
    expect(state.status).not.toBe("completed");
    expect(state.attempts).toBe(0);
    expect(await git(root, ["worktree", "list", "--porcelain"])).not.toContain(
      "workspaces",
    );
  },
);
it("persists command results, pauses before dispatch and resumes the same read run", async () => {
  const { root, contract } = await fixture();
  const plan = approvePlan(
    await planRun(root, "Explain the project", { contract, mode: "answer" }),
  );
  const store = await storeFor(root, plan.runId);
  const { submitCommand } = await import("../src/runtime/commands.js");
  await submitCommand(store, {
    commandId: "stop-once",
    expectedRevision: 1,
    type: "stop",
  });
  const paused = await startRun(plan);
  expect(paused.status).toBe("paused");
  expect(paused.attempts).toBe(0);
  expect(paused.commands["stop-once"]).toEqual({ accepted: true });
  const result = await resumeGraphRun(root, plan.runId);
  expect(result.status).toBe("completed");
  expect(result.attempts).toBe(1);
  expect(Object.keys(result.nodes)).toEqual(["answer"]);
  const { watchRun } = await import("../src/runtime/supervisor.js");
  const events = [];
  for await (const e of watchRun(root, plan.runId, result.seq - 1))
    events.push(e);
  expect(events).toHaveLength(1);
});
it("cancellation is terminal and does not dispatch pending workers", async () => {
  const { root, contract } = await fixture();
  const plan = approvePlan(
    await planRun(root, contract.goal, { contract, mode: "single" }),
  );
  const store = await storeFor(root, plan.runId);
  const { submitCommand } = await import("../src/runtime/commands.js");
  await submitCommand(store, {
    commandId: "cancel-once",
    expectedRevision: 1,
    type: "cancel",
  });
  expect((await startRun(plan)).status).toBe("cancelled");
  expect((await resumeGraphRun(root, plan.runId)).attempts).toBe(0);
});
it("resume refuses unconfirmed invocations and exhausted active budgets", async () => {
  for (const kind of ["uncertain", "budget"]) {
    const { root, contract } = await fixture();
    const plan = approvePlan(
      await planRun(root, contract.goal, { contract, mode: "single" }),
    );
    const store = await storeFor(root, plan.runId);
    await writeFile(join(store.directory, "plan.json"), JSON.stringify(plan));
    await store.acquire();
    if (kind === "uncertain")
      await store.append(
        {
          type: "invocation.started",
          payload: {
            invocationId: "logical",
            attemptId: "lost",
            nodeId: "work",
            connectionId: "mock:process",
            modelId: "mock-1",
            role: "worker",
          },
        },
        1,
      );
    else
      await store.append(
        { type: "runtime.elapsed", payload: { ms: plan.budget.activeMs } },
        1,
      );
    await store.release();
    const state = await resumeGraphRun(root, plan.runId);
    expect(state.status).toBe("awaiting_input");
    expect(state.message).toMatch(
      kind === "uncertain" ? /no confirmed outcome/ : /budget exhausted/,
    );
    expect(state.nodes.work?.status).toBe("pending");
  }
});
it("resumes explicitly reconciled calls without resetting attempt accounting", async () => {
  const { root, contract } = await fixture();
  const plan = approvePlan(await planRun(root, contract.goal, { contract, mode: "single" }));
  const store = await storeFor(root, plan.runId);
  await writeFile(join(store.directory, "plan.json"), JSON.stringify(plan));
  await store.acquire();
  await store.append({ type: "invocation.started", payload: { invocationId: "logical", attemptId: "inspected", nodeId: "work", connectionId: "mock:process", modelId: "mock-1", role: "worker" } }, 1);
  const artifactId = await store.putArtifact({ inspection: "Fixture process outcome explicitly inspected" });
  await store.append({ type: "invocation.reconciled", payload: { attemptId: "inspected", artifactId, processStopped: true, inspectionDigest: "a".repeat(64) } }, 1);
  await store.release();
  const state = await resumeGraphRun(root, plan.runId);
  expect(state.status).toBe("completed");
  expect(state.attempts).toBe(4);
  expect((await store.readAfter()).filter(e => e.type === "invocation.finished")).toHaveLength(3);
}, 30000);
it("requires final T3 confirmation after validation and applies it exactly once", async () => {
  const { root, contract } = await fixture();
  contract.riskTier = "T3";
  const plan = approvePlan(
    await planRun(root, contract.goal, { contract, mode: "single" }),
  );
  const state = await startRun(plan);
  expect(state.status).toBe("awaiting_input");
  expect(state.message).toMatch(/T3/);
  expect(await git(root, ["rev-parse", "HEAD"])).toBe(plan.baseHead);
  const store = await storeFor(root, plan.runId);
  const { submitCommand } = await import("../src/runtime/commands.js");
  await submitCommand(store, {
    commandId: "t3-final",
    expectedRevision: state.revision,
    type: "approve_final",
  });
  const result = await resumeGraphRun(root, plan.runId);
  expect(result.status).toBe("completed");
  expect(result.attempts).toBe(state.attempts);
  expect(
    await git(root, ["rev-list", "--count", `${plan.baseHead}..HEAD`]),
  ).toBe("1");
}, 30000);

it.each(["running", "verifying", "retry_wait", "blocked"])(
  "resumes a reconciled %s node without resetting iterations",
  async (status) => {
    const { root, contract } = await fixture();
    const plan = approvePlan(
      await planRun(root, "Explain repository", { contract, mode: "answer" }),
    );
    const store = await storeFor(root, plan.runId);
    await writeFile(join(store.directory, "plan.json"), JSON.stringify(plan));
    await store.acquire();
    await store.append(
      {
        type: "node.status",
        payload: {
          nodeId: "answer",
          generation: 0,
          status: "running",
          iteration: 2,
        },
      },
      1,
    );
    if (status !== "running")
      await store.append(
        {
          type: "node.status",
          payload: { nodeId: "answer", generation: 0, status: status as any },
        },
        1,
      );
    await store.release();
    const result = await resumeGraphRun(root, plan.runId);
    expect(result.status).toBe("completed");
    expect(result.nodes.answer?.iteration).toBe(2);
    expect(result.attempts).toBe(1);
  },
);
it("records stale queued commands as conflicts and keeps provider failures blocked", async () => {
  const { root, contract, config } = await fixture();
  config.connections = [];
  const plan = approvePlan(
    await planRun(root, "Explain project", {
      contract,
      config,
      mode: "answer",
    }),
  );
  const store = await storeFor(root, plan.runId);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(store.directory, "commands"), { recursive: true });
  await writeFile(
    join(store.directory, "commands", "stale.json"),
    JSON.stringify({ commandId: "stale", expectedRevision: 9, type: "cancel" }),
  );
  const result = await startRun(plan);
  expect(result.status).toBe("awaiting_input");
  expect(result.commands.stale).toEqual({ error: "revision_conflict" });
  expect(result.nodes.answer?.status).toBe("blocked");
  expect(result.attempts).toBe(0);
});

it("applies direction at a worker boundary and reuses independent verified work", async () => {
  const { root, config } = await fixture();
  const checks = ["git diff --check"];
  config.verifierCommands = checks;
  await saveConfig(root, config);
  const contract = validateContract({
    taskType: "backend_core",
    goal: "Produce two independent text artifacts",
    include: ["left.txt", "right.txt"],
    acceptanceCriteria: ["Both artifacts exist"],
    verifierCommands: checks,
    requiredArtifacts: ["left.txt", "right.txt"],
  }, root);
  const graph = singleGraph("proposed", {
    taskType: contract.taskType, goal: "Write the left artifact", readPaths: ["**"],
    writePaths: ["left.txt"], acceptanceCriteria: ["Left artifact exists"],
    requiredCapabilities: [], inputArtifacts: [], verifierIds: checks,
    budget: { maxIterations: 6 },
  });
  const left = graph.nodes[0]!;
  left.nodeId = "left";
  graph.edges[0]!.from = "left";
  graph.nodes.splice(1, 0, {
    ...left, nodeId: "right", goal: "Write the right artifact", writePaths: ["right.txt"],
    acceptanceCriteria: ["Right artifact exists"],
  });
  graph.edges.push({ from: "right", to: "integrate", kind: "artifact" });
  const plan = approvePlan(await planRun(root, contract.goal, { contract, graph }));
  const store = await storeFor(root, plan.runId);
  const { submitCommand } = await import("../src/runtime/commands.js");
  const { promise, resolve } = Promise.withResolvers<void>();
  const prepare = WorkspaceManager.prototype.prepare;
  const spy = vi.spyOn(WorkspaceManager.prototype, "prepare")
    .mockImplementation(async function (...args) {
      if (args[0] === "right" && args[1] === 0) await promise;
      return prepare.apply(this, args);
    });
  const run = startRun(plan);
  const command = {
    commandId: "new-label", expectedRevision: 1, type: "steer" as const,
    nodeId: "right", instruction: "Use the revised label",
  };
  try {
    await vi.waitFor(async () => {
      const state = await store.state();
      expect(state.nodes.left?.status).toBe("completed");
      expect(state.nodes.right?.status).toBe("running");
    }, { timeout: 5000 });
    await submitCommand(store, {
      ...command, commandId: "increase-risk", instruction: "Change billing permissions",
    });
    await submitCommand(store, command);
    await vi.waitFor(async () => {
      expect((await store.state()).commands["increase-risk"]).toMatchObject({
        error: expect.stringMatching(/increase the approved risk/),
      });
    }, { timeout: 5000 });
    expect((await store.state()).revision).toBe(1);
  } finally {
    resolve();
    await run;
    spy.mockRestore();
  }
  const result = await run;
  expect(result.status, result.message).toBe("completed");
  expect(result.latestDirection).toMatchObject({
    commandId: command.commandId, reused: ["left"], rerun: ["right", "integrate", "validate"],
  });
  expect(result.nodes.left?.generation).toBe(0);
  expect(result.nodes.right?.generation).toBe(1);
  expect((await readFile(join(root, "right.txt"), "utf8")).trim()).toBe("revised");
  expect(await submitCommand(store, command)).toEqual({ created: false });
  expect(await resumeGraphRun(root, plan.runId)).toMatchObject({ revision: 2, resultHead: result.resultHead });
}, 30000);

it("explicitly discards a running change without touching the original branch or user files", async () => {
  const { root, contract } = await fixture();
  const plan = approvePlan(await planRun(root, contract.goal, { contract, mode: "single" }));
  const store = await storeFor(root, plan.runId);
  const { submitCommand } = await import("../src/runtime/commands.js");
  const { promise, resolve } = Promise.withResolvers<void>();
  const prepare = WorkspaceManager.prototype.prepare;
  const spy = vi.spyOn(WorkspaceManager.prototype, "prepare")
    .mockImplementation(async function (...args) {
      const input = await prepare.apply(this, args);
      if (args[0] === "work") {
        await writeFile(join(input.root, "ralph-smoke.txt"), "partial\n");
        await promise;
      }
      return input;
    });
  const run = startRun(plan);
  try {
    await vi.waitFor(async () => {
      expect(await git(root, ["worktree", "list", "--porcelain"])).toContain("workspaces");
    }, { timeout: 5000 });
    await writeFile(join(root, "user.txt"), "my edit\n");
    await submitCommand(store, { commandId: "throw-away", expectedRevision: 1, type: "discard" });
    await vi.waitFor(async () => {
      expect((await store.state()).commands["throw-away"]).toEqual({ accepted: true, discard: true });
    }, { timeout: 5000 });
  } finally {
    resolve();
    await run;
    spy.mockRestore();
  }
  expect(await run).toMatchObject({ status: "cancelled", message: "Run changes discarded." });
  expect(await git(root, ["rev-parse", "HEAD"])).toBe(plan.baseHead);
  expect(await git(root, ["worktree", "list", "--porcelain"])).not.toContain("workspaces");
  expect(await readFile(join(root, "user.txt"), "utf8")).toBe("my edit\n");
  await expect(readFile(join(root, "ralph-smoke.txt"))).rejects.toMatchObject({ code: "ENOENT" });
}, 30000);

it.each(["relative", "absolute", "without-audit"])(
  "diagnoses a final review exception and respects the %s adapter worktree boundary",
  async (location) => {
    const { root, config, contract } = await fixture();
    const path = "review.mjs";
    const working = await readFile(resolve("tests/fixtures/mock-agent.mjs"), "utf8");
    const faulty = working.replace('let text = "";', `let text = "";
if (request.nodeId === "validate") {
  console.error("ENOENT: evidence/validate.json");
  process.exit(1);
}`);
    await writeFile(join(root, path), faulty);
    await git(root, ["add", path]);
    await git(root, ["commit", "-m", "Add review adapter"]);
    const reviewConnection = "mock:review";
    config.connections.push({
      ...config.connections[0]!,
      id: reviewConnection,
      command: [process.execPath, location === "absolute" ? join(root, path) : "./" + path],
    });
    config.routes.critic = [{ ...config.routes.critic[0]!, connectionId: reviewConnection }];
    if (location === "without-audit") config.routes.adjudicator = config.routes.critic;
    const plan = approvePlan(await planRun(root, contract.goal, {
      contract: { ...contract, include: [...contract.include, path] },
      mode: "single",
      config,
    }));
    const original = ProviderGateway.prototype.invoke;
    const spy = vi.spyOn(ProviderGateway.prototype, "invoke").mockImplementation(
      async function (this: ProviderGateway, ...args) {
        const [routes, request] = args;
        if (request.role === "contractPlanner" && request.nodeId === "validate") {
          expect(request.prompt).toContain("evidence/validate.json");
          expect(request.writePaths).toEqual([]);
          return {
            route: routes[0]!,
            result: { exitCode: 0, text: JSON.stringify({
              action: "repair", diagnosis: "Review adapter reads the wrong evidence path.",
              instruction: "Correct the final evidence path.", paths: [path],
            }) },
          };
        }
        if (request.role === "worker" && request.nodeId === "repair") {
          expect(request.writePaths).toEqual([path]);
          await writeFile(join(request.projectRoot, path), working);
          return { route: routes[0]!, result: { exitCode: 0, text: "Corrected review adapter." } };
        }
        return original.apply(this, args);
      },
    );
    let result;
    try {
      result = await startRun(plan);
    } finally {
      spy.mockRestore();
    }
    const store = await storeFor(root, plan.runId);
    const events = await store.readAfter();
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
      type: "node.status", payload: expect.objectContaining({
        nodeId: "validate", status: "blocked", failure: { code: "unknown", stage: "review" },
      }),
    })]));
    if (location !== "relative") {
      expect(result.status).toBe("awaiting_input");
      if (location === "without-audit") expect(result.message).toContain("별도 승인 경로");
      expect(result.latestRecovery).toBeUndefined();
      expect(result.nodes.validate?.error).toContain("evidence/validate.json");
      expect(await readFile(join(root, path), "utf8")).toBe(faulty);
    } else {
      expect(result.status).toBe("completed");
      expect(result.message).toBeUndefined();
      expect(result.latestRecovery).toMatchObject({
        nodeId: "validate", action: "repair", workerId: "repair", reused: ["work"],
      });
      expect(result.nodes.work?.generation).toBe(0);
      expect(result.nodes.validate?.generation).toBe(1);
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
        type: "invocation.started", payload: expect.objectContaining({
          nodeId: "repair", role: "critic", connectionId: "mock:process",
        }),
      })]));
      expect(await readFile(join(root, path), "utf8")).toBe(working);
    }
  },
);

it("retries a transient final review without running the completed nodes again", async () => {
  const { root, contract } = await fixture();
  const plan = approvePlan(await planRun(root, contract.goal, { contract, mode: "single" }));
  const original = ProviderGateway.prototype.invoke;
  let failed = false;
  const spy = vi.spyOn(ProviderGateway.prototype, "invoke").mockImplementation(
    async function (this: ProviderGateway, ...args) {
      const request = args[1];
      if (request.nodeId === "validate" && !failed) {
        failed = true;
        throw Object.assign(new Error("Temporary local process resource limit"), { code: "EAGAIN" });
      }
      return original.apply(this, args);
    },
  );
  try {
    const result = await startRun(plan);
    expect(result.status).toBe("completed");
    expect(result.latestRecovery).toMatchObject({
      nodeId: "validate", action: "retry", rerun: ["validate"], reused: ["work", "integrate"],
    });
    expect(result.nodes.validate?.generation).toBe(1);
    expect(result.nodes.integrate?.generation).toBe(0);
    expect(result.nodes.work?.iteration).toBe(1);
  } finally {
    spy.mockRestore();
  }
});

it.each(["repair", "dependency"] as const)(
  "recovers a blocked worker with %s while preserving completed independent output",
  async (action) => {
    const { root, config } = await fixture();
    const leftCheck = action === "repair"
      ? `node -e "if(require('fs').readFileSync('left.txt','utf8').trim()!=='fixed')process.exit(1)"`
      : `node -e "require('fs').accessSync('right.txt')"`;
    const rightCheck = `node -e "require('fs').accessSync('right.txt')"`;
    const commands = [...new Set([leftCheck, rightCheck])];
    config.verifierCommands = commands;
    const contract = validateContract({
      taskType: "backend_core", goal: "Build two checked artifacts",
      include: ["left.txt", "right.txt", "partial.txt"],
      acceptanceCriteria: ["Both outputs pass verification"],
      verifierCommands: commands,
      requiredArtifacts: ["left.txt", "right.txt", "partial.txt"],
    }, root);
    const graph = singleGraph("proposed", {
      taskType: contract.taskType, goal: "Write left", readPaths: ["**"],
      writePaths: ["left.txt", "partial.txt"], acceptanceCriteria: ["Left passes its check"],
      requiredCapabilities: [], inputArtifacts: [], verifierIds: [leftCheck],
      budget: { maxIterations: 4 },
    });
    const left = graph.nodes[0]!;
    left.nodeId = "left";
    graph.edges[0]!.from = "left";
    graph.nodes.splice(1, 0, {
      ...left, nodeId: "right", goal: "Provide right output", writePaths: ["right.txt"], verifierIds: [rightCheck],
    });
    graph.edges.push({ from: "right", to: "integrate", kind: "artifact" });
    const plan = approvePlan(await planRun(root, contract.goal, { contract, graph, config }));
    const original = ProviderGateway.prototype.invoke;
    const spy = vi.spyOn(ProviderGateway.prototype, "invoke").mockImplementation(
      async function (this: ProviderGateway, ...args) {
        const [routes, request] = args;
        if (request.nodeId === "left" && request.role === "contractPlanner") {
          return {
            route: routes[0]!,
            result: { exitCode: 0, text: JSON.stringify(action === "repair"
              ? { action, diagnosis: "Only the left content failed.", paths: ["left.txt"], instruction: "Change left.txt to fixed." }
              : { action, diagnosis: "Left requires the verified right artifact.", dependencies: ["right"] }) },
          };
        }
        if (request.role === "worker" && (request.nodeId === "left" || request.nodeId.startsWith("recover-"))) {
          if (request.nodeId === "left") {
            await writeFile(join(request.projectRoot, "left.txt"), "initial\n");
            await writeFile(join(request.projectRoot, "partial.txt"), "preserved\n");
          } else {
            expect(request.writePaths).toEqual(["left.txt"]);
            expect(await readFile(join(request.projectRoot, "partial.txt"), "utf8")).toBe("preserved\n");
            await writeFile(join(request.projectRoot, "left.txt"), "fixed\n");
          }
          return { route: routes[0]!, result: { exitCode: 0, text: "Wrote left output." } };
        }
        return original.apply(this, args);
      },
    );
    let result;
    try {
      result = await startRun(plan);
    } finally {
      spy.mockRestore();
    }
    expect(result.status, result.message).toBe("completed");
    expect(result.latestRecovery).toMatchObject({ nodeId: "left", action, reused: ["right"] });
    expect(result.nodes.right?.generation).toBe(0);
    expect(result.nodes.right?.iteration).toBe(1);
    expect(await readFile(join(root, "partial.txt"), "utf8")).toBe("preserved\n");
    if (action === "dependency") {
      const store = await storeFor(root, plan.runId);
      expect((await store.graph()).edges).toContainEqual({ from: "right", to: "left", kind: "artifact" });
      expect(result.nodes.left?.generation).toBe(1);
    } else {
      expect(await readFile(join(root, "left.txt"), "utf8")).toBe("fixed\n");
      expect(result.latestRecovery?.workerId).toMatch(/^recover-/);
    }
  },
);
