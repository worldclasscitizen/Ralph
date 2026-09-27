import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

if (!process.argv.includes("--init-key")) throw new Error("Explicit --init-key required; never run in a package build");
const keyPath = join(homedir(), ".config", "ralph", "release-keys", "catalog-v2.pem");
await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
let privateKey;
try { privateKey = createPrivateKey(await readFile(keyPath)); }
catch (e) {
  if (e.code !== "ENOENT") throw e;
  privateKey = generateKeyPairSync("ed25519").privateKey;
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
}
if (process.platform === "win32") {
  const sid = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).match(/S-1-[0-9-]+/)?.[0];
  if (!sid) throw new Error("Cannot resolve current Windows account SID");
  execFileSync("icacls", [keyPath, "/inheritance:r", "/grant:r", `*${sid}:(F)`], { stdio: "pipe", windowsHide: true });
}
const publicKey = createPublicKey(privateKey), pem = publicKey.export({ type: "spki", format: "pem" });
const keyId = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
await writeFile("src/catalog-key.ts", `// Public trust anchor. Private signing material stays outside this repository.\nexport const CATALOG_KEY_ID = ${JSON.stringify(keyId)};\nexport const CATALOG_PUBLIC_KEY_PEM = ${JSON.stringify(pem)};\n`);
// One definition per (adapter, model) candidate. Only the newest model of each tier is
// listed; superseded ids are removed rather than kept as silent fallbacks.
// effort: "standard" = low/medium/high, "zai" = GLM's documented low/high/max.
const definitions = [
  ["openai", "codex-builtin", "gpt-6-astra", "GPT-6 Astra", "https://learn.chatgpt.com/docs/models", false, true, "standard"],
  ["openai", "codex-builtin", "gpt-6-sol", "GPT-6 Sol", "https://learn.chatgpt.com/docs/models", false, true, "standard"],
  ["openai", "codex-builtin", "gpt-6-luna", "GPT-6 Luna", "https://learn.chatgpt.com/docs/models", false, true, "standard"],
  ["openai", "openai-api", "gpt-6-astra", "GPT-6 Astra", "https://developers.openai.com/api/docs/models/gpt-6-astra", true, true, "standard"],
  ["openai", "openai-api", "gpt-6-sol", "GPT-6 Sol", "https://developers.openai.com/api/docs/models/gpt-6-sol", true, true, "standard"],
  ["openai", "openai-api", "gpt-6-luna", "GPT-6 Luna", "https://developers.openai.com/api/docs/models/gpt-6-luna", true, true, "standard"],
  ["anthropic", "claude-code-builtin", "claude-opus-5-5", "Claude Opus 5.5", "https://platform.claude.com/docs/en/models/opus-5-5/overview", true, true, "standard"],
  ["anthropic", "claude-code-builtin", "claude-fable-5-1", "Claude Fable 5.1", "https://platform.claude.com/docs/en/models/fable-5-1/overview", true, true, "standard"],
  ["anthropic", "anthropic-api", "claude-opus-5-5", "Claude Opus 5.5", "https://platform.claude.com/docs/en/models/opus-5-5/overview", true, true, "standard"],
  ["anthropic", "anthropic-api", "claude-fable-5-1", "Claude Fable 5.1", "https://platform.claude.com/docs/en/models/fable-5-1/overview", true, true, "standard"],
  ["google", "gemini-cli-builtin", "gemini-3.8-flash", "Gemini 3.8 Flash", "https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash", true, true, "standard"],
  ["google", "gemini-api", "gemini-3.8-flash", "Gemini 3.8 Flash", "https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash", true, true, "standard"],
  ["deepseek", "deepseek-api", "deepseek-flash", "DeepSeek V4.1 Flash", "https://api-docs.deepseek.com/updates/", true, true, "standard"],
  ["zai", "zai-general-api", "glm-5.3", "GLM-5.3", "https://docs.z.ai/guides/llm/glm-5.3", false, true, "zai"],
  ["zai", "zai-general-api", "glm-5.3-flash", "GLM-5.3 Flash", "https://docs.z.ai/guides/vlm/glm-5.3-flash", true, true, "zai"],
  ["zai", "zai-coding-plan", "glm-5.3", "GLM-5.3", "https://docs.z.ai/guides/llm/glm-5.3", false, true, "zai"],
];
const EFFORTS = { standard: ["low", "medium", "high"], zai: ["low", "high", "max"] };
const CHECKED_AT = "2026-09-27";
const tasks = ["planning_architecture", "frontend_visual", "backend_core", "tdd_debugging", "static_review", "delivery_evidence"];
const catalog = { schemaVersion: 2, keyId, version: 5, generatedAt: `${CHECKED_AT}T00:00:00.000Z`, models: definitions.map(([provider, adapter, modelId, displayName, source, vision, longContext, effort]) => ({
  provider, adapter, modelId, displayName, qualityTier: "unrated", checkedAt: `${CHECKED_AT}T00:00:00.000Z`, expiresAt: "2027-03-27T00:00:00.000Z",
  capabilities: { reasoning: null, coding: null, structuredOutput: true, vision, toolUse: true, longContext },
  taskAffinity: Object.fromEntries(tasks.map((t) => [t, null])), costTier: null, latencyTier: null, reliabilityBaseline: null,
  supportedEfforts: EFFORTS[effort], recommendedEffort: "low",
  evidence: [{ source, checkedAt: CHECKED_AT }],
})) };
await writeFile("assets/catalog-v2.json", JSON.stringify(catalog, null, 2) + "\n");
await writeFile("assets/catalog-v2.sig", sign(null, Buffer.from(JSON.stringify(catalog)), privateKey).toString("base64") + "\n");
console.log(JSON.stringify({ keyId, publicKey: pem, privateKeyStoredOutsideRepository: true, legacyAssetsUnchanged: true }));
