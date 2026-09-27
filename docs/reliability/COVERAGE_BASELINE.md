# Coverage baseline

The v0.3 work first remeasured commit `e04b387fca1b10ae6668b6b6223fb8c8a530712a` with 31 passing tests: 46.98% statements and 54.82% branches. Those were baseline observations, not the current floor.

The enforced global floor is the measured 113-test result on the same commit, checked by `npm run check:release`: **lines ≥ 57.77% and branches ≥ 73.70%**, with the 46.98% statements and 52% functions thresholds retained in `vitest.config.ts`. `scripts/lib/release.mjs` is authoritative; this document only explains the numbers.

On the 0.3.1 tree the same command reports 61.36% lines (7,764/12,653), 75.24% branches (1,766/2,347), 61.36% statements and 76.79% functions across 69 measured files, from 151 passing tests.

The new scheduler, revision, supervisor, recovery, transition, journal/store and Git integration modules require **90% lines and branches** before stable release. `npm run check:release` evaluates the actual coverage summary. A passing global floor alone is insufficient.

Run `npm run test:coverage` to reproduce local measurements. Current evidence and remaining gates are in [release readiness](../project/v0.3-readiness.md). Never lower a threshold to label an incomplete release ready.
