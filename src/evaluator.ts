import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CriticAssessment, EvaluationResult, TaskType } from "./types.js";

const ASSET_ROOT = fileURLToPath(new URL("../assets", import.meta.url));
const FACTORS = { absent: 0, partial: 0.5, verified: 0.8, complete: 1 } as const;

interface Rubric {
  criteria: Array<{ id: string; label: string; weight: number; guidance: string; anchors?: Record<"absent" | "partial" | "verified" | "complete", string> }>;
  hardGates: Array<{ id: string; label: string; guidance: string }>;
}

export async function loadRubric(task: TaskType): Promise<{ base: Rubric; task: Rubric }> {
  const [base, taskRubric] = await Promise.all([
    readFile(join(ASSET_ROOT, "rubrics", "base.json"), "utf8"),
    readFile(join(ASSET_ROOT, "rubrics", `${task}.json`), "utf8"),
  ]);
  const addAnchors = (rubric: Rubric): Rubric => ({
    ...rubric,
    criteria: rubric.criteria.map((criterion) => ({
      ...criterion,
      anchors: criterion.anchors ?? {
        absent: `${criterion.label}을 뒷받침하는 구현 또는 증거가 없거나 증거와 모순됩니다.`,
        partial: `${criterion.label}의 일부가 구현됐지만 핵심 경로 또는 결정적 증거가 부족합니다.`,
        verified: `${criterion.label}의 핵심 경로가 결정적 증거로 확인됐고 경미한 부족만 남았습니다.`,
        complete: `${criterion.label}이 승인 범위·경계 조건·재현 가능한 증거까지 완전히 충족됩니다.`,
      },
    })),
  });
  return { base: addAnchors(JSON.parse(base) as Rubric), task: addAnchors(JSON.parse(taskRubric) as Rubric) };
}

export async function evaluateAssessment(
  task: TaskType,
  assessment: CriticAssessment,
  options: { workerOk: boolean; verifierOk: boolean; threshold?: number } = { workerOk: true, verifierOk: true },
): Promise<EvaluationResult> {
  const rubric = await loadRubric(task);
  const criteria = [...rubric.base.criteria, ...rubric.task.criteria];
  const expectedCriterionIds = criteria.map((item) => item.id).sort();
  const actualCriterionIds = assessment.criteria.map((item) => item.id).sort();
  if (JSON.stringify(expectedCriterionIds) !== JSON.stringify(actualCriterionIds)) {
    throw new Error(`Critic criterion ID가 rubric과 일치하지 않습니다. expected=${expectedCriterionIds.join(",")}`);
  }
  const criterionScores: Record<string, number> = {};
  let score = 0;
  for (const criterion of criteria) {
    const row = assessment.criteria.find((item) => item.id === criterion.id);
    const value = row ? criterion.weight * FACTORS[row.level] : 0;
    criterionScores[criterion.id] = value;
    score += value;
  }
  const expectedGates = [...rubric.base.hardGates, ...rubric.task.hardGates];
  const expectedGateIds = expectedGates.map((item) => item.id).sort();
  const actualGateIds = assessment.hardGates.map((item) => item.id).sort();
  if (JSON.stringify(expectedGateIds) !== JSON.stringify(actualGateIds)) {
    throw new Error(`Critic Hard Gate ID가 rubric과 일치하지 않습니다. expected=${expectedGateIds.join(",")}`);
  }
  const hardGateFailures: string[] = [];
  const hardGateUnknown: string[] = [];
  for (const gate of expectedGates) {
    const row = assessment.hardGates.find((item) => item.id === gate.id);
    if (!row || row.status === "unknown") hardGateUnknown.push(gate.id);
    else if (row.status === "fail") hardGateFailures.push(gate.id);
  }
  if (!options.workerOk) hardGateFailures.push("worker_execution_failed");
  if (!options.verifierOk) hardGateFailures.push("deterministic_verifier_failed");
  const blockingFinding = assessment.findings.some((finding) => finding.severity === "critical");
  const threshold = options.threshold ?? 85;
  let verdict: EvaluationResult["verdict"] = "retry";
  let reason = `점수 ${score.toFixed(1)}점으로 통과선 ${threshold}점에 미달했습니다.`;
  if (hardGateUnknown.length) {
    verdict = "needs_operator";
    reason = `Hard Gate 근거가 확인되지 않았습니다: ${hardGateUnknown.join(", ")}`;
  } else if (hardGateFailures.length || blockingFinding) {
    verdict = "retry";
    reason = `해결되지 않은 Hard Gate 또는 치명적 finding이 있습니다: ${hardGateFailures.join(", ") || "critical finding"}`;
  } else if (score >= threshold) {
    verdict = "pass";
    reason = `모든 Hard Gate와 결정적 검증을 통과했고 점수 ${score.toFixed(1)}점입니다.`;
  }
  return { score: Number(score.toFixed(1)), verdict, hardGateFailures: [...new Set(hardGateFailures)], hardGateUnknown, criterionScores, reason };
}

export function validateAssessment(value: unknown): value is CriticAssessment {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<CriticAssessment>;
  if (!Array.isArray(input.criteria) || !Array.isArray(input.hardGates) || !Array.isArray(input.findings)) return false;
  const evidence = (items: unknown): items is string[] => Array.isArray(items) && items.length > 0 && items.every((item) => typeof item === "string" && item.trim().length > 0);
  return input.criteria.every((item) => item && typeof item.id === "string" && ["absent", "partial", "verified", "complete"].includes(item.level) && evidence(item.evidence))
    && input.hardGates.every((item) => item && typeof item.id === "string" && ["pass", "fail", "unknown"].includes(item.status) && evidence(item.evidence))
    && input.findings.every((item) => item && ["low", "medium", "high", "critical"].includes(item.severity) && typeof item.summary === "string" && item.summary.trim().length > 0 && evidence(item.evidence));
}

export function needsBoundaryAdjudication(result: EvaluationResult): boolean {
  if (result.hardGateUnknown.length > 0) return true;
  return result.hardGateFailures.length === 0 && result.score >= 80 && result.score <= 90;
}
