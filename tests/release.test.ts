import { it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  assertReleaseSchema,
  VerificationReportSchema,
  ReleaseManifestSchema,
  LiveTestBudgetSchema,
  ProviderVerificationSchema,
} from "../src/release/schema.js";
import { loadCatalog, verifyCatalog, validateCatalog } from "../src/catalog.js";
// @ts-ignore release orchestration deliberately stays outside the consumer runtime
import {
  registryState,
  coverageChecks,
  validateReports,
  atomicJson,
  sha256,
  BASELINE,
  CRITICAL,
} from "../scripts/lib/release.mjs";
// @ts-ignore release-only script
import { LiveBudget } from "../scripts/lib/live-budget.mjs";
import { providerVerification } from "../src/providers/verification.js";

const hash = "a".repeat(64);
const subject = {
  version: "0.3.0",
  sourceCommit: "b".repeat(40),
  sourceTree: "c".repeat(40),
  runtimeDigest: hash,
  dependencyDigest: hash,
  testDigest: hash,
};
const coverage = {
  total: { lines: { pct: 58 }, branches: { pct: 74 } },
  ...Object.fromEntries(
    CRITICAL.map((f: string) => [
      `/repo/src/${f}`,
      { lines: { pct: 99 }, branches: { pct: 99 } },
    ]),
  ),
};
const row = (kind: string, platform = "linux", node = "v24.11.1") => ({
  schemaVersion: 1,
  kind,
  subject: { ...subject },
  checkedAt: new Date().toISOString(),
  runner: { platform, node, workflowRunId: "123" },
  status: "pass",
  checks: [{ name: "required", passed: true }],
  details: {} as Record<string, any>,
});
function reports() {
  const rows = ["win32", "darwin", "linux"].flatMap((os) =>
    [22, 24].map((n) => row("ci", os, `v${n}.1.0`)),
  );
  for (const kind of [
    "coverage",
    "accessibility",
    "provider",
    "comparison",
    "catalog",
  ])
    rows.push(row(kind));
  for (const os of ["win32", "darwin", "linux"])
    rows.push({
      ...row("operational", os),
      details: { repetitions: 5, boundaries: ["a", "b", "c", "d", "e"] },
    });
  rows.find((r) => r.kind === "coverage")!.details.coverage = coverage;
  rows.find((r) => r.kind === "accessibility")!.details = {
    maxNodes: 32,
    revisions: 8,
    logLines: 100000,
  };
  const provider = rows.find((r) => r.kind === "provider")!;
  provider.details = { model: "fixture", cliVersion: "fixture-v1" };
  provider.checks = Array.from({ length: 4 }, (_, i) => ({
    name: String(i),
    passed: true,
  }));
  rows.find((r) => r.kind === "comparison")!.details = {
    baselineCommit: BASELINE,
    observations: ["baseline", "candidate", "baseline", "candidate"].map(
      (version) => ({ version, passed: true }),
    ),
  };
  return rows;
}
it("requires a complete, matching evidence matrix instead of boolean release gates", () => {
  const valid = reports();
  expect(() => validateReports(valid, subject)).not.toThrow();
  expect(() =>
    validateReports(
      valid.filter((r: any) => r.runner.platform !== "win32"),
      subject,
    ),
  ).toThrow(/Missing/);
  expect(() =>
    validateReports([{ gates: { allPlatforms: true } }], subject),
  ).toThrow(/Invalid release evidence/);
  valid[0]!.subject.runtimeDigest = "d".repeat(64);
  expect(() => validateReports(valid, subject)).toThrow(/subject mismatch/);
});
it("rejects stale, incomplete and failed comparison evidence", () => {
  for (const change of [
    (rows: any[]) => (rows[0].checkedAt = "2020-01-01T00:00:00Z"),
    (rows: any[]) => (rows[0].status = "fail"),
    (rows: any[]) =>
      (rows.find(
        (r) => r.kind === "comparison",
      ).details.observations[1].passed = false),
    (rows: any[]) => (rows.find((r) => r.kind === "provider").details = {}),
    (rows: any[]) =>
      (rows.find((r) => r.kind === "coverage").details.coverage = {
        total: { lines: { pct: 1 }, branches: { pct: 1 } },
      }),
  ]) {
    const r = reports();
    change(r);
    expect(() => validateReports(r, subject)).toThrow();
  }
});
it("validates all public release contracts and rejects unknown fields", () => {
  assertReleaseSchema(VerificationReportSchema, row("ci"));
  const manifest = {
    schemaVersion: 1,
    releaseId: "ralph-0.3.0",
    subject,
    artifact: { file: "p.tgz", integrity: "sha512-x", sha256: hash },
    reports: [],
    createdAt: new Date().toISOString(),
  };
  assertReleaseSchema(ReleaseManifestSchema, manifest);
  assertReleaseSchema(ProviderVerificationSchema, {
    schemaVersion: 1,
    adapter: "codex-builtin",
    model: "fixture",
    cliVersion: "1",
    platform: "linux",
    node: "v24.0.0",
    checkedAt: new Date().toISOString(),
    runtimeDigest: hash,
    testDigest: hash,
    reportDigest: hash,
    features: [],
    support: "verified",
  });
  expect(() =>
    assertReleaseSchema(ReleaseManifestSchema, { ...manifest, publish: true }),
  ).toThrow();
});
it("persists shared live budgets and counts failed calls", async () => {
  const path = join(
      await mkdtemp(join(tmpdir(), "ralph-budget-")),
      "budget.json",
    ),
    budget = new LiveBudget(path);
  await expect(
    budget.invoke("failure", async () => {
      throw new Error("request failed");
    }),
  ).rejects.toThrow("request failed");
  const state = await new LiveBudget(path).load();
  assertReleaseSchema(LiveTestBudgetSchema, state);
  expect(state.calls).toBe(1);
  expect(state.attempts[0].outcome).toBe("failed");
  state.calls = 24;
  await atomicJson(path, state);
  await expect(budget.invoke("extra", async () => null)).rejects.toThrow(
    /exhausted/,
  );
  state.calls = 1;
  state.pending = {
    attemptId: "unknown",
    startedAt: Date.now(),
    reservedMs: 90_000,
  };
  await atomicJson(path, state);
  await expect(budget.invoke("duplicate", async () => null)).rejects.toThrow(
    /Unconfirmed/,
  );
});
it("enforces the active time ceiling and ownership of an allowance", async () => {
  const path = join(
      await mkdtemp(join(tmpdir(), "ralph-budget-")),
      "budget.json",
    ),
    budget = new LiveBudget(path);
  const state = await budget.load();
  state.activeMs = 1800000;
  await atomicJson(path, state);
  await expect(budget.invoke("extra", async () => null)).rejects.toThrow(
    /exhausted/,
  );
  await expect(new LiveBudget(path, "another-release").load()).rejects.toThrow(
    /another release/,
  );
});
it("distinguishes absent, identical, conflicting and unauthorized registry states", async () => {
  expect(
    await registryState(
      "p",
      "0.3.0",
      "hash",
      async () => new Response("", { status: 404 }),
    ),
  ).toBe("absent");
  expect(
    await registryState("p", "0.3.0", "hash", async () =>
      Response.json({ dist: { integrity: "hash" } }),
    ),
  ).toBe("identical");
  await expect(
    registryState("p", "0.3.0", "hash", async () =>
      Response.json({ dist: { integrity: "other" } }),
    ),
  ).rejects.toThrow(/different artifact/);
  await expect(
    registryState(
      "p",
      "0.3.0",
      "hash",
      async () => new Response("", { status: 401 }),
    ),
  ).rejects.toThrow(/401/);
});
it("keeps old signatures valid while rejecting tampered v2 catalogs", async () => {
  const old = JSON.parse(await readFile("assets/catalog.json", "utf8"));
  expect(verifyCatalog(old, await readFile("assets/catalog.sig", "utf8"))).toBe(
    true,
  );
  const current = await loadCatalog();
  expect(
    current.models.every(
      (m) => m.qualityTier === "unrated" && m.capabilities.reasoning === null,
    ),
  ).toBe(true);
  current.models[0]!.displayName += "tampered";
  expect(
    verifyCatalog(current, await readFile("assets/catalog-v2.sig", "utf8")),
  ).toBe(false);
  current.keyId = "unknown";
  expect(() => validateCatalog(current)).toThrow(/signing key/);
  expect(coverageChecks(coverage).every((c: any) => c.passed)).toBe(true);
});
it("does not fabricate live verification for an untested adapter", async () => {
  expect(await providerVerification("unknown", "1")).toEqual([]);
});
