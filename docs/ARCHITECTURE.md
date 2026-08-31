# 아키텍처와 상태 머신

```text
Natural language
  → contractPlanner
  → Contract Critic (stateless; revise once when needed)
  → TaskContract + risk classification + route preview
  → TaskContract hash + explicit approval
  → Pre-Critic (stateless)
  → Online Router (bounded candidates)
  → EvidencePacket
  → Meta-Prompter (fresh evidence rehydration)
  → Worker (fresh by default; bounded continuation only when proven safe)
  → deterministic + risk-tier Verifier
  → Post-Critic (stateless, different Provider when possible)
  → boundary Adjudicator only when needed
  → local Git checkpoint
  → pass | retry | needs_operator | failed | interrupted
```

TypeScript 상태 머신이 오퍼레이터입니다. 특정 경량 모델이 고성능 Worker에게 임의 작업 지시를 만드는 구조가 아닙니다. Meta-Prompter 출력은 승인된 계약의 범위를 바꿀 수 없고 실패 증거를 다음 실행 지시로 구체화할 뿐입니다. Online Router 역시 로컬 정책이 승인한 후보 중 하나만 고를 수 있습니다.

Router, Critic, Reviewer, Adjudicator와 Meta-Prompter는 stateless입니다. Worker도 EvidencePacket에서 fresh context를 복원하는 것이 기본입니다. 같은 모델·같은 시도가 실제로 개선 중이고 Provider가 context-window 사용량을 구조적으로 제공하며 40% 이하일 때만 바로 인접한 한 번의 continuation을 허용합니다. 사용량을 알 수 없으면 fresh로 처리합니다.

각 Iteration의 EvidencePacket에는 계약·정책 hash, Git HEAD와 diff, 정확한 모델·effort·session 결정, verifier gate, Critic evidence, failure fingerprint, guardrails와 미해결 항목이 들어갑니다. `guardrails.jsonl`은 일반화 가능하고 증거가 있는 교훈의 구조화 원장이며 `guardrails.md`는 사람이 읽는 view입니다.

프로젝트 상태는 `git rev-parse --git-path ralph` 아래에 저장하므로 일반 저장소와 Git worktree에서 같은 규칙으로 동작합니다. append-only `progress.jsonl`, run별 `events.jsonl`, EvidencePacket이 관찰 원장이고 Git commit이 코드 복구 지점입니다.

라우팅 목적함수는 품질 → 시간 → 비용 순서입니다. Hard Pin은 항상 우선하며 사용할 수 없으면 조용히 대체하지 않습니다. T0~T3 위험도는 검증 강도를 결정하고, T3는 자동 검증에 성공해도 최종 사용자 확인 없이는 완료로 판정하지 않습니다.

카탈로그는 npm에 bootstrap을 포함하고 GitHub Releases의 Ed25519 서명된 JSON으로 갱신합니다. 사용자 prompt, code, log를 카탈로그 운영측에 보내지 않습니다. 승인 시점의 catalog version과 route를 run에 고정하므로 실행 중 원격 변경이 모델을 바꾸지 않습니다.
