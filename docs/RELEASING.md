# Releasing Ralph 0.3.0

Repository owners may run the release workflow after its evidence gate passes. Consumer commands never publish, push or deploy.

## Evidence and package identity

CI builds one archive on Linux/Node 24, then installs those exact bytes on Windows/macOS/Linux with Node 22/24. Tests, coverage, operational interruption, browser and catalog reports retain source identities. CI artifacts and the final Release preserve the archive, reports, manifest and checksums.

Run npm run check:core locally and npm run check:release with the complete evidence directory. Never replace missing reports with booleans or reduce thresholds. A changed runtime, dependency or live harness invalidates related live evidence. A different final tree requires fresh CI.

## Bounded real verification

Use npm run test:live:release -- --dry-run before npm run test:live:release -- --live --model gpt-5.6-luna. Only Codex's existing subscription CLI is used. The generated-graph normal path is estimated at eight calls: three planning, two worker/review pairs, and final review. This estimate is not a quota or a completion guarantee. The owner removed the cumulative call-count cap; the shared 1,800,000-active-millisecond ceiling and no additional paid API connection remain. All calls, failures and cancellations continue to be recorded in .release/live-budget.json. At the policy change, its V2 migration archived the exact V1 bytes and preserved the then-consumed 17 attempts and 515,096 active milliseconds; later calls continue in the same ledger. Do not delete or reset this file to retry a release. A pending interrupted call blocks more spending until process inspection. The separate functional campaign also refuses implicit reruns of a retained outcome.

Passing conformance reports are reused only after exact request, adapter dependency, lockfile and environment checks. EvidenceReuseV2 separates release accounting from the provider protocol; accounting changes require deterministic count, time, cancellation and ownership tests. Old V1 certificates retain their original dependency scope and are never reinterpreted as V2. The original live report and date are preserved. The end-to-end harness digest still includes accounting code, so this change cannot reuse an old complete functional run.

The required live test supplies a natural-language request without an injected contract or graph. It approves only the generated plan with the exact two-file write scope and frozen behavioral verifiers. Each worker modifies one module in its own worktree; the independent external oracle runs after final delivery. The same provider reviews in fresh sessions, so independent assessment does not imply a different provider. The metered generic-process bridge uses the actual Codex adapter and keeps connection concurrency at one. Historical baseline comparisons remain references under the V2 manifest, not a performance claim. Provider metadata and README tables are generated with npm run support:sync -- docs/project/evidence/live-provider-current.json after its reuse proof verifies.

## Catalog signing

The Ed25519 private key stays outside the repository; only its public key and fingerprint are committed. The encrypted npm-release environment secret is RALPH_CATALOG_PRIVATE_KEY. The current release uses the committed, verified signature and does not expose the secret to PR jobs.

Sign catalog-v2.json and catalog-v2.sig with scripts/sign-catalog.mjs and an absolute RALPH_CATALOG_PRIVATE_KEY path. The script supports Windows and rejects keys inside the checkout. For deliberate bootstrap, scripts/bootstrap-catalog-v2.mjs --init-key reuses an existing private key. Never replace an established trust anchor silently.

Schema v2 uses keyId and checkedAt, a separate cache/channel, and null/unrated values where measured quality is absent. Original catalog.json and catalog.sig remain byte-preserved release assets for older clients. Their original expiry is not extended without their original key. Run npm run catalog:audit before release.

## GitHub and npm configuration

Configure the npm package's Trusted Publisher with repository worldclasscitizen/Ralph, workflow filename release.yml and environment npm-release. Enable direct publishing for that publisher; a staging-only publisher cannot complete this automated release. Node 24 and npm ≥11.5.1 are required. Only the publish job receives id-token: write. The environment admits main only and concurrent releases are serialized.

Initial npm account authentication or two-factor setup may require the owner. No long-lived npm token is stored in this repository. [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)

Require PRs and the six CI checks on main, without another person's review approval. Merge with a merge commit to retain logical commits. After successful main CI, dispatch release.yml with the exact source_sha and ci_run_id.

The workflow verifies that CI belongs to main and the selected commit, creates v0.3.0 and a draft Release, attaches all evidence, then publishes the validated tarball with public access and the explicit latest tag. It installs both the exact version and the default registry version, checks downloaded integrity, runs a mock graph and verifies the UI. Only then is the GitHub Release made public and Latest. Enable immutable releases before publication; drafts remain editable until their assets are complete. [Immutable Releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)

## Recovery of a publication

If npm returns an unclear response, query version and integrity before retrying. An identical existing archive continues verification; a different existing archive blocks the workflow. Never overwrite or unpublish 0.3.0 to repair code. Use a subsequent patch release. After npm succeeds, a failed GitHub step resumes from the draft; already public immutable assets are not replaced. [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
