# Providers and Dynamic Mesh Routing

Provider, connection and execution transport are separate. Codex login and OpenAI API are distinct connections with independent limits. Only enabled, configured connections are candidates. Installation/authentication checks do not prove that a particular model works.

## Configuration

Run `ralph init`, `ralph providers list`, and `ralph auth status` in the target Git project. API credentials come from the environment or the existing OS credential store. Windows currently uses environment variables; the beta does not claim Windows Credential Manager support.

| Connection ID | Environment variable | API transport |
|---|---|---|
| openai:api | OPENAI_API_KEY | Responses |
| anthropic:api | ANTHROPIC_API_KEY | Messages |
| google:api | GEMINI_API_KEY | generateContent |
| deepseek:api | DEEPSEEK_API_KEY | Chat completions |
| zai:general | GLM_GENERAL_API_KEY | Chat completions |
| zai:coding-plan | GLM_API_KEY | Chat completions |

For a DeepSeek + GLM-only environment, set just the corresponding environment variables before initialization. Remove or disable other entries from the reviewed project configuration if unrelated local CLI logins were automatically detected. `ralph config refresh` recalculates routes from configured connections. All planner/worker/critic roles can use the remaining portfolio.

For another compatible endpoint, add an explicit connection with adapter `openai-compatible`, mode `api`, a `baseUrl`, an `apiKeyEnv` reference and known `models`. Add candidate routes through `ralph config route set`. Compatibility requires the model's actual tool calling and text output behavior; an OpenAI-shaped URL alone is insufficient. Ollama without authentication needs an explicitly configured local placeholder credential because this beta's compatible adapter requires a credential reference.

## Assignment

Hard Pins and fixed routes take priority. Adaptive worker assignment orders approved candidates by catalog quality, then comparable local observations. Only samples in the same task category and verifier protocol with at least 20 terminal logical tasks are compared. Wilson's lower confidence bound is used within equal catalog quality. Inadequate samples preserve catalog order. Latency and available cost break later ties according to profile; no random exploration is performed.

`gateway/measurements.ts` defines benchmark provenance: family, source URL, model revision, harness version, measurement date, sample count, metric, value, unit and task category. Historic v0.2 catalog scores remain compatibility inputs; they must not be described as a new normalized cross-benchmark score. All catalog entries require a source audit before stable release. The plan snapshots empirical history so ranking does not change underneath an approved run.

## Transport contract

`ProviderAdapterV2` exposes describe, probe, listModels and an AsyncIterable invocation. `InvocationRequest` carries logical/attempt IDs, run/node/generation, workspace root, model, bounded permissions, context and deadline. Current adapters emit normalized final-result/error events; token-level streaming is not fabricated for transports that only return a complete response.

The gateway owns retries, connection concurrency and circuit state. It permits at most two attempts per candidate and six per logical request, bounded again by the run total. `Retry-After` is honored; transient errors use delay plus jitter. Pinned models never rotate. Authentication, permissions and nonretryable provider refusals stop with an actionable state. A failed worker that already changed files is preserved for inspection before another attempt.

Worker context overflow uses a bounded evidence-backed prompt retaining the full contract and immutable input references. Planner/critic overflow without a safe compact prompt pauses; the gateway never silently truncates acceptance criteria. Uncertain cancellation cannot be interpreted as permission to start another worker. CLI subprocess cancellation waits for closure and terminates its process tree. Unreported tokens are absent, not zero; pricing-derived cost remains an estimate.

## Support evidence

Support statuses are `verified`, `experimental`, `compatible`, `unavailable`. The automatic probe never grants `verified`. A release conformance report must demonstrate planning, one-file work plus validation, cancellation, session isolation, error classification and usage normalization for the actual installed version/model.

On 2026-09-05, Codex CLI 0.153.1 with gpt-5.4-mini passed four live smoke checks: structured output, exact one-file change, fresh-session isolation and cancellation. The [successful report](evidence/codex-windows.json) and [initial failed check](evidence/codex-windows-initial.json) are preserved. This is bounded smoke evidence, not complete release conformance.

Claude Code 2.1.158 reported a saved login but the actual request returned an expired OAuth error. Its [report](evidence/claude-windows.json) marks the remaining model checks blocked. Gemini authentication was unknown. No API credential was available in the current environment; native API and DeepSeek/GLM evidence is protocol-level mock testing. Credentials and account identifiers are excluded from reports.

Run `node scripts/provider-conformance.mjs --help` for opt-in live checks. The published record lives in [release readiness](../project/v0.3-readiness.md). Mock fixtures prove protocol handling, not service availability or model quality.
