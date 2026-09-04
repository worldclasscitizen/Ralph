import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { git } from "../dist/workspace/manager.js";
import { singleGraph } from "../dist/graph/compiler.js";

export const task = {
  taskType: "backend_core",
  goal: "Implement two independent ESM utilities. left.mjs exports sumNonNegative(values): require an array of finite non-negative numbers; return their sum (empty array => 0); otherwise throw TypeError. right.mjs exports normalizeLabel(value): require a string, trim it, collapse consecutive ASCII whitespace to one space and lowercase; an empty result or non-string throws TypeError. Preserve the exports. No dependencies, network, commits, pushes or other file changes.",
  include: ["left.mjs", "right.mjs"], exclude: [".git/**"],
  acceptanceCriteria: ["Both documented functions satisfy all valid and invalid input cases", "Only the two allowed modules change", "Syntax checks and git diff --check pass"],
  verifierCommands: ["node --check left.mjs", "node --check right.mjs", "git diff --check"],
  requiredArtifacts: ["left.mjs", "right.mjs"], executionProfile: "balanced",
};
export const solutions = {
  "left.mjs": "export function sumNonNegative(values) { if (!Array.isArray(values) || values.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new TypeError('Expected finite non-negative numbers'); return values.reduce((sum, v) => sum + v, 0); }\n",
  "right.mjs": "export function normalizeLabel(value) { if (typeof value !== 'string') throw new TypeError('Expected string'); const result = value.trim().replace(/[\\t\\n\\v\\f\\r ]+/g, ' ').toLowerCase(); if (!result) throw new TypeError('Empty label'); return result; }\n",
};
export async function fixture(root) {
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "release@example.invalid"]);
  await git(root, ["config", "user.name", "Release fixture"]);
  for (const [file, name] of [["left.mjs", "sumNonNegative"], ["right.mjs", "normalizeLabel"]])
    await writeFile(join(root, file), `export function ${name}(value) { throw new Error('Not implemented'); }\n`);
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "Frozen comparison fixture"]);
}
export function graphFor(contract) {
  const graph = singleGraph("comparison", { taskType: task.taskType, goal: task.goal,
    readPaths: ["**"], writePaths: ["left.mjs"], acceptanceCriteria: task.acceptanceCriteria,
    requiredCapabilities: [], inputArtifacts: [], verifierIds: [task.verifierCommands[0], "git diff --check"], budget: { maxIterations: 6 } });
  graph.nodes[0].nodeId = "left";
  graph.edges[0].from = "left";
  graph.nodes.splice(1, 0, { ...graph.nodes[0], nodeId: "right", writePaths: ["right.mjs"], verifierIds: [task.verifierCommands[1], "git diff --check"] });
  graph.edges.push({ from: "right", to: "integrate", kind: "artifact" });
  graph.nodes.find(n => n.kind === "validate").verifierIds = contract.verifierCommands;
  return graph;
}
/** This oracle is outside both model workspaces and never added to their prompts. */
export async function oracle(root) {
  const { sumNonNegative: sum } = await import(pathToFileURL(join(root, "left.mjs")).href);
  const { normalizeLabel: label } = await import(pathToFileURL(join(root, "right.mjs")).href);
  assert.equal(sum([]), 0); assert.equal(sum([0, 1, 2.5, 8]), 11.5);
  for (const invalid of [null, {}, "1", [-1], [NaN], [Infinity], ["1"], [true]]) assert.throws(() => sum(invalid), TypeError);
  assert.equal(label("  HeLLo\t\nWORLD  "), "hello world"); assert.equal(label("ONE"), "one");
  for (const invalid of [null, 1, [], {}, "", "\t\n  "]) assert.throws(() => label(invalid), TypeError);
  return true;
}
