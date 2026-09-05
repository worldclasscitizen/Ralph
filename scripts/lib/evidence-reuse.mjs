import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertReleaseSchema, EvidenceReuseSchema, VerificationReportV1Schema } from "../../dist/release/schema.js";

const exec = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const normalize = bytes => Buffer.from(bytes).includes(0) ? bytes : Buffer.from(bytes).toString("utf8").replaceAll("\r\n", "\n");
export const PROVIDER_CHECKS = ["structured_output", "file_change_and_deterministic_verification", "fresh_request_isolation", "cancel_and_await_close"];
async function git(root, args) { return (await exec("git", args, { cwd: root, encoding: "buffer", maxBuffer: 20_000_000, windowsHide: true })).stdout; }
// Conservative execution scope: all consumer source except release evidence
// schemas, the exact conformance requests, allowance implementation and lockfile.
// Report serialization/release gates are tested without making model calls.
const included = path => (path.startsWith("src/") && !path.startsWith("src/release/")) || ["scripts/provider-conformance.mjs", "scripts/lib/live-budget.mjs", "package-lock.json"].includes(path);
export async function providerFiles(root, ref) {
  if (ref && !/^[a-f0-9]{40}$/.test(ref)) throw new Error("Invalid evidence source commit");
  const names = (await git(root, ref ? ["ls-tree", "-r", "--name-only", "-z", ref] : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).toString("utf8").split("\0").filter(included);
  return Promise.all([...new Set(names)].sort().map(async path => ({ path, sha256: hash(normalize(ref ? await git(root, ["show", `${ref}:${path}`]) : await readFile(join(root, path)))) })));
}
function assertOriginal(report, observed) {
  assertReleaseSchema(VerificationReportV1Schema, report);
  if (report.kind !== "provider" || report.status !== "pass" || report.checks.some(c => !c.passed) || PROVIDER_CHECKS.some(name => !report.checks.some(c => c.name === name && c.passed))) throw new Error("Only complete, passing provider evidence can be reused");
  const recorded = { adapter: report.details.adapter, model: report.details.model, cliVersion: report.details.cliVersion, platform: report.runner.platform, node: report.runner.node };
  if (JSON.stringify(recorded) !== JSON.stringify(observed)) throw new Error("Provider environment changed");
}
export async function createEvidenceReuse(root, originalPath, observed) {
  const bytes = await readFile(originalPath), original = JSON.parse(bytes);
  assertOriginal(original, observed);
  const previous = await providerFiles(root, original.subject.sourceCommit), current = await providerFiles(root);
  if (JSON.stringify(previous) !== JSON.stringify(current)) throw new Error("Provider execution protocol changed; new live evidence required");
  const reuse = { schemaVersion: 1, protocol: "codex-conformance-v1", originalFile: basename(originalPath), originalSha256: hash(bytes), originalCheckedAt: original.checkedAt, sourceCommit: original.subject.sourceCommit, sourceFiles: previous, observed, verifiedAt: new Date().toISOString() };
  assertReleaseSchema(EvidenceReuseSchema, reuse);
  return reuse;
}
export async function verifyEvidenceReuse(report, directory, root = process.cwd()) {
  if (!report.reuse) return;
  const reuse = report.reuse;
  assertReleaseSchema(EvidenceReuseSchema, reuse);
  const bytes = await readFile(join(directory, reuse.originalFile));
  if (hash(bytes) !== reuse.originalSha256) throw new Error("Original provider report integrity mismatch");
  const original = JSON.parse(bytes);
  assertOriginal(original, reuse.observed);
  if (report.kind !== "provider" || report.schemaVersion !== 2 || original.checkedAt !== report.checkedAt || original.checkedAt !== reuse.originalCheckedAt || original.subject.sourceCommit !== reuse.sourceCommit || JSON.stringify(original.checks) !== JSON.stringify(report.checks) || JSON.stringify(original.details) !== JSON.stringify(report.details) || JSON.stringify(original.runner) !== JSON.stringify(report.runner)) throw new Error("Reused evidence changed its original result or scope");
  const previous = await providerFiles(root, reuse.sourceCommit), current = await providerFiles(root);
  if (JSON.stringify(previous) !== JSON.stringify(reuse.sourceFiles) || JSON.stringify(previous) !== JSON.stringify(current)) throw new Error("Provider protocol identity mismatch");
}
