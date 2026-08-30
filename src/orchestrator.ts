import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { approveContract, assertApproved, validateContract } from "./contracts.js";
import { refreshProjectConfig } from "./config.js";
import { evaluateAssessment, validateAssessment } from "./evaluator.js";
import { assertSafeGitStart, checkpoint, gitHead, gitStatus } from "./git.js";
import { adapterMap } from "./providers/index.js";
import { contractPlannerPrompt, criticPrompt, metaPrompt, workerPrompt } from "./prompts.js";
import {
  activeRun,
  emitEvent,
  ensureState,
  isStopRequested,
  loadConfig,
  loadRun,
  readEvents,
  removeLock,
  saveContract,
  saveRun,
  statePaths,
  writeLock,
} from "./state.js";
import type {
  AgentResult,
  AgentUsage,
  CriticAssessment,
  ProjectConfig,
  RouteEntry,
  RunState,
  TaskContract,
} from "./types.js";
import { atomicWrite, makeId, now, parseJsonObject, RalphError, redact, sleep } from "./util.js";
import { runVerifier } from "./verifier.js";

interface InvokeOutcome { result: AgentResult; route: RouteEntry; attempts: number }
const CIRCUIT_BREAKERS = new Map<string, Set<string>>();

function modelFor(route: RouteEntry, mode: "builtin" | "api" | "process") {
  return { connectionId: route.connectionId, provider: route.provider, modelId: route.modelId, displayName: route.displayName, mode, reasoningEffort: route.reasoningEffort };
}

function applyModelOverride(config: ProjectConfig, contract: TaskContract): ProjectConfig {
  if (!contract.modelOverride) return config;
  const candidates = Object.values(config.routes).flat();
  const route = candidates.find((item) => item.modelId === contract.modelOverride);
  if (!route) throw new RalphError(`요청한 모델 ${contract.modelOverride}을 현재 연결에서 사용할 수 없습니다.`, "model_unavailable", 5);
  return { ...config, routes: { ...config.routes, [contract.taskType]: [route], worker: [route] } };
}

async function sessionId(projectRoot: string, runId: string, node: string, route: RouteEntry): Promise<string | undefined> {
  const paths = await ensureState(projectRoot);
  try {
    const data = JSON.parse(await readFile(join(paths.sessions, runId, `${node}--${route.connectionId.replaceAll(":", "_")}--${route.modelId}.json`), "utf8")) as { sessionId?: string; turns?: number };
    return (data.turns ?? 0) < 12 ? data.sessionId : undefined;
  } catch { return undefined; }
}

async function saveSession(projectRoot: string, runId: string, node: string, route: RouteEntry, id: string, cumulativeUsage?: AgentUsage): Promise<void> {
  const paths = await ensureState(projectRoot);
  const dir = join(paths.sessions, runId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${node}--${route.connectionId.replaceAll(":", "_")}--${route.modelId}.json`);
  let turns = 0;
  try { turns = (JSON.parse(await readFile(path, "utf8")) as { turns?: number }).turns ?? 0; } catch { turns = 0; }
  const { writeJson } = await import("./util.js");
  await writeJson(path, { sessionId: id, turns: turns + 1, updatedAt: now(), ...(cumulativeUsage ? { cumulativeUsage } : {}) });
}

async function cumulativeUsageDelta(projectRoot: string, runId: string, node: string, route: RouteEntry, current: AgentUsage): Promise<AgentUsage> {
  const paths = await ensureState(projectRoot);
  const path = join(paths.sessions, runId, `${node}--${route.connectionId.replaceAll(":", "_")}--${route.modelId}.json`);
  let previous: AgentUsage = {};
  try { previous = (JSON.parse(await readFile(path, "utf8")) as { cumulativeUsage?: AgentUsage }).cumulativeUsage ?? {}; } catch { previous = {}; }
  const delta: AgentUsage = {};
  for (const key of ["inputTokens", "outputTokens", "cachedTokens", "reasoningTokens", "totalTokens", "estimatedCostUsd"] as const) {
    if (current[key] !== undefined) delta[key] = Math.max(0, current[key]! - (previous[key] ?? 0));
  }
  return delta;
}

async function appendUsage(projectRoot: string, runId: string, node: string, route: RouteEntry, result: AgentResult): Promise<void> {
  if (!result.usage) return;
  const paths = await ensureState(projectRoot);
  const file = join(paths.runs, runId, "usage.jsonl");
  await appendFile(file, `${JSON.stringify({ timestamp: now(), runId, node, provider: route.provider, connectionId: route.connectionId, modelId: result.rawModelId ?? route.modelId, displayName: route.displayName, effort: route.reasoningEffort, usage: result.usage })}\n`);
}

async function invokeWithFallback(
  projectRoot: string,
  config: ProjectConfig,
  run: RunState,
  node: "contractPlanner" | "critic" | "metaPrompter" | "worker" | "adjudicator",
  prompt: string,
  controller: AbortController,
  excludedProviders: string[] = [],
  validateText?: (text: string) => void,
  eventNode?: string,
): Promise<InvokeOutcome> {
  const degraded = CIRCUIT_BREAKERS.get(run.id) ?? new Set<string>();
  CIRCUIT_BREAKERS.set(run.id, degraded);
  const available = config.routes[node].filter((route) => !degraded.has(`${route.connectionId}:${route.modelId}`));
  const preferredRoutes = available.filter((route) => !excludedProviders.includes(route.provider));
  const routes = preferredRoutes.length ? preferredRoutes : available;
  if (!routes.length) throw new RalphError(`${node}에 실행 가능한 모델 경로가 없습니다. ralph init 또는 config pipelines를 확인해 주세요.`, "no_route", 5);
  if (!preferredRoutes.length && excludedProviders.length) {
    await emitEvent(projectRoot, { runId: run.id, type: "degraded_independence", node: eventNode ?? node, status: "warning", message: "다른 Provider가 없어 평가 독립성이 낮아진 상태로 같은 Provider를 사용합니다.", data: { excludedProviders } });
  }
  const adapters = adapterMap(config);
  let lastError: AgentResult["error"];
  for (const route of routes) {
    const adapter = adapters.get(route.connectionId);
    if (!adapter) continue;
    if (await knownCapacityExhausted(projectRoot, route.connectionId)) {
      degraded.add(`${route.connectionId}:${route.modelId}`);
      await emitEvent(projectRoot, { runId: run.id, type: "capacity_skip", node: eventNode ?? node, status: "warning", message: `${route.connectionId}의 정확한 잔여량이 0이어서 호출을 건너뜁니다.`, data: { connectionId: route.connectionId, modelId: route.modelId } });
      continue;
    }
    const auth = await adapter.authStatus();
    if (auth.status === "unauthenticated") throw new RalphError(`${route.connectionId} 로그인이 필요합니다. ralph auth login을 실행해 주세요.`, "authentication", 77);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await emitEvent(projectRoot, { runId: run.id, type: "model_attempt", node: eventNode ?? node, status: "running", message: `${route.displayName} 호출을 시작했습니다.`, data: { attempt, connectionId: route.connectionId, modelId: route.modelId, displayName: route.displayName, effort: route.reasoningEffort } });
      const persistent = node === "worker" || node === "metaPrompter";
      const result = await adapter.invoke({ runId: run.id, nodeId: eventNode ?? node, role: node, model: modelFor(route, adapter.mode), projectRoot, prompt, ...(persistent ? { sessionId: await sessionId(projectRoot, run.id, node, route) } : {}) }, controller.signal);
      const cumulativeUsage = result.usageCumulative ? result.usage : undefined;
      if (result.usageCumulative && result.usage) result.usage = await cumulativeUsageDelta(projectRoot, run.id, node, route, result.usage);
      await appendUsage(projectRoot, run.id, eventNode ?? node, route, result);
      if (result.sessionId && persistent) await saveSession(projectRoot, run.id, node, route, result.sessionId, cumulativeUsage);
      if (result.exitCode === 0 && result.text.trim()) {
        try {
          validateText?.(result.text);
          await emitEvent(projectRoot, { runId: run.id, type: "model_result", node: eventNode ?? node, status: "completed", message: `${route.displayName} 호출이 완료되었습니다.`, data: { attempt, connectionId: route.connectionId, modelId: route.modelId, displayName: route.displayName } });
          return { result, route, attempts: attempt };
        } catch (error) {
          result.error = { kind: "schema_error", retryable: true, message: error instanceof Error ? error.message : String(error) };
          result.exitCode = 4;
        }
      }
      lastError = result.error;
      const kind = result.error?.kind ?? "unknown";
      await emitEvent(projectRoot, { runId: run.id, type: "model_failure", node: eventNode ?? node, status: "failed", message: `${route.displayName} 호출 실패: ${kind}`, data: { attempt, retryable: result.error?.retryable ?? false, error: redact(result.error?.message ?? "unknown") } });
      if (!result.error?.retryable) throw new RalphError(`${route.displayName} 호출이 중단되었습니다: ${result.error?.message ?? "알 수 없는 오류"}`, kind, result.exitCode || 1);
      if (attempt < 2) await sleep(Math.min(8_000, 2_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 350), controller.signal);
    }
    await emitEvent(projectRoot, { runId: run.id, type: "fallback", node: eventNode ?? node, status: "warning", message: `${route.displayName}을 현재 실행에서 격리하고 다음 모델로 전환합니다.`, data: { error: lastError?.kind } });
    degraded.add(`${route.connectionId}:${route.modelId}`);
  }
  throw new RalphError(`모든 ${node} 폴백 경로가 실패했습니다: ${lastError?.message ?? "unknown"}`, "fallback_exhausted", 6);
}

async function knownCapacityExhausted(projectRoot: string, connectionId: string): Promise<boolean> {
  const paths = await ensureState(projectRoot);
  try {
    const all = JSON.parse(await readFile(join(paths.dashboard, "capacity.json"), "utf8")) as Record<string, import("./types.js").CapacitySnapshot>;
    const snapshot = all[connectionId];
    if (!snapshot || snapshot.status !== "exact") return false;
    if (snapshot.kind === "subscription") return Boolean(snapshot.windows?.length) && snapshot.windows!.every((window) => window.remainingPercent <= 0);
    return Boolean(snapshot.balances?.length) && snapshot.balances!.every((balance) => Number(balance.total) <= 0);
  } catch { return false; }
}

function diffText(projectRoot: string): Promise<string> {
  return import("./util.js").then(({ runCommand }) => runCommand("git", ["diff", "--no-ext-diff", "HEAD", "--"], { cwd: projectRoot })).then((result) => result.stdout.slice(0, 96_000));
}

async function operatorNote(projectRoot: string): Promise<string> {
  const paths = await ensureState(projectRoot);
  try {
    const path = join(paths.dashboard, "operator-note.md");
    const note = await readFile(path, "utf8");
    if (!note.trim()) return "";
    await atomicWrite(path, "");
    return `\n\n사용자가 다음 노드에 남긴 오퍼레이터 메모:\n${note.slice(0, 20_000)}`;
  } catch {
    return "";
  }
}

async function checkSafeStop(projectRoot: string): Promise<void> {
  if (await isStopRequested(projectRoot)) throw new RalphError("사용자가 안전 중단을 요청했습니다.", "safe_stop", 130);
}

async function appendGuardrail(projectRoot: string, runId: string, candidate: string): Promise<void> {
  const normalized = candidate.replace(/\s+/g, " ").trim().slice(0, 1_000);
  if (!normalized) return;
  const paths = await ensureState(projectRoot);
  const current = await readFile(paths.guardrails, "utf8").catch(() => "");
  if (current.includes(normalized)) return;
  await appendFile(paths.guardrails, `\n- ${now()} · ${runId}: ${normalized}\n`);
}

export async function draftContract(projectRoot: string, request: string, controller = new AbortController()): Promise<TaskContract> {
  const storedConfig = await loadConfig(projectRoot);
  const config = await refreshProjectConfig(storedConfig, storedConfig.preset);
  const run: RunState = { id: makeId("draft"), projectRoot, contractId: "pending", taskType: "planning_architecture", status: "running", iteration: 0, maxIterations: 0, startedAt: now(), pid: process.pid, catalogVersion: config.catalogVersion, routes: config.routes };
  const outcome = await invokeWithFallback(projectRoot, config, run, "contractPlanner", contractPlannerPrompt(request, projectRoot), controller, [], (text) => {
    validateContract(parseJsonObject<unknown>(text), projectRoot);
  });
  const parsed = parseJsonObject<unknown>(outcome.result.text);
  const contract = validateContract(parsed, projectRoot);
  await saveContract(projectRoot, contract);
  return contract;
}

export async function executeContract(projectRoot: string, contract: TaskContract, resumeState?: RunState): Promise<RunState> {
  assertApproved(contract);
  await assertSafeGitStart(projectRoot);
  if (await activeRun(projectRoot)) throw new RalphError("이 worktree에서 이미 Ralph가 실행 중입니다.", "run_locked", 9);
  let config = await refreshProjectConfig(await loadConfig(projectRoot), contract.executionProfile);
  config = applyModelOverride(config, contract);
  if (resumeState) config = { ...config, routes: resumeState.routes, catalogVersion: resumeState.catalogVersion };
  else if (contract.routeSnapshot) config = { ...config, routes: contract.routeSnapshot, catalogVersion: contract.approvedCatalogVersion ?? config.catalogVersion };
  const startIteration = resumeState ? resumeState.iteration + 1 : 1;
  if (startIteration > 6) throw new RalphError("최대 Iteration 6회에 도달해 재개할 수 없습니다. 새 계약을 작성해 주세요.", "iteration_limit", 10);
  const run: RunState = resumeState
    ? { ...resumeState, status: "running", verdict: "running", iteration: startIteration, currentNode: "pre-critic", pid: process.pid, endedAt: undefined }
    : { id: makeId("run"), projectRoot, contractId: contract.id, taskType: contract.taskType, status: "running", iteration: 1, maxIterations: 6, currentNode: "pre-critic", startedAt: now(), pid: process.pid, catalogVersion: config.catalogVersion, routes: config.routes };
  await saveContract(projectRoot, contract);
  await saveRun(projectRoot, run);
  await writeLock(projectRoot, run);
  await emitEvent(projectRoot, { runId: run.id, type: resumeState ? "run_resumed" : "run_started", status: "running", message: resumeState ? `기존 실행을 Iteration ${startIteration}부터 재개했습니다.` : "승인된 작업 계약으로 Ralph 실행을 시작했습니다.", data: { taskType: contract.taskType, catalogVersion: config.catalogVersion } });

  const controller = new AbortController();
  let firstInterruptAt = 0;
  const requestSafeStop = () => {
    const current = Date.now();
    if (firstInterruptAt && current - firstInterruptAt <= 3_000) controller.abort(new Error("강제 중단"));
    else {
      firstInterruptAt = current;
      void import("./state.js").then(({ requestStop }) => requestStop(projectRoot));
      process.stderr.write("\n안전 중단을 요청했습니다. 현재 노드가 끝나면 checkpoint를 만듭니다. 3초 안에 다시 Ctrl+C를 누르면 강제 중단합니다.\n");
    }
  };
  process.on("SIGINT", requestSafeStop);
  process.on("SIGTERM", () => controller.abort(new Error("강제 중단")));

  let progress = resumeState ? await recentProgress(projectRoot, run.id) : "";
  let previousScores: number[] = resumeState ? (await readEvents(projectRoot, run.id)).filter((event) => event.type === "evaluation" && typeof event.data?.score === "number").map((event) => Number(event.data!.score)) : [];
  let previousFingerprints: string[] = resumeState ? (await readEvents(projectRoot, run.id)).filter((event) => event.type === "evaluation" && typeof event.data?.fingerprint === "string").map((event) => String(event.data!.fingerprint)) : [];
  try {
    for (let iteration = startIteration; iteration <= run.maxIterations; iteration += 1) {
      run.iteration = iteration;
      let workerExit = -1;
      let verifierExit = -1;
      let finalScore: number | undefined;
      let iterationVerdict = "failed";
      let workerProvider = "";
      try {
        const head = await gitHead(projectRoot);
        run.currentNode = "pre-critic";
        await saveRun(projectRoot, run);
        const pre = await invokeWithFallback(projectRoot, config, run, "critic", `${await criticPrompt(contract, "pre", { head, status: await gitStatus(projectRoot), diff: await diffText(projectRoot) })}${await operatorNote(projectRoot)}`, controller, [], (text) => {
          if (!validateAssessment(parseJsonObject<unknown>(text))) throw new Error("Critic 평가 schema가 올바르지 않습니다.");
        }, "pre-critic");
        const preAssessment = parseJsonObject<unknown>(pre.result.text);
        if (!validateAssessment(preAssessment)) throw new RalphError("Pre-Critic JSON이 평가 schema와 맞지 않습니다.", "schema_error");
        await checkSafeStop(projectRoot);

        run.currentNode = "meta-prompter";
        await saveRun(projectRoot, run);
        const meta = await invokeWithFallback(projectRoot, config, run, "metaPrompter", `${metaPrompt(contract, preAssessment, progress)}${await operatorNote(projectRoot)}`, controller, [], (text) => {
          const parsed = parseJsonObject<{ workerInstructions?: string }>(text);
          if (!parsed.workerInstructions) throw new Error("workerInstructions가 없습니다.");
        });
        const metaResult = parseJsonObject<{ workerInstructions?: string; guardrailCandidate?: string }>(meta.result.text);
        if (!metaResult.workerInstructions) throw new RalphError("Meta-Prompter가 workerInstructions를 반환하지 않았습니다.", "schema_error");
        await checkSafeStop(projectRoot);

        run.currentNode = "worker";
        await saveRun(projectRoot, run);
        const workerRoutes = config.routes[contract.taskType].length ? config.routes[contract.taskType] : config.routes.worker;
        const workerConfig = { ...config, routes: { ...config.routes, worker: workerRoutes } };
        const worker = await invokeWithFallback(projectRoot, workerConfig, run, "worker", `${workerPrompt(contract, metaResult.workerInstructions, head)}${await operatorNote(projectRoot)}`, controller);
        workerExit = worker.result.exitCode;
        workerProvider = worker.route.provider;
        if (await gitHead(projectRoot) !== head) throw new RalphError("Worker가 허용되지 않은 Git commit 또는 HEAD 변경을 수행했습니다. 변경 상태를 사용자가 확인해야 합니다.", "worker_git_mutation", 9);
        await checkSafeStop(projectRoot);

        run.currentNode = "verifier";
        await saveRun(projectRoot, run);
        await emitEvent(projectRoot, { runId: run.id, type: "node", node: "verifier", status: "running", message: "결정적 테스트·린트·타입·빌드 검증을 실행합니다." });
        const verifier = await runVerifier(projectRoot, config, contract.verifierCommands, contract.requiredArtifacts);
        verifierExit = verifier.exitCode;
        await emitEvent(projectRoot, { runId: run.id, type: "node", node: "verifier", status: verifier.ok ? "completed" : "failed", message: verifier.ok ? "결정적 검증을 통과했습니다." : "결정적 검증이 실패했습니다.", data: { exitCode: verifier.exitCode, commands: verifier.commands.map((item) => ({ command: item.command, exitCode: item.exitCode })) } });
        await checkSafeStop(projectRoot);

        run.currentNode = "post-critic";
        await saveRun(projectRoot, run);
        const post = await invokeWithFallback(projectRoot, config, run, "critic", await criticPrompt(contract, "post", { head: await gitHead(projectRoot), status: await gitStatus(projectRoot), diff: await diffText(projectRoot), verifier: verifier.summary }), controller, [workerProvider], (text) => {
          if (!validateAssessment(parseJsonObject<unknown>(text))) throw new Error("Critic 평가 schema가 올바르지 않습니다.");
        }, "post-critic");
        const parsedAssessment = parseJsonObject<unknown>(post.result.text);
        if (!validateAssessment(parsedAssessment)) throw new RalphError("Post-Critic JSON이 평가 schema와 맞지 않습니다.", "schema_error");
        let assessment: CriticAssessment = parsedAssessment;
        let evaluation = await evaluateAssessment(contract.taskType, assessment, { workerOk: workerExit === 0, verifierOk: verifier.ok, threshold: 85 });

        if ((evaluation.score >= 80 && evaluation.score <= 90) || evaluation.hardGateUnknown.length) {
          run.currentNode = "adjudicator";
          await saveRun(projectRoot, run);
          const adjudication = await invokeWithFallback(projectRoot, config, run, "adjudicator", await criticPrompt(contract, "adjudication", { head: await gitHead(projectRoot), status: await gitStatus(projectRoot), diff: await diffText(projectRoot), verifier: verifier.summary }), controller, [workerProvider, post.route.provider], (text) => {
            if (!validateAssessment(parseJsonObject<unknown>(text))) throw new Error("재심 평가 schema가 올바르지 않습니다.");
          });
          const adjudicated = parseJsonObject<unknown>(adjudication.result.text);
          if (validateAssessment(adjudicated)) {
            assessment = adjudicated;
            evaluation = await evaluateAssessment(contract.taskType, adjudicated, { workerOk: workerExit === 0, verifierOk: verifier.ok, threshold: 85 });
          }
        }

        finalScore = evaluation.score;
        iterationVerdict = evaluation.verdict;
        const fingerprint = `${evaluation.hardGateFailures.sort().join(",")}|${assessment.findings.map((item) => item.summary).sort().join("|")}`;
        previousFingerprints.push(fingerprint);
        previousScores.push(evaluation.score);
        if (previousFingerprints.length >= 2 && previousFingerprints.at(-1) === previousFingerprints.at(-2)) {
          await appendGuardrail(projectRoot, run.id, metaResult.guardrailCandidate ?? "");
          iterationVerdict = "needs_operator";
        }
        if (previousScores.length >= 3 && previousScores.at(-1)! - previousScores.at(-2)! < 3 && previousScores.at(-2)! - previousScores.at(-3)! < 3) {
          iterationVerdict = "needs_operator";
        }
        progress = evaluation.reason;
        await emitEvent(projectRoot, { runId: run.id, type: "evaluation", node: "post-critic", status: iterationVerdict, message: evaluation.reason, data: { score: evaluation.score, verdict: iterationVerdict, fingerprint, criterionScores: evaluation.criterionScores, hardGateFailures: evaluation.hardGateFailures, hardGateUnknown: evaluation.hardGateUnknown } });

        run.currentNode = "git-checkpoint";
        await saveRun(projectRoot, run);
        const commit = await checkpoint(projectRoot, { runId: run.id, task: contract.taskType, iteration, status: iterationVerdict, workerExit, verifierExit, score: finalScore, verdict: iterationVerdict });
        run.lastCheckpoint = commit;
        run.score = finalScore;
        await emitEvent(projectRoot, { runId: run.id, type: "checkpoint", node: "git-checkpoint", status: "completed", message: `Iteration ${iteration}을 Git checkpoint ${commit.slice(0, 12)}에 저장했습니다.`, data: { commit } });

        if (await isStopRequested(projectRoot)) {
          run.status = "interrupted";
          run.verdict = "interrupted";
          break;
        }
        if (iterationVerdict === "pass") { run.status = "pass"; run.verdict = "pass"; break; }
        if (iterationVerdict === "needs_operator") { run.status = "needs_operator"; run.verdict = "needs_operator"; break; }
        if (iteration === run.maxIterations) { run.status = "needs_operator"; run.verdict = "needs_operator"; }
      } catch (error) {
        const forced = controller.signal.aborted;
        const safeStop = error instanceof RalphError && error.code === "safe_stop";
        iterationVerdict = forced ? "interrupted_partial" : safeStop ? "interrupted" : "failed";
        await emitEvent(projectRoot, { runId: run.id, type: "failure", node: run.currentNode, status: iterationVerdict, message: redact(error instanceof Error ? error.message : String(error)), data: { code: error instanceof RalphError ? error.code : "unknown" } });
        try {
          const commit = await checkpoint(projectRoot, { runId: run.id, task: contract.taskType, iteration, status: iterationVerdict, workerExit, verifierExit, score: finalScore, verdict: iterationVerdict });
          run.lastCheckpoint = commit;
        } catch (checkpointError) {
          await emitEvent(projectRoot, { runId: run.id, type: "checkpoint", node: "git-checkpoint", status: "failed", message: `Git checkpoint를 만들지 못했습니다: ${redact(checkpointError instanceof Error ? checkpointError.message : String(checkpointError))}` });
        }
        run.status = forced ? "interrupted_partial" : safeStop ? "interrupted" : error instanceof RalphError && ["authentication", "invalid_request", "policy_denial", "schema_error"].includes(error.code) ? "needs_operator" : "failed";
        run.verdict = run.status;
        break;
      }
    }
  } finally {
    process.off("SIGINT", requestSafeStop);
    run.currentNode = undefined;
    run.endedAt = now();
    await saveRun(projectRoot, run);
    await emitEvent(projectRoot, { runId: run.id, type: "run_finished", status: run.status, message: `Ralph 실행이 ${run.status} 상태로 종료되었습니다.`, data: { score: run.score, checkpoint: run.lastCheckpoint } });
    await removeLock(projectRoot);
    CIRCUIT_BREAKERS.delete(run.id);
  }
  return run;
}

export async function approveAndExecute(projectRoot: string, contract: TaskContract): Promise<RunState> {
  const approved = approveContract(contract);
  await saveContract(projectRoot, approved);
  return await executeContract(projectRoot, approved);
}

export async function resumeRun(projectRoot: string, runId?: string): Promise<RunState> {
  const states = runId ? [await loadRun(projectRoot, runId)] : (await import("./state.js")).listRuns(projectRoot);
  const target = (await states).find((run) => ["interrupted", "interrupted_partial", "failed", "needs_operator"].includes(run.status));
  if (!target) throw new RalphError("재개할 실행이 없습니다.", "run_not_found", 2);
  const contract = await import("./state.js").then(({ loadContract }) => loadContract(projectRoot, target.contractId));
  return await executeContract(projectRoot, contract, target);
}

export async function recentProgress(projectRoot: string, runId: string): Promise<string> {
  return (await readEvents(projectRoot, runId)).slice(-20).map((event) => `${event.timestamp} ${event.node ?? event.type}: ${event.message}`).join("\n");
}
