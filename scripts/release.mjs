import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import { atomicJson, json, report, createManifest, verifyManifest, subject, registryState, waitForRegistryState, REGISTRY_VISIBILITY_ATTEMPTS, REGISTRY_VISIBILITY_DELAY_MS, integrity } from "./lib/release.mjs";
const exec = promisify(execFile);
const args = process.argv.slice(2), command = args[0];
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const dir = resolve(value("--evidence", ".release/evidence"));
const archive = value("--archive");
if (command === "record-ci") {
  const checks = ["install", "build", "types", "tests", "docs", "installed-package"].map((name) => ({ name, passed: true }));
  if (!process.env.GITHUB_RUN_ID) throw new Error("CI report requires a GitHub workflow run");
  const archives = (await readdir(".release/package")).filter((f) => f.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error("Expected the single CI-tested archive");
  await atomicJson(join(dir, `ci-${process.platform}-${process.versions.node.split(".")[0]}.json`), await report("ci", checks, { artifactIntegrity: integrity(await readFile(join(".release/package", archives[0]))) }));
} else if (command === "manifest") {
  if (!archive) throw new Error("--archive required");
  const result = await createManifest(resolve(archive), dir);
  await atomicJson(join(dir, "manifest.json"), result);
  console.log(result.artifact.integrity);
} else if (command === "verify") {
  if (!archive) throw new Error("--archive required");
  await verifyManifest(await json(join(dir, "manifest.json")), resolve(archive), dir, await subject());
  console.log("Manifest, source, reports and artifact verified");
} else if (command === "publish") {
  if (process.env.GITHUB_REF !== "refs/heads/main" || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("Publishing requires the main-branch OIDC release workflow");
  if (!archive) throw new Error("--archive required");
  const target = await subject(), manifest = await json(join(dir, "manifest.json"));
  if (target.version !== "0.3.3" || target.sourceCommit !== process.env.RELEASE_SHA) throw new Error("Release version/commit mismatch");
  await verifyManifest(manifest, resolve(archive), dir, target);
  const name = "@worldclasscitizen/ralph";
  const state = await registryState(name, target.version, manifest.artifact.integrity);
  if (state === "identical") console.log("Identical version already published; continuing verification");
  else {
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error("Run via npm run release -- publish ...");
    // npm output used to be discarded, which made a failed upload indistinguishable from
    // a slow registry. It is forwarded and kept for the error message.
    let lastOutput = "";
    try {
      const result = await exec(process.execPath, [npm, "publish", resolve(archive), "--ignore-scripts", "--access", "public", "--tag", "latest"], { maxBuffer: 8_000_000 });
      lastOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    } catch (error) {
      lastOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || String(error.message);
      process.stdout.write(`${lastOutput}\n`);
      throw new Error(`npm publish failed: ${lastOutput.slice(-2000)}`);
    }
    if (lastOutput) process.stdout.write(`${lastOutput}\n`);
  }
  // The upload is never repeated: npm rejects a second upload of the same version, and
  // the measured delay is in propagation, not in the upload itself.
  const visible = await waitForRegistryState(name, target.version, manifest.artifact.integrity, {
    onWait: (attempt, attempts, delayMs) => console.log(`Registry has not reported ${target.version} yet; rechecking (${attempt}/${attempts - 1}) in ${Math.round(delayMs / 1000)}s`),
  });
  if (visible !== "identical")
    throw new Error(`The registry did not expose ${target.version} within ${Math.round((REGISTRY_VISIBILITY_ATTEMPTS * REGISTRY_VISIBILITY_DELAY_MS) / 1000)}s. If npm accepted the upload, re-dispatch the release workflow: an identical existing archive continues verification.`);
} else {
  console.log("release.mjs record-ci | manifest | verify | publish --evidence <directory> --archive <tgz>");
  if (command) process.exitCode = 2;
}
