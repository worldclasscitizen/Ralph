# Ralph 온보딩 내비게이션

이 문서는 새 사용자의 AI가 **이 파일 하나에서 시작해 설정, 검증, 작업 계약 작성, 사용자 승인, 첫 실행까지 안내**하도록 만든 내비게이션입니다.

## AI가 따라야 할 순서

1. 프로젝트 루트의 절대 경로와 현재 Git 상태를 확인합니다.
2. `README.md`, `.ralph/README.md`, `.antigravity/REASONING_GUIDE.md`를 읽습니다.
3. Bash 3.2+, Python 3.11+, Git, `jq`가 설치되어 있는지 확인합니다.
4. 개인 파일이 없으면 예제를 복사하되 기존 파일은 덮어쓰지 않습니다.
5. 사용자가 실제로 쓸 Provider, 로그인 방식, 모델, 비용·속도 선호를 묻습니다.
6. `.antigravity/config.local.json`에 활성 Provider, 모델, reasoning, 여섯 작업의 fallback chain을 작성합니다.
7. `.ralph/commands.local.sh`에 선택한 모델 alias별 실제 실행 명령만 연결합니다.
8. 직접 API를 쓰는 Provider만 `.env`의 키를 사용자가 직접 채우도록 안내합니다.
9. 프로젝트의 실제 test·lint·typecheck·build 명령이 `.ralph/verify-project.sh`에서 실행되는지 확인합니다.
10. `.ralph/resolve-config.sh --check`, `.ralph/ralph-loop.sh --check`, `.ralph/verify-project.sh`를 실행합니다.
11. 외부 모델을 호출하는 `.ralph/ralph-loop.sh --smoke`는 비용이 생길 수 있음을 알리고 사용자 승인 후 실행합니다.
12. 대화로 작업 범위를 정리한 뒤 `.ralph/PROMPT.md` 전체를 대신 작성합니다.
13. 목표, 범위, 금지사항, 완료 증거, 검증 명령을 사용자에게 요약하고 실행 승인을 기다립니다.
14. 변경을 기준 커밋으로 저장한 뒤 선택한 task ID로 Ralph Loop를 실행합니다.
15. 별도 터미널에서 로컬 대시보드를 열고 결과와 개입 방법을 안내합니다.

## 사용자가 직접 만들거나 채울 파일

| 파일 | 만드는 방법 | 넣을 값 |
|---|---|---|
| `.antigravity/config.local.json` | `config.local.json.example` 복사 | 실제 Provider·모델·reasoning·task별 chain |
| `.ralph/commands.local.sh` | `commands.local.sh.example` 복사 | 각 alias를 호출할 CLI/API wrapper 명령 |
| `.env` | `.env.example` 복사 | 직접 API를 쓸 때만 비밀 키 |
| `.ralph/OPERATOR_NOTE.local.md` | 필요할 때 example 복사 또는 대시보드에서 저장 | 다음 단계에 적용할 임시 개입 지시 |

위 네 파일은 Git에서 제외됩니다. API 키를 JSON, Markdown, shell 명령 문자열 또는 커밋에 넣지 않습니다.

## 로그인 방식

- Gemini builtin은 Antigravity IDE/CLI의 로그인 상태를 사용합니다.
- Claude builtin은 Claude Code의 저장된 Claude.ai 로그인을 사용합니다.
- Codex builtin은 Codex CLI의 저장된 로그인을 사용합니다.
- DeepSeek와 GLM General API는 `.env`의 API 키를 사용합니다.
- builtin 로그인과 API 키가 모두 있을 때 어떤 인증이 우선하는지는 각 wrapper가 격리합니다. Claude builtin wrapper는 Anthropic API 환경변수를 제거한 뒤 저장 로그인을 사용합니다.

로그인이나 키가 없으면 `--check`는 구조만 검사하고, `--smoke` 또는 실제 run의 첫 해당 모델 호출에서 구조화된 인증 오류로 중단합니다. 인증 오류는 다른 Provider로 몰래 우회하지 않으므로 사용자가 로그인 또는 키 등록 여부를 결정합니다.

## 작업 계약을 만드는 법

사용자는 Markdown 문법을 직접 알 필요가 없습니다. AI에게 자연어로 다음 내용을 말합니다.

- 무엇을 만들거나 고칠지
- 반드시 지킬 범위와 건드리면 안 되는 범위
- 확인 가능한 완료 기준
- 시간·비용·모델 무게 제한
- 필요한 테스트·캡처·문서

AI는 이를 `.ralph/PROMPT.md` 템플릿에 맞게 바꿉니다. 사용자가 “가벼운 모델 우선”을 요청하면 AI는 개인 `taskPipelines`의 alias와 reasoning 값을 확인해 해당 run의 순서를 제안할 수 있지만, 존재하지 않는 모델을 만들거나 공유 `config.json`을 개인 취향으로 바꾸면 안 됩니다. 최종 모델 순서는 `.antigravity/config.local.json`이 결정합니다.

## 실행 전 검사

```bash
.ralph/resolve-config.sh --check
.ralph/ralph-loop.sh --check
.ralph/verify-project.sh
git status --short
```

`git status --short`가 비어 있어야 실제 loop를 시작할 수 있습니다. 초기 설정과 승인된 `PROMPT.md`를 먼저 커밋합니다.

```bash
.ralph/ralph-loop.sh --task planning_architecture
.ralph/ralph-loop.sh --task frontend_visual
.ralph/ralph-loop.sh --task backend_core
.ralph/ralph-loop.sh --task tdd_debugging
.ralph/ralph-loop.sh --task static_review
.ralph/ralph-loop.sh --task delivery_evidence
```

한 run에는 위 태스크 중 하나와 하나의 작업 계약만 사용합니다. 기본 최대 6회는 고정 반복 횟수가 아니라 상한이며, 첫 반복에서 통과해도 즉시 종료합니다.

## 실행 중 확인과 개입

```bash
.ralph/ralph-dashboard.sh --open
```

- 대시보드에서 현재 노드, 증거, 점수, fallback, token 사용량, Git checkpoint를 확인합니다.
- 다음 단계에 지시를 추가하려면 오퍼레이터 메모를 저장합니다.
- 현재 모델 호출을 즉시 멈추려면 loop 터미널에서 `Ctrl+C`를 누릅니다.
- 목표 자체를 바꾸려면 중단하고 AI와 새 `PROMPT.md`를 합의한 뒤 다시 실행합니다.

## 완료의 의미

Ralph는 Worker와 결정적 Verifier가 성공하고, Post-Critic이 Hard Gate를 통과하며, 로컬 엔진 점수가 기준 이상일 때 끝납니다. 각 이터레이션은 로컬 Git checkpoint로 남지만 자동으로 원격에 push하거나 배포하지 않습니다. 최종 결과는 코드·문서·테스트, `.ralph/progress.txt`, 로컬 `runs/`, Git history에서 확인합니다.
