# Risk-based verification

Ralph uses four verification tiers:

| Tier | Typical work | Required behavior |
|---|---|---|
| T0 | Documentation and low-risk planning | Artifacts, target checks, contract drift, independent review |
| T1 | Normal code changes | T0 plus project tests, lint, type checks, build, and coverage ratchet when configured |
| T2 | Public API, schema, large refactor | T1 plus isolated worktree re-verification and conditional mutation bite |
| T3 | Authentication, payment, permissions, migration, deletion, secrets | T2 plus mandatory final operator confirmation |

Strong gates are local policy, not a model's opinion:

- **Independent Reviewer:** the Post-Critic is stateless and prefers a provider different from the Worker.
- **Mutation bite:** when implementation and tests changed together, Ralph removes one implementation change in a disposable worktree and expects the tests to fail.
- **Coverage ratchet:** once a baseline exists, line, branch, and function coverage cannot decrease or disappear.
- **Frozen invariant:** registered API, schema, or policy files require an explicit `allow-frozen:<path>` contract constraint.
- **Test tampering:** newly introduced skips, focused-only tests, disabled checks, and threshold neutralization block the run.
- **Contract drift:** changes under the approved `exclude` patterns block the run.

Mutation bite is intentionally conditional. Applying it to unrelated changes would create false failures and waste time without increasing confidence.

```bash
# After a coverage run creates coverage/coverage-summary.json
ralph config coverage capture
ralph config coverage show

# Register API, schema, policy, or golden files that require explicit approval
ralph config invariant add openapi.yaml
ralph config invariant list
```

An approved contract may authorize one frozen change with `allow-frozen:<path>`. Ralph records that exception in the contract hash instead of treating it as an invisible bypass.
