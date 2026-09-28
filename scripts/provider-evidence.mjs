import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicJson, json, report, subject } from "./lib/release.mjs";
import { PROVIDER_CHECKS } from "./lib/evidence-reuse.mjs";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const value = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
if (args.includes("--help") || !args.includes("--live")) {
  console.log(
    "Regenerate release provider evidence from the documented conformance smoke:\n" +
      "  node scripts/provider-evidence.mjs --live --provider codex --model gpt-6-sol --output docs/project/evidence/live-provider.json [--force]\n" +
      "Makes four bounded real calls through the recorded CLI connection, then writes a VerificationReportV2\n" +
      "provider report for the current source. The end-to-end campaign reuses this file, so regenerate it\n" +
      "whenever the model, CLI version or release environment changes.",
  );
  process.exit(0);
}
const provider = value("--provider", "codex");
const model = value("--model");
const output = value("--output", "docs/project/evidence/live-provider.json");
const budgetPath = resolve(value("--budget", ".release/live-budget.json"));
if (!model) throw new Error("--model is required: report the exact observed model id");

const status = (await exec("git", ["status", "--porcelain", "--untracked-files=normal"], { windowsHide: true })).stdout.trim();
if (status) throw new Error("Commit the tested source before real calls");
if (!args.includes("--force")) {
  try {
    await readFile(output);
    throw new Error(`${output} already exists; archive it first or pass --force`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const raw = resolve(".release/conformance.json");
await exec(
  process.execPath,
  [resolve("scripts/provider-conformance.mjs"), "--live", "--provider", provider, "--model", model, "--budget", budgetPath, "--output", raw],
  { windowsHide: true, timeout: 400_000, maxBuffer: 2_000_000 },
);
const smoke = await json(raw);
const target = await subject();
const checks = smoke.checks.map((check) => ({ name: check.name, passed: check.status === "pass" }));
const missing = PROVIDER_CHECKS.filter((name) => !checks.some((check) => check.name === name && check.passed));
if (missing.length) throw new Error(`Conformance incomplete: ${missing.join(", ")}`);
const providerReport = await report("provider", checks, {
  adapter: "codex-builtin",
  model,
  cliVersion: smoke.cliVersion,
  observations: smoke.checks,
  scope: "CLI transport in the recorded local environment; fresh sessions, no API credentials",
});
providerReport.subject = target;
await atomicJson(resolve(output), providerReport);
console.log(
  JSON.stringify({
    output,
    status: providerReport.status,
    model,
    cliVersion: smoke.cliVersion,
    runtimeDigest: target.runtimeDigest,
    testDigest: target.testDigest,
    dependencyDigest: target.dependencyDigest,
  }),
);
