import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { contractHash } from "./contracts.js";
import { statePaths } from "./state.js";
import type { CriticAssessment, EvidencePacket, GuardrailRecord, RouteDecision, TaskContract } from "./types.js";
import { atomicWrite, now } from "./util.js";

export async function readGuardrailRecords(projectRoot: string, limit = 50): Promise<GuardrailRecord[]> {
  const paths = await statePaths(projectRoot);
  try {
    return (await readFile(paths.guardrailsLedger, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GuardrailRecord)
      .slice(-limit);
  } catch {
    return [];
  }
}

export async function appendGuardrailRecord(projectRoot: string, record: GuardrailRecord): Promise<boolean> {
  const normalized = record.lesson.replace(/\s+/g, " ").trim().slice(0, 1_000);
  if (!normalized || record.evidence.length === 0) return false;
  const paths = await statePaths(projectRoot);
  const existing = await readGuardrailRecords(projectRoot, 500);
  if (existing.some((item) => item.lesson === normalized)) return false;
  const stored = { ...record, lesson: normalized, evidence: record.evidence.map((item) => item.slice(0, 2_000)) };
  await Promise.all([
    appendFile(paths.guardrailsLedger, `${JSON.stringify(stored)}\n`),
    appendFile(paths.guardrails, `\n- ${stored.timestamp} · ${stored.runId}: ${stored.lesson}\n`),
  ]);
  return true;
}

export function unresolvedFromAssessment(assessment?: CriticAssessment): string[] {
  if (!assessment) return [];
  const criteria = assessment.criteria
    .filter((item) => item.level === "absent" || item.level === "partial")
    .map((item) => `${item.id}: ${item.evidence.join("; ")}`);
  const gates = assessment.hardGates
    .filter((item) => item.status !== "pass")
    .map((item) => `${item.id} (${item.status}): ${item.evidence.join("; ")}`);
  const findings = assessment.findings
    .filter((item) => item.severity === "high" || item.severity === "critical")
    .map((item) => `${item.severity}: ${item.summary}`);
  return [...criteria, ...gates, ...findings];
}

export async function makeEvidencePacket(input: {
  projectRoot: string;
  runId: string;
  iteration: number;
  contract: TaskContract;
  routeDecision: RouteDecision;
  baseHead: string;
  currentHead: string;
  gitStatus: string;
  diff: string;
  verifier?: EvidencePacket["verifier"];
  critic?: CriticAssessment;
  failureFingerprint?: string;
}): Promise<EvidencePacket> {
  return {
    schemaVersion: 1,
    runId: input.runId,
    iteration: input.iteration,
    taskType: input.contract.taskType,
    riskTier: input.routeDecision.riskTier,
    contractHash: contractHash(input.contract),
    policyHash: input.routeDecision.policyHash,
    baseHead: input.baseHead,
    currentHead: input.currentHead,
    gitStatus: input.gitStatus,
    diffSummary: input.diff.slice(0, 96_000),
    routeDecision: input.routeDecision,
    ...(input.verifier ? { verifier: input.verifier } : {}),
    ...(input.critic ? { critic: input.critic } : {}),
    ...(input.failureFingerprint ? { failureFingerprint: input.failureFingerprint } : {}),
    guardrails: await readGuardrailRecords(input.projectRoot),
    unresolvedItems: unresolvedFromAssessment(input.critic),
    createdAt: now(),
  };
}

export async function saveEvidencePacket(projectRoot: string, packet: EvidencePacket, phase: "pre" | "final" | "failure"): Promise<string> {
  const paths = await statePaths(projectRoot);
  const directory = join(paths.runs, packet.runId, "evidence");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `iteration-${packet.iteration}-${phase}.json`);
  await atomicWrite(path, `${JSON.stringify(packet, null, 2)}\n`);
  return path;
}
