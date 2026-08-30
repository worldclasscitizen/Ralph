import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveContract, validateContract } from "../src/contracts.js";
import { executeContract } from "../src/orchestrator.js";
import { saveConfig } from "../src/state.js";
import type { ProjectConfig, RouteEntry } from "../src/types.js";
import { runCommand } from "../src/util.js";

describe("orchestration state machine", () => {
  it("runs all nodes and creates an iteration checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-run-"));
    await runCommand("git", ["init"], { cwd: root });
    await runCommand("git", ["config", "user.email", "ralph@example.invalid"], { cwd: root });
    await runCommand("git", ["config", "user.name", "Ralph Test"], { cwd: root });
    await writeFile(join(root, "README.md"), "# Fixture\n");
    await runCommand("git", ["add", "."], { cwd: root });
    await runCommand("git", ["commit", "-m", "baseline"], { cwd: root });
    const fixture = resolve("tests/fixtures/mock-agent.mjs");
    const route: RouteEntry = { connectionId: "mock:process", provider: "mock", modelId: "mock-1", displayName: "Mock Agent", reasoningEffort: "high", score: 100, source: "override" };
    const routes = Object.fromEntries(["planning_architecture","frontend_visual","backend_core","tdd_debugging","static_review","delivery_evidence","contractPlanner","critic","metaPrompter","worker","adjudicator"].map((key) => [key, [route]])) as ProjectConfig["routes"];
    const config: ProjectConfig = { schemaVersion: 1, projectRoot: root, preset: "balanced", initializedAt: new Date().toISOString(), connections: [{ id: "mock:process", adapter: "generic-process", provider: "mock", enabled: true, mode: "process", command: [process.execPath, fixture] }], routes, overrides: {}, verifierCommands: ["node -e \"require('node:fs').accessSync('ralph-smoke.txt')\"", "git diff --check"], catalogVersion: 2 };
    await saveConfig(root, config);
    const contract = approveContract(validateContract({ taskType: "backend_core", goal: "Create a smoke artifact", include: ["ralph-smoke.txt"], exclude: [".git/**"], requirements: ["Write the artifact"], acceptanceCriteria: ["ralph-smoke.txt exists"], verifierCommands: config.verifierCommands, requiredArtifacts: ["ralph-smoke.txt"], attachments: [], constraints: [], executionProfile: "balanced" }, root));
    const run = await executeContract(root, contract);
    expect(run.status).toBe("pass");
    expect(await readFile(join(root, "ralph-smoke.txt"), "utf8")).toBe("ok\n");
    const log = await runCommand("git", ["log", "-1", "--pretty=%B"], { cwd: root });
    expect(log.stdout).toContain("Ralph-Run:");
    expect(log.stdout).toContain("Ralph-Verdict: pass");
  }, 30_000);
});
