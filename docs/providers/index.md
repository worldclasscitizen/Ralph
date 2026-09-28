# Providers and Dynamic Mesh Routing

Provider, connection and execution transport are separate. Codex login and OpenAI API are distinct connections with independent limits. Only enabled, configured connections are candidates. Installation/authentication checks do not prove that a particular model works.

## Configuration

Run `ralph init` in the target Git project, then `ralph auth setup`. The setup command prints every provider with its current state, lets you pick providers, offers the transports each provider actually supports (installed CLI login or API key), asks for an API key without echoing it, and lets you select any number of models per connection. It works identically from a terminal and from a host integration, because Codex, Claude Code, Gemini CLI and Antigravity all shell out to this same CLI.

```bash
ralph auth setup                      # status + guided selection
ralph auth status                     # the same status table, no changes
ralph auth status --json               # machine-readable status
ralph auth login claude-code-builtin   # run the provider's own login command
ralph auth add deepseek:api --key-stdin < key.txt
ralph auth remove zai:general
```

Selection is stored per connection as `models`, so a later `ralph init` or `ralph config refresh` never widens it. Non-interactive hosts and CI use the flags below; without them a non-interactive run fails instead of hanging.

```bash
ralph auth setup --provider deepseek --method api --key-stdin --models deepseek-flash
ralph auth setup --provider zai --method api --key-env GLM_API_KEY   # read the key from the environment
```

| Connection ID | Provider | Transport | Environment variable |
|---|---|---|---|
| openai:codex-login | openai | Codex CLI login | — |
| anthropic:claude-login | anthropic | Claude Code login | — |
| google:gemini-cli-login | google | Gemini CLI login | — |
| google:antigravity-login | google | Antigravity CLI (`agy`) | — |
| openai:api | openai | Responses | OPENAI_API_KEY |
| anthropic:api | anthropic | Messages | ANTHROPIC_API_KEY |
| google:api | google | generateContent | GEMINI_API_KEY |
| deepseek:api | deepseek | Chat completions | DEEPSEEK_API_KEY |
| zai:general | zai | Chat completions | GLM_GENERAL_API_KEY |
| zai:coding-plan | zai | Chat completions | GLM_API_KEY |

A key entered through `ralph auth setup` is stored in the macOS Keychain or the Freedesktop Secret Service when available. Otherwise it is written to `credentials.json` in the per-user Ralph directory (`%APPDATA%\ralph`, `~/Library/Application Support/ralph` or `$XDG_CONFIG_HOME/ralph`), created with owner-only permissions and never written into a project or committed. On Windows that file is additionally encrypted with DPAPI for the current user, so a copied file is useless elsewhere; `RALPH_CREDENTIAL_ENCRYPTION=none` stores plaintext and `RALPH_CREDENTIAL_STORE=file` skips the keychain deliberately on a headless or shared machine. `ralph auth status` reports the location and whether it is protected. Environment variables still work and remain the only path needed in CI.

Some CLIs (Gemini CLI, Antigravity) cannot report whether they are logged in. An unknown state is never treated as connected on its own: `ralph auth setup` asks you to confirm the session, and a non-interactive run must pass `--assume-login`. The confirmation is recorded as `trusted` on that connection, so a later `ralph init` or `ralph config refresh` keeps the decision instead of silently reversing it. Installation alone never enables a route.

For a DeepSeek + GLM-only environment, set just the corresponding environment variables before initialization. Remove or disable other entries from the reviewed project configuration if unrelated local CLI logins were automatically detected. `ralph config refresh` recalculates routes from configured connections. All planner/worker/critic roles can use the remaining portfolio.

For another compatible endpoint, add an explicit connection with adapter `openai-compatible`, mode `api`, a `baseUrl`, an `apiKeyEnv` reference and known `models`. Add candidate routes through `ralph config route set`. Compatibility requires the model's actual tool calling and text output behavior; an OpenAI-shaped URL alone is insufficient. Ollama without authentication needs an explicitly configured local placeholder credential because the compatible adapter requires a credential reference.

## Model catalog

The candidate model pool is data, not code. The router reads only the Ed25519-signed `assets/catalog-v2.json` (with `assets/catalog-v2.sig` and the public trust anchor in `src/catalog-key.ts`), filtered by configured connection adapter, capability and expiry in `src/router.ts`. Inspect it with `ralph catalog show`, `ralph catalog diff` and `ralph catalog update`; `npm run catalog:audit` verifies the v2 signature, the trust anchor, the six official evidence hosts and that the legacy `assets/catalog.json`/`catalog.sig` pair stays byte-identical to the frozen v0.2 channel.

Catalog version 6 (checked 2026-09-27, expires 2027-03-27) lists only the newest model of each tier; superseded ids are removed instead of kept as silent fallbacks. A cached catalog is used only when it is strictly newer than the bundled one, so a stale cache can never shadow the signature-verified artifact shipped with the package.

| Adapter | Candidate models | Vision | Effort strings |
|---|---|---|---|
| codex-builtin | gpt-6-astra, gpt-6-sol, gpt-6-luna | no | low, medium, high |
| openai-api | gpt-6-astra, gpt-6-sol, gpt-6-luna | yes | low, medium, high |
| claude-code-builtin | claude-opus-5-5, claude-fable-5-1 | yes | low, medium, high |
| anthropic-api | claude-opus-5-5, claude-fable-5-1 | yes | low, medium, high |
| gemini-cli-builtin | gemini-3.8-flash | yes | low, medium, high |
| gemini-api | gemini-3.8-flash | yes | low, medium, high |
| deepseek-api | deepseek-flash (`DeepSeek-V4.1-Flash`) | yes | low, medium, high |
| zai-general-api | glm-5.3, glm-5.3-flash | glm-5.3 no, flash yes | low, high, max |
| zai-coding-plan | glm-5.3, glm-5.3-flash | glm-5.3 no, flash yes | low, high, max |

Every entry is `qualityTier: "unrated"` with null scores and cites one official provider page from an allow-listed host (`learn.chatgpt.com`, `developers.openai.com`, `platform.claude.com`, `ai.google.dev`, `api-docs.deepseek.com`, `docs.z.ai`). Entries expire after six months, so an unrefreshed catalog drops models instead of routing to them forever. No measured benchmark value is published for these models; adding one requires provenance recorded in `gateway/measurements.ts`, never an estimate.

Model admission is deliberately narrow. `claude-haiku-4-5` is excluded: it is the only current Claude limited to 200K context, and the credible criticism against it is specifically about autonomous coding-agent work, which is exactly this project's workload. `deepseek-v4-pro` is excluded because DeepSeek rerouted that id to `deepseek-flash` on 2026-09-14, so it no longer names a distinct model. Claude Mythos 5.1 (invite-only) and Gemini Pro previews are excluded because they are not generally available. `gemini-3.8-flash` is kept as the only generally available Gemini, but it is also the entry with the weakest reliability signal (reports of elevated latency and `MODEL_CAPACITY_EXHAUSTED` errors) and is not live-verified. `gpt-6-sol` carries mixed community sentiment and is therefore a candidate, not a default; it is the one model with a live certificate.

## Assignment

Hard Pins and fixed routes take priority. Adaptive worker assignment orders approved candidates by catalog quality, then comparable local observations. Only samples in the same task category and verifier protocol with at least 20 terminal logical tasks are compared. Wilson's lower confidence bound is used within equal catalog quality. Inadequate samples preserve catalog order. Latency and available cost break later ties according to profile; no random exploration is performed.

`gateway/measurements.ts` defines benchmark provenance: family, source URL, model revision, harness version, measurement date, sample count, metric, value, unit and task category. The separately signed v2 catalog uses official model sources and marks unsupported quality measurements `unrated`. The original v0.2 catalog and signature are retained only for the legacy channel. Scores from different benchmarks are not combined. The plan snapshots empirical history so ranking does not change underneath an approved run.

## Transport contract

`ProviderAdapterV2` exposes describe, probe, listModels and an AsyncIterable invocation. `InvocationRequest` carries logical/attempt IDs, run/node/generation, workspace root, model, bounded permissions, context and deadline. Current adapters emit normalized final-result/error events; token-level streaming is not fabricated for transports that only return a complete response.

The gateway owns retries, connection concurrency and circuit state. It permits at most two attempts per candidate and six per logical request, bounded again by the run total. `Retry-After` is honored; transient errors use delay plus jitter. Pinned models never rotate. Authentication, permissions and nonretryable provider refusals stop with an actionable state. A failed worker that already changed files is preserved for inspection before another attempt.

Worker context overflow uses a bounded evidence-backed prompt retaining the full contract and immutable input references. Planner/critic overflow without a safe compact prompt pauses; the gateway never silently truncates acceptance criteria. Uncertain cancellation cannot be interpreted as permission to start another worker. CLI subprocess cancellation waits for closure and terminates its process tree. Unreported tokens are absent, not zero; pricing-derived cost remains an estimate.

## Support evidence

Support statuses are `verified`, `experimental`, `compatible`, `unavailable`. Installation and authentication alone never grant `verified`. The probe can report verification only when a packaged evidence record matches the installed CLI version, platform, Node.js major version and freshness window. Records come from release reports; README, CLI and dashboard share this data. Mock tests exercise error handling and usage normalization separately.

The 0.3.1 campaign verified Codex CLI 0.155.1, gpt-6-sol, Windows and Node.js 24.11.1. Four [transport checks](../project/evidence/live-provider.json) passed, and the [natural-language graph trial](../project/evidence/live-functional.json) completed a generated four-node graph in eleven model calls through verified branch delivery, with two isolated workers, independent reviews, integration, final validation and an external oracle. Transport reuse proves unchanged source files, requests, dependency lock and environment; original dates and results are preserved. Windows sandbox sessions receive an exact-worktree, process-scoped Git trust setting without changing global Git configuration or sandbox permissions. Earlier comparison and failed trials remain in the [campaign review](../project/release-campaign-2026-09-05.md).

The 0.3.0 certificate named `gpt-5.6-luna` and the 0.3.0 catalog no longer offers that id, so it was archived under `docs/project/evidence/history` ([archived certificate](../project/evidence/history/live-provider-d2ad9eff2ebac61aa17eda5e027520b1a5d65829ed24e7078a85bef1c5f2446f.json)) rather than reused. Regenerate a certificate with `npm run provider:evidence -- --live --model <id>` whenever the offered model, CLI version or environment changes; support is never transferred to a different model id, CLI version or platform by analogy. Every other 0.3.1 candidate, including `gemini-3.8-flash` and the API transports, is protocol-tested only.

Earlier beta records for Codex CLI 0.153.1 and gpt-5.4-mini are preserved as [historical smoke evidence](evidence/codex-windows.json), including the [initial failed check](evidence/codex-windows-initial.json). They are not used to establish current model availability or stable support.

Claude Code 2.1.158 reported a saved login but the actual request returned an expired OAuth error. Its [report](evidence/claude-windows.json) marks the remaining model checks blocked. Gemini authentication was unknown. No API credential was available in the current environment; native API and DeepSeek/GLM evidence is protocol-level mock testing. Credentials and account identifiers are excluded from reports.

Run `node scripts/provider-conformance.mjs --help` for opt-in live checks. The published record lives in [release readiness](../project/v0.3-readiness.md). Mock fixtures prove protocol handling, not service availability or model quality.
