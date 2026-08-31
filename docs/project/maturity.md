# Capability maturity

This matrix distinguishes implemented behavior from beta constraints and future work.

| Capability | State | Current evidence or limit |
|---|---|---|
| Contract hash and explicit approval | Implemented | Unit and orchestration tests; no Worker call before approval |
| Retry, fallback, and per-role circuit breaker | Implemented | Structured retryable errors, bounded retry, node-scoped isolation |
| Quality-first Online Router | Beta | Candidate validation, policy hash, deterministic fallback, Hard Pin tests; broader live-provider calibration remains |
| EvidencePacket and structured guardrails | Beta | Per-iteration persisted packets; Provider context telemetry is not universally available |
| Independent Post-Critic | Implemented with degradation notice | Different Provider is preferred; single-Provider installations are clearly marked degraded |
| Risk-tier verifier | Beta | Contract drift, test tampering, coverage ratchet, frozen invariants, clean worktree, and conditional mutation bite |
| 24-case live benchmark harness | Beta | Suite and local statistics ship; public reproducible baseline results are not yet published |
| Coverage enforcement | Baseline ratchet | Current honest floor is documented; v0.3 and v1 targets are not yet reached |
| Provider capacity | Provider-dependent | Exact values only when an official structured interface exists |
| Parallel feature loops and agent waves | Planned separately | Not part of the current milestone or runtime |
| Stable v1 compatibility | Not yet | Schemas and command behavior may evolve during beta |

Ralph does not claim superiority from architecture alone. A route or release is better only when hidden deterministic checks and independent review improve qualified success without an unacceptable time or cost regression.
