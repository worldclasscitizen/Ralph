import type {
  AgentRole,
  ProjectConfig,
  RiskTier,
  RouteDecision,
  RouteEntry,
  RoutePolicy,
  SessionPolicy,
  TaskContract,
} from "./types.js";
import { now, sha256 } from "./util.js";

const HIGH_RISK = /\b(auth(?:entication|orization)?|payment|billing|permission|secret|credential|migration|delete|destructive|encryption|token)\b|인증|결제|권한|비밀|마이그레이션|삭제|암호화/i;
const MEDIUM_RISK = /\b(api|schema|database|public interface|protocol|dependency|refactor)\b|스키마|데이터베이스|공개 API|프로토콜|의존성|리팩터링/i;
const DOC_ONLY = /\b(readme|docs?|documentation|copy|markdown)\b|문서|마크다운|카피/i;

export function classifyRisk(contract: TaskContract): RiskTier {
  if (contract.riskTier) return contract.riskTier;
  const text = [contract.goal, ...contract.include, ...contract.requirements, ...contract.constraints].join("\n");
  if (HIGH_RISK.test(text)) return "T3";
  if (MEDIUM_RISK.test(text) || contract.include.length >= 12) return "T2";
  if (contract.taskType === "planning_architecture" || (contract.taskType === "delivery_evidence" && DOC_ONLY.test(text))) return "T0";
  return "T1";
}

function policyFor(config: ProjectConfig, contract: TaskContract): RoutePolicy {
  return config.routePolicies?.[contract.taskType]
    ?? config.routePolicies?.worker
    ?? { mode: "adaptive" };
}

function qualityFirstOrder(routes: RouteEntry[], config: ProjectConfig): RouteEntry[] {
  if (!routes.length) return [];
  const maximumQuality = Math.max(...routes.map((route) => route.qualityScore ?? route.score));
  const secondary = (route: RouteEntry) => config.preset === "fast"
    ? route.latencyScore ?? 0
    : config.preset === "budget"
      ? route.costScore ?? 0
      : config.preset === "quality"
        ? route.qualityScore ?? route.score
        : (route.qualityScore ?? route.score) * 0.8 + (route.latencyScore ?? 0) * 0.1 + (route.costScore ?? 0) * 0.1;
  return [...routes].sort((a, b) => {
    const aBand = Math.max(0, Math.ceil((maximumQuality - (a.qualityScore ?? a.score)) / 2) - 1);
    const bBand = Math.max(0, Math.ceil((maximumQuality - (b.qualityScore ?? b.score)) / 2) - 1);
    return aBand - bBand || secondary(b) - secondary(a) || (b.qualityScore ?? b.score) - (a.qualityScore ?? a.score);
  });
}

export function candidateRoutes(config: ProjectConfig, contract: TaskContract): RouteEntry[] {
  const policy = policyFor(config, contract);
  const configured = policy.candidates?.length
    ? policy.candidates
    : config.routes[contract.taskType].length
      ? config.routes[contract.taskType]
      : config.routes.worker;
  const deduplicated = new Map(configured.map((route) => [`${route.connectionId}:${route.modelId}`, route]));
  return [...deduplicated.values()];
}

export function roleRoutes(config: ProjectConfig, role: AgentRole): RouteEntry[] {
  const policy = config.routePolicies?.[role];
  const configured = policy?.candidates?.length ? policy.candidates : config.routes[role];
  const candidates = [...new Map(configured.map((route) => [`${route.connectionId}:${route.modelId}`, route])).values()];
  if (!policy?.hardPin) return policy?.mode === "adaptive"
    ? qualityFirstOrder(candidates, config)
    : candidates;
  const pinned = candidates.find((route) => route.connectionId === policy.hardPin?.connectionId && route.modelId === policy.hardPin.modelId);
  if (!pinned) return [];
  return [{ ...pinned, reasoningEffort: policy.hardPin.reasoningEffort ?? pinned.reasoningEffort }];
}

function hardPinnedRoute(config: ProjectConfig, contract: TaskContract, candidates: RouteEntry[]): RouteEntry | undefined {
  const policy = policyFor(config, contract);
  const pin = policy.hardPin;
  if (contract.modelOverride) return Object.values(config.routes).flat().find((route) => route.modelId === contract.modelOverride);
  if (!pin) return undefined;
  const route = candidates.find((item) => item.connectionId === pin.connectionId && item.modelId === pin.modelId);
  return route && pin.reasoningEffort ? { ...route, reasoningEffort: pin.reasoningEffort } : route;
}

export function deterministicRouteDecision(
  config: ProjectConfig,
  contract: TaskContract,
  boundary: RouteDecision["boundary"],
  options: {
    suggested?: { connectionId?: string; modelId?: string; reasoningEffort?: string; sessionPolicy?: SessionPolicy; rationale?: string };
    previous?: RouteDecision;
    failedRoute?: { connectionId: string; modelId: string };
    measurableImprovement?: boolean;
    contextUtilization?: number;
    continuationCount?: number;
  } = {},
): RouteDecision {
  const riskTier = classifyRisk(contract);
  const candidates = candidateRoutes(config, contract).filter((route) =>
    route.connectionId !== options.failedRoute?.connectionId || route.modelId !== options.failedRoute?.modelId,
  );
  if (!candidates.length) throw new Error("작업에 사용할 수 있는 Worker 후보가 없습니다.");
  const pin = hardPinnedRoute(config, contract, candidateRoutes(config, contract));
  if ((contract.modelOverride || policyFor(config, contract).hardPin) && !pin) throw new Error("지정한 Hard Pin 모델을 현재 연결에서 사용할 수 없습니다.");
  const suggested = options.suggested
    ? candidates.find((route) => route.connectionId === options.suggested?.connectionId && route.modelId === options.suggested?.modelId)
    : undefined;
  const maximumQuality = Math.max(...candidates.map((route) => route.qualityScore ?? route.score));
  const qualityEquivalentSuggestion = suggested && maximumQuality - (suggested.qualityScore ?? suggested.score) <= 2 ? suggested : undefined;
  const policy = policyFor(config, contract);
  const selected = pin ?? (policy.mode === "fixed" ? candidates[0] : qualityEquivalentSuggestion ?? qualityFirstOrder(candidates, config)[0])!;
  const requestedContinuation = options.suggested?.sessionPolicy === "continue";
  const safeContinuation = requestedContinuation
    && (boundary === "iteration_start" || boundary === "failure")
    && options.previous?.connectionId === selected.connectionId
    && options.previous.modelId === selected.modelId
    && options.measurableImprovement === true
    && options.contextUtilization !== undefined
    && options.contextUtilization <= 0.4
    && (options.continuationCount ?? 0) < 1;
  const policyHash = sha256(JSON.stringify({
    taskType: contract.taskType,
    profile: contract.executionProfile,
    riskTier,
    policy,
    candidates: candidates.map(({ connectionId, modelId, reasoningEffort, score }) => ({ connectionId, modelId, reasoningEffort, score })),
  }));
  return {
    boundary,
    taskType: contract.taskType,
    riskTier,
    connectionId: selected.connectionId,
    provider: selected.provider,
    modelId: selected.modelId,
    displayName: selected.displayName,
    reasoningEffort: pin?.reasoningEffort ?? options.suggested?.reasoningEffort ?? selected.reasoningEffort,
    sessionPolicy: safeContinuation ? "continue" : "fresh",
    verificationTier: riskTier,
    rationale: pin
      ? "사용자가 지정한 Hard Pin을 적용했습니다."
      : qualityEquivalentSuggestion ? options.suggested?.rationale ?? "Online Router가 품질 동등 후보를 선택했습니다." : policy.mode === "fixed" ? "사용자가 지정한 고정 순서를 적용했습니다." : suggested ? "Router 제안이 품질 동등 범위를 벗어나 로컬 품질 우선 경로를 적용했습니다." : "품질 점수가 가장 높은 실행 가능한 후보를 선택했습니다.",
    source: pin ? "hard_pin" : qualityEquivalentSuggestion ? "online_router" : "deterministic_fallback",
    decidedAt: now(),
    policyHash,
  };
}

export function orderRoutesForDecision(routes: RouteEntry[], decision: RouteDecision): RouteEntry[] {
  return [...routes].sort((a, b) => {
    const aSelected = a.connectionId === decision.connectionId && a.modelId === decision.modelId;
    const bSelected = b.connectionId === decision.connectionId && b.modelId === decision.modelId;
    if (aSelected !== bSelected) return aSelected ? -1 : 1;
    return b.score - a.score;
  }).map((route, index) => index === 0 ? { ...route, reasoningEffort: decision.reasoningEffort } : route);
}
