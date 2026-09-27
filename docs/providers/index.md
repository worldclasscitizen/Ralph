# Providers and Dynamic Mesh Routing

Provider, connection and execution transport are separate. Codex login and OpenAI API are distinct connections with independent limits. Only enabled, configured connections are candidates. Installation/authentication checks do not prove that a particular model works.

## Configuration

Run `ralph init`, `ralph providers list`, and `ralph auth status` in the target Git project. API credentials come from the environment or the existing OS credential store. Windows currently uses environment variables; Windows Credential Manager is not implemented.

| Connection ID | Environment variable | API transport |
|---|---|---|
| openai:api | OPENAI_API_KEY | Responses |
| anthropic:api | ANTHROPIC_API_KEY | Messages |
| google:api | GEMINI_API_KEY | generateContent |
| deepseek:api | DEEPSEEK_API_KEY | Chat completions |
| zai:general | GLM_GENERAL_API_KEY | Chat completions |
| zai:coding-plan | GLM_API_KEY | Chat completions |

For a DeepSeek + GLM-only environment, set just the corresponding environment variables before initialization. Remove or disable other entries from the reviewed project configuration if unrelated local CLI logins were automatically detected. `ralph config refresh` recalculates routes from configured connections. All planner/worker/critic roles can use the remaining portfolio.

For another compatible endpoint, add an explicit connection with adapter `openai-compatible`, mode `api`, a `baseUrl`, an `apiKeyEnv` reference and known `models`. Add candidate routes through `ralph config route set`. Compatibility requires the model's actual tool calling and text output behavior; an OpenAI-shaped URL alone is insufficient. Ollama without authentication needs an explicitly configured local placeholder credential because the compatible adapter requires a credential reference.

## Model catalog

The candidate model pool is data, not code. The router reads only the Ed25519-signed `assets/catalog-v2.json` (with `assets/catalog-v2.sig` and the public trust anchor in `src/catalog-key.ts`), filtered by configured connection adapter, capability and expiry in `src/router.ts`. Inspect it with `ralph catalog show`, `ralph catalog diff` and `ralph catalog update`; `npm run catalog:audit` verifies the v2 signature, the trust anchor, the six official evidence hosts and that the legacy `assets/catalog.json`/`catalog.sig` pair stays byte-identical to the frozen v0.2 channel.

Catalog version 4 (checked 2026-09-27, expires 2027-03-27) lists only the newest model of each tier; superseded ids are removed instead of kept as silent fallbacks.

| Adapter | Candidate models | Vision | Effort strings |
|---|---|---|---|
| codex-builtin | gpt-6-astra, gpt-6-sol, gpt-6-luna | no | low, medium, high |
| openai-api | gpt-6-astra, gpt-6-sol, gpt-6-luna | yes | low, medium, high |
| claude-code-builtin | claude-opus-5-5, claude-fable-5-1, claude-haiku-4-5 | yes | low, medium, high |
| anthropic-api | claude-opus-5-5, claude-fable-5-1, claude-haiku-4-5 | yes | low, medium, high |
| gemini-cli-builtin | gemini-3.8-flash | yes | low, medium, high |
| gemini-api | gemini-3.8-flash | yes | low, medium, high |
| deepseek-api | deepseek-flash (`DeepSeek-V4.1-Flash`) | yes | low, medium, high |
| zai-general-api | glm-5.3, glm-5.3-flash | glm-5.3 no, flash yes | low, high, max |
| zai-coding-api | glm-5.3 | no | low, high, max |

Every entry is `qualityTier: "unrated"` with null scores and cites one official provider page from an allow-listed host (`learn.chatgpt.com`, `developers.openai.com`, `platform.claude.com`, `ai.google.dev`, `api-docs.deepseek.com`, `docs.z.ai`). Entries expire after six months, so an unrefreshed catalog drops models instead of routing to them forever. No measured benchmark value is published for these models; adding one requires provenance recorded in `gateway/measurements.ts`, never an estimate. `gpt-6-astra` is listed for Codex only where the CLI exposes it as a power preset, and audit-only entries such as Claude Mythos 5.1 (invite-only) and Gemini Pro previews are deliberately absent.

## Assignment

Hard Pins and fixed routes take priority. Adaptive worker assignment orders approved candidates by catalog quality, then comparable local observations. Only samples in the same task category and verifier protocol with at least 20 terminal logical tasks are compared. Wilson's lower confidence bound is used within equal catalog quality. Inadequate samples preserve catalog order. Latency and available cost break later ties according to profile; no random exploration is performed.

`gateway/measurements.ts` defines benchmark provenance: family, source URL, model revision, harness version, measurement date, sample count, metric, value, unit and task category. The separately signed v2 catalog uses official model sources and marks unsupported quality measurements `unrated`. The original v0.2 catalog and signature are retained only for the legacy channel. Scores from different benchmarks are not combined. The plan snapshots empirical history so ranking does not change underneath an approved run.

## Transport contract

`ProviderAdapterV2` exposes describe, probe, listModels and an AsyncIterable invocation. `InvocationRequest` carries logical/attempt IDs, run/node/generation, workspace root, model, bounded permissions, context and deadline. Current adapters emit normalized final-result/error events; token-level streaming is not fabricated for transports that only return a complete response.

The gateway owns retries, connection concurrency and circuit state. It permits at most two attempts per candidate and six per logical request, bounded again by the run total. `Retry-After` is honored; transient errors use delay plus jitter. Pinned models never rotate. Authentication, permissions and nonretryable provider refusals stop with an actionable state. A failed worker that already changed files is preserved for inspection before another attempt.

Worker context overflow uses a bounded evidence-backed prompt retaining the full contract and immutable input references. Planner/critic overflow without a safe compact prompt pauses; the gateway never silently truncates acceptance criteria. Uncertain cancellation cannot be interpreted as permission to start another worker. CLI subprocess cancellation waits for closure and terminates its process tree. Unreported tokens are absent, not zero; pricing-derived cost remains an estimate.

## Support evidence

Support statuses are `verified`, `experimental`, `compatible`, `unavailable`. Installation and authentication alone never grant `verified`. The probe can report verification only when a packaged evidence record matches the installed CLI version, platform, Node.js major version and freshness window. Records come from release reports; README, CLI and dashboard share this data. Mock tests exercise error handling and usage normalization separately.

The stable campaign verified Codex CLI 0.153.4, gpt-5.6-luna, Windows and Node.js 24.11.1. Four [transport checks](../project/evidence/live-provider.json) passed, and the [natural-language graph trial](../project/evidence/live-functional.json) completed through verified branch delivery. Transport reuse proves unchanged source files, requests, dependency lock and environment; original dates and results are preserved. Windows sandbox sessions receive an exact-worktree, process-scoped Git trust setting without changing global Git configuration or sandbox permissions. Earlier comparison and failed trials remain in the [campaign review](../project/release-campaign-2026-09-05.md).

That certificate is unchanged in 0.3.1, but the model it names is not in the 0.3.1 catalog: `gpt-5.6-luna` was removed as superseded, so the 0.3.1 candidate pool contains no entry with live support evidence. Treat every 0.3.1 route as protocol-tested only until `node scripts/provider-conformance.mjs --help` and the end-to-end run record the model actually used. Support is never transferred to a different model id, CLI version or platform by analogy.

Earlier beta records for Codex CLI 0.153.1 and gpt-5.4-mini are preserved as [historical smoke evidence](evidence/codex-windows.json), including the [initial failed check](evidence/codex-windows-initial.json). They are not used to establish current model availability or stable support.

Claude Code 2.1.158 reported a saved login but the actual request returned an expired OAuth error. Its [report](evidence/claude-windows.json) marks the remaining model checks blocked. Gemini authentication was unknown. No API credential was available in the current environment; native API and DeepSeek/GLM evidence is protocol-level mock testing. Credentials and account identifiers are excluded from reports.

Run `node scripts/provider-conformance.mjs --help` for opt-in live checks. The published record lives in [release readiness](../project/v0.3-readiness.md). Mock fixtures prove protocol handling, not service availability or model quality.
