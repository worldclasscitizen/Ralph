import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyRisk, deterministicRouteDecision, roleRoutes } from "../src/policy.js";
import type { ProjectConfig, RouteEntry, TaskContract } from "../src/types.js";
import { runCommand } from "../src/util.js";
import { runVerifier } from "../src/verifier.js";

const primary: RouteEntry = { connectionId: "openai:login", provider: "openai", modelId: "quality", displayName: "Quality", reasoningEffort: "high", score: 95, source: "automatic" };
const fast: RouteEntry = { connectionId: "google:login", provider: "google", modelId: "fast", displayName: "Fast", reasoningEffort: "high", score: 80, source: "automatic" };
const keys = ["planning_architecture","frontend_visual","backend_core","tdd_debugging","static_review","delivery_evidence","contractPlanner","router","critic","metaPrompter","worker","adjudicator"] as const;

function fixtureContract(overrides: Partial<TaskContract> = {}): TaskContract {
  return { id: "contract", taskType: "backend_core", goal: "Change business logic", include: ["src/**"], exclude: [".git/**"], requirements: ["Correct result"], acceptanceCriteria: ["Tests pass"], verifierCommands: ["git diff --check"], requiredArtifacts: [], attachments: [], constraints: [], executionProfile: "balanced", projectRoot: "/tmp/project", ...overrides };
}

function fixtureConfig(root = "/tmp/project"): ProjectConfig {
  return { schemaVersion: 1, projectRoot: root, preset: "balanced", initializedAt: new Date().toISOString(), connections: [], routes: Object.fromEntries(keys.map((key) => [key, [primary, fast]])) as ProjectConfig["routes"], overrides: {}, routePolicies: {}, verifierCommands: ["git diff --check"], verification: { frozenInvariants: [] }, catalogVersion: 1 };
}

describe("quality-first runtime policy", () => {
  it("classifies destructive authorization work as T3", () => {
    expect(classifyRisk(fixtureContract({ goal: "Delete authentication credentials safely" }))).toBe("T3");
  });

  it("honors a hard pin and refuses implicit session continuation", () => {
    const config = fixtureConfig();
    config.routePolicies = { backend_core: { mode: "adaptive", hardPin: { connectionId: fast.connectionId, modelId: fast.modelId, reasoningEffort: "max" } } };
    const decision = deterministicRouteDecision(config, fixtureContract(), "iteration_start", { suggested: { connectionId: primary.connectionId, modelId: primary.modelId, sessionPolicy: "continue" } });
    expect(decision.modelId).toBe("fast");
    expect(decision.reasoningEffort).toBe("max");
    expect(decision.source).toBe("hard_pin");
    expect(decision.sessionPolicy).toBe("fresh");
  });

  it("rejects an online suggestion outside the quality-equivalent band", () => {
    const decision = deterministicRouteDecision(fixtureConfig(), fixtureContract(), "iteration_start", {
      suggested: {
        connectionId: fast.connectionId,
        modelId: fast.modelId,
        rationale: "Prefer the lower-latency candidate.",
      },
    });
    expect(decision.modelId).toBe("quality");
    expect(decision.source).toBe("deterministic_fallback");
    expect(decision.rationale).toContain("품질 동등 범위");
  });

  it("applies a role-specific hard pin to non-Worker calls", () => {
    const config = fixtureConfig();
    config.routePolicies = { critic: { mode: "adaptive", candidates: [primary, fast], hardPin: { connectionId: fast.connectionId, modelId: fast.modelId, reasoningEffort: "max" } } };
    expect(roleRoutes(config, "critic")).toEqual([{ ...fast, reasoningEffort: "max" }]);
  });

  it("uses speed only inside the quality-equivalent band", () => {
    const config = fixtureConfig();
    config.preset = "fast";
    const equivalentFast = { ...fast, score: 94, qualityScore: 94, latencyScore: 100 };
    const slowerPrimary = { ...primary, qualityScore: 95, latencyScore: 20 };
    config.routes.backend_core = [slowerPrimary, equivalentFast];
    expect(deterministicRouteDecision(config, fixtureContract(), "iteration_start").modelId).toBe("fast");

    config.routes.backend_core = [slowerPrimary, { ...equivalentFast, score: 92, qualityScore: 92 }];
    expect(deterministicRouteDecision(config, fixtureContract(), "iteration_start").modelId).toBe("quality");
  });
});

describe("risk-based verifier policy", () => {
  it("blocks excluded-file changes and test weakening", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-verifier-"));
    await runCommand("git", ["init"], { cwd: root });
    await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await runCommand("git", ["config", "user.name", "Ralph Test"], { cwd: root });
    await writeFile(join(root, "protected.js"), "export const value = 1;\n");
    await runCommand("git", ["add", "."], { cwd: root });
    await runCommand("git", ["commit", "-m", "baseline"], { cwd: root });
    await writeFile(join(root, "protected.js"), "test.skip('hidden', () => {});\n");
    const contract = fixtureContract({ projectRoot: root, exclude: ["protected.js"] });
    const result = await runVerifier(root, fixtureConfig(root), ["git diff --check"], [], { riskTier: "T1", contract });
    expect(result.ok).toBe(false);
    expect(result.gates.find((gate) => gate.id === "contract_drift")?.status).toBe("fail");
    expect(result.gates.find((gate) => gate.id === "test_tampering")?.status).toBe("fail");
  });

  it("requires a coverage report once a ratchet baseline exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-coverage-"));
    await runCommand("git", ["init"], { cwd: root });
    await writeFile(join(root, "README.md"), "fixture\n");
    const config = fixtureConfig(root);
    config.verification = { frozenInvariants: [], coverageBaseline: { lines: 80 } };
    const result = await runVerifier(root, config, ["git diff --check"], [], { riskTier: "T1", contract: fixtureContract({ projectRoot: root }) });
    expect(result.gates.find((gate) => gate.id === "coverage_ratchet")?.status).toBe("fail");
  });

  it("detects validation bypasses in newly created untracked tests", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-tampering-"));
    await runCommand("git", ["init"], { cwd: root });
    await writeFile(join(root, "new.test.js"), "test.only('focused', () => {});\n");
    const result = await runVerifier(root, fixtureConfig(root), ["git diff --check"], [], { riskTier: "T1", contract: fixtureContract({ projectRoot: root }) });
    expect(result.gates.find((gate) => gate.id === "test_tampering")?.status).toBe("fail");
    expect(result.gates.find((gate) => gate.id === "test_tampering")?.evidence.join("\n")).toContain("new.test.js");
  });

  it("re-verifies T2 changes in an isolated worktree and proves changed tests bite", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-mutation-"));
    await runCommand("git", ["init"], { cwd: root });
    await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await runCommand("git", ["config", "user.name", "Ralph Test"], { cwd: root });
    await writeFile(join(root, "package.json"), "{\"type\":\"module\",\"scripts\":{\"test\":\"node --test\"}}\n");
    await writeFile(join(root, "value.js"), "export const value = 1;\n");
    await writeFile(join(root, "value.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from './value.js'; test('value',()=>assert.equal(value,1));\n");
    await runCommand("git", ["add", "."], { cwd: root });
    await runCommand("git", ["commit", "-m", "baseline"], { cwd: root });
    await writeFile(join(root, "value.js"), "export const value = 2;\n");
    await writeFile(join(root, "value.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from './value.js'; test('value',()=>assert.equal(value,2));\n");
    const result = await runVerifier(root, fixtureConfig(root), ["npm test"], [], { riskTier: "T2", contract: fixtureContract({ projectRoot: root, include: ["value.js", "value.test.js"] }) });
    expect(result.gates.find((gate) => gate.id === "clean_worktree_verification")?.status).toBe("pass");
    expect(result.gates.find((gate) => gate.id === "mutation_bite")?.status).toBe("pass");
  }, 30_000);
});
