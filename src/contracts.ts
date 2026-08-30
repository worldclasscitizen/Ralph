import { randomUUID } from "node:crypto";
import type { ExecutionProfile, TaskContract, TaskType } from "./types.js";
import { TASK_TYPES } from "./types.js";
import { RalphError, sha256 } from "./util.js";

export function validateContract(input: unknown, projectRoot: string): TaskContract {
  if (!input || typeof input !== "object") throw new RalphError("작업 계약이 JSON 객체가 아닙니다.", "schema_error");
  const row = input as Record<string, unknown>;
  if (!TASK_TYPES.includes(row.taskType as TaskType)) throw new RalphError("taskType이 올바르지 않습니다.", "schema_error");
  const profiles: ExecutionProfile[] = ["balanced", "quality", "fast", "budget"];
  const list = (key: string): string[] => {
    if (row[key] === undefined) return [];
    if (!Array.isArray(row[key]) || !(row[key] as unknown[]).every((value) => typeof value === "string")) throw new RalphError(`${key}는 문자열 배열이어야 합니다.`, "schema_error");
    return row[key] as string[];
  };
  if (typeof row.goal !== "string" || !row.goal.trim()) throw new RalphError("작업 목표가 비어 있습니다.", "schema_error");
  const profile = profiles.includes(row.executionProfile as ExecutionProfile) ? row.executionProfile as ExecutionProfile : "balanced";
  const contract: TaskContract = {
    id: typeof row.id === "string" && row.id ? row.id : randomUUID(),
    taskType: row.taskType as TaskType,
    goal: row.goal.trim(),
    include: list("include"),
    exclude: list("exclude"),
    requirements: list("requirements"),
    acceptanceCriteria: list("acceptanceCriteria"),
    verifierCommands: list("verifierCommands"),
    requiredArtifacts: list("requiredArtifacts"),
    attachments: list("attachments"),
    constraints: list("constraints"),
    executionProfile: profile,
    projectRoot,
    ...(typeof row.modelOverride === "string" && row.modelOverride.trim() ? { modelOverride: row.modelOverride.trim() } : {}),
  };
  if (!contract.acceptanceCriteria.length) throw new RalphError("최소 하나의 완료 기준이 필요합니다.", "schema_error");
  return contract;
}

export function contractHash(contract: TaskContract): string {
  const { approvedHash: _hash, approvedAt: _at, ...unsigned } = contract;
  return sha256(JSON.stringify(unsigned));
}

export function approveContract(contract: TaskContract): TaskContract {
  const approvedAt = new Date().toISOString();
  const approvedHash = contractHash(contract);
  return { ...contract, approvedHash, approvedAt };
}

export function assertApproved(contract: TaskContract): void {
  if (!contract.approvedHash || contract.approvedHash !== contractHash(contract)) throw new RalphError("승인된 작업 계약의 hash가 일치하지 않습니다.", "contract_tampered", 4);
}
