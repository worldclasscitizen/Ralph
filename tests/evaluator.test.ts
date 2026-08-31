import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateAssessment, loadRubric, needsBoundaryAdjudication } from "../src/evaluator.js";
import type { CriticAssessment, TaskType } from "../src/types.js";

interface Profile {
  id: string;
  criterionLevel: "absent" | "partial" | "verified" | "complete";
  taskGateStatus: "pass" | "fail" | "unknown";
  finding: { severity: "high"; kind: string } | null;
  expectedDecision: string;
  expectedBoundaryAdjudication: boolean;
}

describe("critic synthetic unit fixtures", () => {
  it("matches all 24 synthetic scoring cases", async () => {
    const fixture = JSON.parse(await readFile(resolve("assets/evals/critic-synthetic-unit-cases.json"), "utf8")) as { tasks: TaskType[]; profiles: Profile[] };
    let count = 0;
    for (const task of fixture.tasks) {
      const rubric = await loadRubric(task);
      for (const profile of fixture.profiles) {
        const assessment: CriticAssessment = {
          criteria: [...rubric.base.criteria, ...rubric.task.criteria].map((item) => ({ id: item.id, level: profile.criterionLevel, evidence: ["fixed fixture"] })),
          hardGates: [...rubric.base.hardGates, ...rubric.task.hardGates].map((item, index, rows) => ({ id: item.id, status: index === rows.length - 1 ? profile.taskGateStatus : "pass", evidence: ["fixed fixture"] })),
          findings: profile.finding ? [{ severity: profile.finding.severity, summary: profile.finding.kind, evidence: ["fixed fixture"] }] : [],
        };
        const result = await evaluateAssessment(task, assessment, { workerOk: true, verifierOk: true, threshold: 85 });
        expect(result.verdict, `${task}/${profile.id}`).toBe(profile.expectedDecision);
        expect(needsBoundaryAdjudication(result), `${task}/${profile.id} boundary`).toBe(profile.expectedBoundaryAdjudication);
        count += 1;
      }
    }
    expect(count).toBe(24);
  });

  it("rejects missing criterion evidence rows", async () => {
    const rubric = await loadRubric("backend_core");
    const assessment: CriticAssessment = {
      criteria: [...rubric.base.criteria, ...rubric.task.criteria].slice(1).map((item) => ({ id: item.id, level: "complete", evidence: ["x"] })),
      hardGates: [...rubric.base.hardGates, ...rubric.task.hardGates].map((item) => ({ id: item.id, status: "pass", evidence: ["x"] })),
      findings: [],
    };
    await expect(evaluateAssessment("backend_core", assessment)).rejects.toThrow("criterion ID");
  });
});
