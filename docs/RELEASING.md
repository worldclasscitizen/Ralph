# Releasing Ralph 0.3.0

Repository owners may run the release workflow after its evidence gate passes. Consumer commands never publish, push or deploy.

## Evidence and package identity

CI builds one archive on Linux/Node 24, then installs those exact bytes on Windows/macOS/Linux with Node 22/24. Tests, coverage, operational interruption, browser and catalog reports retain source identities. CI artifacts and the final Release preserve the archive, reports, manifest and checksums.

Run npm run check:core locally and npm run check:release with the complete evidence directory. Never replace missing reports with booleans or reduce thresholds. A changed runtime, dependency or live harness invalidates related live evidence. A different final tree requires fresh CI.

## Bounded real verification

Use npm run test:live:release -- --dry-run before npm run test:live:release -- --live --model gpt-5.6-luna. Only Codex's existing subscription CLI is used by the release campaign. Conformance consumes at most four initial calls; two baseline and two candidate runs nominally consume 18 more. All retries share .release/live-budget.json: maximum 24 calls and 1,800,000 active milliseconds. Do not delete or reset this file to retry a release. A pending interrupted call blocks more spending until process inspection.

The baseline is frozen at e04b387fca1b10ae6668b6b6223fb8c8a530712a. Both versions use the same fresh-session CLI bridge, model and task. The graph fixture explicitly defines two workers to measure execution/integration without planning variability. A hidden deterministic oracle runs outside both workspaces. Two paired trials cannot establish general speed, cost or quality superiority. Provider metadata and README tables are generated with npm run support:sync -- docs/project/evidence/live-provider.json.

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
