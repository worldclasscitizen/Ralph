import { recoverOwner } from "./recovery.js";
import { ConnectionLimits } from "../gateway/limits.js";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  assertPlanApproved,
  planHash,
  type ExecutionPlan,
} from "../interaction/approval.js";
import { statePaths } from "../state.js";
import { RunStore } from "../storage/run-store.js";
import { durableWrite } from "../storage/journal.js";
import { NodeExecutionError, schedule } from "../graph/scheduler.js";
import {
  artifactAncestors,
  topological,
  compileGraph,
} from "../graph/compiler.js";
import {
  digest,
  type NodeResult,
  type NodeSpec,
  type GraphRunState,
} from "../graph/schema.js";
import { ProviderGateway } from "../gateway/gateway.js";
import { routesFor } from "../gateway/routing.js";
import { BudgetCounter } from "./budget.js";
import { pendingCommands } from "./commands.js";
import { recoverFailedNode, reviewerRepairAudit } from "./failure-recovery.js";
import {
  IntegrationConflict,
  WorkspaceManager,
  git,
} from "../workspace/manager.js";
import { deliverResult } from "../workspace/integration.js";
import { runRalphLoop } from "../loop/runner.js";
import { runVerifier } from "../verifier.js";
import { gitHead, gitStatus } from "../git.js";
import { classifyRisk } from "../policy.js";
import { criticPrompt } from "../prompts.js";
import { evaluateAssessment, validateAssessment } from "../evaluator.js";
import { parseJsonObject, RalphError, redact } from "../util.js";

export async function storeFor(
  projectRoot: string,
  runId: string,
): Promise<RunStore> {
  return new RunStore((await statePaths(projectRoot)).root, runId);
}
export async function startRun(
  approved: ExecutionPlan,
  options: { signal?: AbortSignal; resume?: boolean } = {},
): Promise<GraphRunState> {
  assertPlanApproved(approved);
  let plan = structuredClone(approved);
  const store = await storeFor(plan.projectRoot, plan.runId);
  if (options.resume) await recoverOwner(store.root);
  await store.acquire();
  let lastClock = Date.now();
  let clockActive = false;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  let commandLoop: Promise<void> = Promise.resolve();
  const stop = () =>
    controller.abort(new Error("Execution stopped; partial work is retained"));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await store.journal.read(true);
    let state = await store.state();
    if (["completed", "cancelled"].includes(state.status)) return state;
    try {
      const saved = JSON.parse(
        await readFile(join(store.directory, "plan.json"), "utf8"),
      ) as ExecutionPlan;
      if (planHash(saved) !== planHash(approved))
        throw new RalphError(
          "Saved plan changed after approval",
          "approval_required",
          10,
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (!options.resume && (await gitHead(plan.projectRoot)) !== plan.baseHead)
      throw new RalphError(
        "Project HEAD changed after planning",
        "approval_required",
        10,
      );
    if (!options.resume && (await gitStatus(plan.projectRoot)).trim())
      throw new RalphError(
        "Start requires a clean working tree",
        "dirty_worktree",
        3,
      );
    await durableWrite(
      join(store.directory, "plan.json"),
      JSON.stringify(plan),
    );
    if (!Object.keys(state.nodes).length)
      await store.append(
        { type: "graph.revised", payload: { graph: plan.graph } },
        1,
      );
    else plan.graph = compileGraph(await store.graph(), plan.envelope);
    const events = await store.readAfter();
    const finished = new Set(
      events
        .filter(
          (e) =>
            e.type === "invocation.finished" ||
            e.type === "invocation.reconciled",
        )
        .map((e) =>
          e.type === "invocation.finished" || e.type === "invocation.reconciled"
            ? e.payload.attemptId
            : "",
        ),
    );
    if (
      options.resume &&
      events.some(
        (e) =>
          e.type === "invocation.started" && !finished.has(e.payload.attemptId),
      )
    )
      throw new RalphError(
        "An invocation has no confirmed outcome. Inspect preserved work and process state before starting a new plan.",
        "uncertain_invocation",
        10,
      );
    const budget = new BudgetCounter(
      plan.budget,
      state.attempts,
      state.activeMs,
    );
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(budget.remainingMs()),
      ...(options.signal ? [options.signal] : []),
    ]);
    const gateway = new ProviderGateway(plan.config, budget, (event) =>
      store.append(event, plan.graph.revision),
    );
    for (const e of events)
      if (e.type === "circuit.changed")
        gateway.circuits.restore(e.payload.key, e.payload.retryAt);
    const verificationLimits = new ConnectionLimits(1);
    const manager = new WorkspaceManager(
      plan.projectRoot,
      store,
      plan.baseHead,
    );
    const deliveryReceipt = join(store.directory, "integration", "delivery.json");
    let finalApproved = events.some(
      (e) => e.graphRevision === plan.graph.revision &&
        e.type === "command.applied" &&
        (e.payload.result as { finalApproval?: boolean })?.finalApproval,
    );
    lastClock = Date.now();
    clockActive = true;
    const processCommands = async () => {
      for (const cmd of await pendingCommands(store)) {
        if (cmd.expectedRevision !== plan.graph.revision) {
          await store.append(
            {
              type: "command.applied",
              payload: {
                commandId: cmd.commandId,
                result: { error: "revision_conflict" },
              },
            },
            plan.graph.revision,
          );
          continue;
        }
        if (cmd.type === "approve_final") finalApproved = true;
        if (cmd.type === "cancel") cancelled = true;
        await store.append(
          {
            type: "command.applied",
            payload: {
              commandId: cmd.commandId,
              result: {
                accepted: true,
                ...(cmd.type === "approve_final"
                  ? { finalApproval: true }
                  : {}),
                ...(cmd.note ? { note: redact(cmd.note) } : {}),
              },
            },
          },
          plan.graph.revision,
        );
        if (cmd.type === "stop" || cmd.type === "cancel") stop();
      }
      const now = Date.now();
      await store.append(
        { type: "runtime.elapsed", payload: { ms: now - lastClock } },
        plan.graph.revision,
      );
      budget.activeMs += now - lastClock;
      lastClock = now;
    };
    await processCommands();
    timer = setInterval(() => {
      commandLoop = commandLoop
        .then(processCommands)
        .catch((e) => controller.abort(e));
    }, 1000);
    await store.append(
      { type: "run.status", payload: { status: "running" } },
      plan.graph.revision,
    );
    if (options.resume) {
      state = await store.state();
      for (const n of plan.graph.nodes) {
        const s = state.nodes[n.nodeId];
        if (s && ["running", "verifying", "retry_wait"].includes(s.status))
          await store.append(
            {
              type: "node.status",
              payload: {
                nodeId: n.nodeId,
                generation: n.generation,
                status: "interrupted",
              },
            },
            plan.graph.revision,
          );
        if (
          s &&
          !["completed", "cancelled", "pending", "queued"].includes(s.status)
        )
          await store.append(
            {
              type: "node.status",
              payload: {
                nodeId: n.nodeId,
                generation: n.generation,
                status: "pending",
              },
            },
            plan.graph.revision,
          );
      }
    }
    const dependencies = async (node: NodeSpec, plan: ExecutionPlan): Promise<NodeResult[]> => {
      const current = await store.state();
      return topological(plan.graph)
        .filter((id) => artifactAncestors(plan.graph, node.nodeId).has(id))
        .map((id) => current.nodes[id]?.result)
        .filter((r): r is NodeResult =>
          Boolean(
            r?.outcome === "completed" &&
            ["worker", "read"].includes(
              plan.graph.nodes.find((n) => n.nodeId === r.nodeId)?.kind ?? "",
            ),
          ),
        );
    };
    const execute = async (node: NodeSpec, signal: AbortSignal, plan: ExecutionPlan): Promise<NodeResult> => {
      if (node.kind === "worker") {
        const rows = node.nodeId === "repair" || node.nodeId.startsWith("recover-")
          ? await store.readAfter()
          : [];
        const event = rows.findLast(
          (e) => e.type === "graph.revised" && e.payload.recovery?.workerId === node.nodeId &&
            e.payload.graph.nodes.some((n) => n.nodeId === node.nodeId && n.generation === node.generation),
        );
        const recovery = event?.type === "graph.revised" ? event.payload.recovery : undefined;
        const source = rows.findLast((e) =>
          e.type === "node.status" &&
          (recovery
            ? e.seq < event!.seq && e.payload.nodeId === recovery.nodeId &&
              e.payload.generation === recovery.generation && ["blocked", "failed"].includes(e.payload.status)
            : node.nodeId === "repair" && plan.graph.reason === "repair" &&
              e.graphRevision === plan.graph.parentRevision && e.payload.status === "failed" &&
              plan.graph.nodes.some((n) => n.nodeId === e.payload.nodeId && ["integrate", "validate"].includes(n.kind))),
        );
        const previous = source?.type === "node.status" ? source.payload.result : undefined;
        const fix = recovery?.evidenceId
          ? await store.artifact(recovery.evidenceId) as { paths: string[]; instruction: string }
          : undefined;
        const outcome = await runRalphLoop({
          inputBase: recovery?.inputHead ?? previous?.outputHead,
          repairEvidence: rows.length
            ? {
                instruction: fix?.instruction,
                evidence: await Promise.all((previous?.evidenceIds ?? []).map((id) => store.artifact(id))),
              }
            : undefined,
          repairPaths: fix?.paths,
          reviewRoute: fix && node.nodeId === "repair" ? reviewerRepairAudit(plan) : undefined,
          plan,
          node,
          store,
          gateway,
          manager,
          dependencies: await dependencies(node, plan),
          signal,
          verificationLimits,
        });
        return recovery?.patchBase
          ? { ...outcome, inputHead: recovery.patchBase }
          : outcome;
      }
      if (node.kind === "read") {
        const r = routesFor(plan.config, plan.contract, "contractPlanner");
        const outcome = await gateway.invoke(
          r.routes,
          {
            runId: plan.runId,
            nodeId: node.nodeId,
            role: "contractPlanner",
            projectRoot: plan.projectRoot,
            prompt: `Read-only response. Do not modify files. ${plan.context.request}\nContext: ${JSON.stringify(plan.context.sources)}`,
          },
          signal,
          undefined,
          r.hardPin,
        );
        const artifactId = await store.putArtifact({
          summary: redact(outcome.result.text),
        });
        return {
          nodeId: node.nodeId,
          generation: node.generation,
          inputDigest: digest(plan.context),
          outcome: "completed",
          artifactIds: [artifactId],
          evidenceIds: [],
          summary: redact(outcome.result.text),
        };
      }
      if (node.kind === "integrate") {
        let input;
        try {
          const repair =
            plan.graph.reason === "repair"
              ? (await store.state()).nodes.repair?.result
              : undefined;
          input = await manager.prepare(
            node.nodeId,
            node.generation,
            repair?.outputHead ? [] : await dependencies(node, plan),
            { baseHead: repair?.outputHead, retainConflicts: true },
          );
        } catch (e) {
          if (!(e instanceof IntegrationConflict)) throw e;
          const artifactId = await store.putArtifact({
            summary: "Resolve conflicts against the complete approved contract",
            errors: e.input.conflictErrors,
          });
          return {
            nodeId: node.nodeId,
            generation: node.generation,
            inputDigest: e.input.inputDigest,
            inputHead: plan.baseHead,
            outputHead: e.input.inputHead,
            workspace: e.input.root,
            outcome: "failed",
            artifactIds: [artifactId],
            evidenceIds: [artifactId],
            summary:
              "Git conflicts retained in the integration snapshot; repair required",
          };
        }
        return {
          nodeId: node.nodeId,
          generation: node.generation,
          inputDigest: input.inputDigest,
          inputHead: plan.baseHead,
          outputHead: input.inputHead,
          workspace: input.root,
          outcome: "completed",
          artifactIds: [],
          evidenceIds: [],
          summary: "Dependency artifacts integrated",
        };
      }
      const current = await store.state();
      const parent = plan.graph.edges
        .filter((e) => e.to === node.nodeId)
        .map((e) => current.nodes[e.from]?.result)
        .find((r) => r?.workspace);
      const workspace = parent?.workspace;
      if (!parent || !workspace)
        throw new RalphError(
          "Final validation requires integrated input",
          "invalid_graph",
          4,
        );
      const result = await runVerifier(
        workspace,
        plan.config,
        plan.envelope.verifierIds,
        plan.contract.requiredArtifacts,
        {
          riskTier: classifyRisk(plan.contract),
          contract: plan.contract,
          signal,
          baseHead: plan.baseHead,
        },
      );
      const diff = await git(workspace, [
        "diff",
        plan.baseHead,
        "HEAD",
        "--",
      ]);
      const scope = {
        stage: "integration" as const,
        nodeId: node.nodeId,
        inputHead: plan.baseHead,
        dependencies: [{ nodeId: parent.nodeId, outcome: parent.outcome, evidenceIds: parent.evidenceIds }],
        completedWorkers: plan.graph.nodes.filter((n) => n.kind === "worker").map((n) => {
          // The compiler connects every worker to this final fan-in, and the
          // scheduler requires completed dependencies before dispatching it.
          const result = current.nodes[n.nodeId]!.result!;
          return { nodeId: n.nodeId, outcome: result.outcome, evidenceIds: result.evidenceIds };
        }),
      };
      const { assessment, evaluation } = await (async () => {
        const { routes, hardPin } = routesFor(plan.config, plan.contract, "critic");
        const review = await gateway.invoke(
          routes,
          {
            runId: plan.runId,
            nodeId: node.nodeId,
            generation: node.generation,
            role: "critic",
            projectRoot: workspace,
            prompt: await criticPrompt(plan.contract, "post", {
              head: await gitHead(workspace),
              status: await gitStatus(workspace),
              diff,
              verifier: result.summary,
              scope,
            }),
          },
          signal,
          (text) => {
            if (!validateAssessment(parseJsonObject(text)))
              throw new Error("Invalid final assessment");
          },
          hardPin,
        );
        const assessment = parseJsonObject(review.result.text);
        if (!validateAssessment(assessment))
          throw new Error("Invalid assessment");
        const evaluation = await evaluateAssessment(plan.contract.taskType, assessment, {
          workerOk: true,
          verifierOk: result.ok,
        });
        return { assessment, evaluation };
      })().catch((error) => {
        throw new NodeExecutionError("review", error);
      });
      const artifactId = await store.putArtifact({
        scope,
        verifier: result,
        assessment,
        evaluation,
        diff,
      });
      await store.append(
        {
          type: "evidence.saved",
          payload: {
            nodeId: node.nodeId,
            artifactId,
            summary: evaluation.reason,
          },
        },
        plan.graph.revision,
      );
      return {
        ...parent,
        nodeId: node.nodeId,
        generation: node.generation,
        outcome:
          result.ok && evaluation.verdict === "pass" ? "completed" : "failed",
        artifactIds: [artifactId],
        evidenceIds: [artifactId],
        summary: evaluation.reason,
      };
    };
    for (
      let repairs = events.filter(
        (e) =>
          e.type === "graph.revised" && e.payload.graph.reason === "repair",
      ).length;
      ;
      repairs++
    ) {
      state = await schedule(
        plan.graph,
        store,
        plan.budget.concurrency,
        (node, nodeSignal, graph) => execute(node, nodeSignal, { ...plan, graph }),
        signal,
      );
      if (signal.aborted) {
        await store.append(
          {
            type: "run.status",
            payload: {
              status: cancelled ? "cancelled" : "paused",
              message: String(signal.reason),
            },
          },
          plan.graph.revision,
        );
        break;
      }
      if (Object.values(state.nodes).some((n) => n.status !== "completed")) {
        const recovery = await recoverFailedNode(store, plan, state, gateway, manager, signal, repairs);
        if (recovery && "graph" in recovery) {
          plan = { ...plan, graph: recovery.graph };
          finalApproved = false;
          continue;
        }
        if (signal.aborted) continue;
        await store.append(
          {
            type: "run.status",
            payload: {
              status: "awaiting_input",
              message: recovery?.waiting ??
                "One or more required nodes are blocked; inspect node evidence",
            },
          },
          plan.graph.revision,
        );
        break;
      }
      if (plan.mode !== "answer") {
        if (classifyRisk(plan.contract) === "T3" && !finalApproved) {
          await store.append(
            {
              type: "run.status",
              payload: {
                status: "awaiting_input",
                message: "T3 final confirmation required",
              },
            },
            plan.graph.revision,
          );
          break;
        }
        const final = plan.graph.nodes.find((n) => n.kind === "validate")!;
        const workspace = state.nodes[final.nodeId]!.result!.workspace!;
        const head = await deliverResult(
          plan.projectRoot,
          workspace,
          plan.baseHead,
          plan.baseBranch,
          plan.runId,
          deliveryReceipt,
        );
        await store.append(
          {
            type: "run.status",
            payload: { status: "completed", resultHead: head },
          },
          plan.graph.revision,
        );
      } else
        await store.append(
          { type: "run.status", payload: { status: "completed" } },
          plan.graph.revision,
        );
      break;
    }
  } catch (e) {
    await store.append(
      {
        type: "run.status",
        payload: {
          status:
            e instanceof RalphError && e.exitCode === 10
              ? "awaiting_input"
              : "failed",
          message: redact(String(e)),
        },
      },
      plan.graph.revision,
    );
  } finally {
    if (timer) clearInterval(timer);
    await commandLoop;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try {
      if (clockActive)
        await store.append(
          { type: "runtime.elapsed", payload: { ms: Date.now() - lastClock } },
          plan.graph.revision,
        );
      await store.saveSnapshot();
    } finally {
      await store.release();
    }
  }
  return store.state();
}
export async function resumeGraphRun(
  projectRoot: string,
  runId: string,
  signal?: AbortSignal,
): Promise<GraphRunState> {
  const store = await storeFor(projectRoot, runId);
  const plan = JSON.parse(
    await readFile(join(store.directory, "plan.json"), "utf8"),
  ) as ExecutionPlan;
  return startRun(plan, { resume: true, signal });
}
export async function* watchRun(
  projectRoot: string,
  runId: string,
  after = 0,
  signal?: AbortSignal,
) {
  const store = await storeFor(projectRoot, runId);
  while (!signal?.aborted) {
    for (const event of await store.readAfter(after)) {
      after = event.seq;
      yield event;
    }
    const state = await store.state();
    if (
      ["completed", "failed", "cancelled", "paused", "awaiting_input"].includes(
        state.status,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
