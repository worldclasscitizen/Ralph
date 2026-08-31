# Coverage baseline

The first enforced V8 baseline was measured on 2026-08-31 after introducing quality-first routing, EvidencePackets, risk-tier verification, and the benchmark harness.

| Metric | Measured | Enforced floor | v0.3 target | v1 target |
|---|---:|---:|---:|---:|
| Statements | 46.72% | 46% | 80% | 90% |
| Lines | 46.72% | 46% | 80% | 90% |
| Branches | 53.86% | 53% | 70% | 85% |
| Functions | 52.81% | 52% | 80% | 90% |

The floor records current truth; it is not the quality target. CI must never lower these values to make a change pass. New tests raise the floor toward the published targets, with critical contract, router, evaluator, Git safety, path safety, and invariant branches ultimately requiring complete coverage.

Run the same measurement locally:

```bash
npm run test:coverage
```
