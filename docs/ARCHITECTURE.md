# 아키텍처와 상태 머신

```text
Natural language
  → contractPlanner
  → TaskContract hash + explicit approval
  → Pre-Critic (stateless)
  → Meta-Prompter (exact session)
  → Worker (exact session)
  → deterministic Verifier
  → Post-Critic (stateless, different Provider when possible)
  → boundary Adjudicator only when needed
  → local Git checkpoint
  → pass | retry | needs_operator | failed | interrupted
```

TypeScript 상태 머신이 오퍼레이터입니다. 특정 경량 모델이 고성능 Worker에게 임의 작업 지시를 만드는 구조가 아닙니다. Meta-Prompter 출력은 승인된 계약의 범위를 바꿀 수 없고 실패 증거를 다음 실행 지시로 구체화할 뿐입니다.

Meta-Prompter와 Worker session은 `run + task + node + connection + model`로 격리하고 12 turn에 회전합니다. Codex, Claude Code, Antigravity, Gemini CLI와 OpenAI Responses처럼 정확한 ID 재개를 제공하는 연결은 그 ID만 사용합니다. 서버 session ID가 없는 Chat Completions 계열은 세션을 가장하지 않고 매 호출마다 파일·Git·verifier 증거에서 복원합니다. Critic은 이전 점수에 anchoring되지 않도록 항상 stateless이며 fallback 모델도 새 session에서 같은 증거를 받습니다.

프로젝트 상태는 `git rev-parse --git-path ralph` 아래에 저장하므로 일반 저장소와 Git worktree에서 같은 규칙으로 동작합니다. append-only `progress.jsonl`과 run별 `events.jsonl`이 관찰 원장이고 Git commit이 코드 복구 지점입니다.

카탈로그는 npm에 bootstrap을 포함하고 GitHub Releases의 Ed25519 서명된 JSON으로 갱신합니다. 사용자 prompt, code, log를 카탈로그 운영측에 보내지 않습니다. 승인 시점의 catalog version과 route를 run에 고정하므로 실행 중 원격 변경이 모델을 바꾸지 않습니다.
