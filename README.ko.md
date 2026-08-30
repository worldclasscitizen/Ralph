<p align="right">
  <a href="./README.md">English</a> | <strong>한국어</strong>
</p>

<div align="center">
  <h1>Ralph</h1>
  <p><strong>증거 중심의 플랫폼 중립 멀티 에이전트 소프트웨어 개발 오케스트레이션</strong></p>
  <p>
    하나의 자연어 요청을 승인 가능한 작업 계약으로 바꾸고, 역할마다 적합한 모델을 연결하며,
    모든 Iteration을 검증하고 Git으로 복구 가능하게 보존합니다.
  </p>
  <p>
    <a href="#빠른-시작"><strong>빠른 시작</strong></a> ·
    <a href="#ralph의-작동-방식">작동 방식</a> ·
    <a href="#주요-명령">명령</a> ·
    <a href="#ralph-control-center">대시보드</a> ·
    <a href="./docs/ARCHITECTURE.md">아키텍처</a>
  </p>
  <p>
    <img alt="릴리스" src="https://img.shields.io/badge/release-v0.1.0--beta.0-f59e0b?style=flat-square">
    <a href="https://github.com/worldclasscitizen/hackathon-hackthebeat/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/worldclasscitizen/hackathon-hackthebeat/ci.yml?branch=main&style=flat-square&label=CI"></a>
    <img alt="Node.js 22 이상" src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=flat-square&logo=nodedotjs&logoColor=white">
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white">
    <a href="./LICENSE"><img alt="MIT 라이선스" src="https://img.shields.io/badge/license-MIT-2563eb?style=flat-square"></a>
  </p>
</div>

> [!IMPORTANT]
> **베타 소스 상태:** `v0.1.0-beta.0`은 구현되어 로컬 검증을 통과했지만 아직 npm Registry에 게시되지 않았습니다. 지금은 소스에서 설치해야 하며, 아래 `@beta` 명령은 첫 npm 게시 이후 사용할 수 있습니다.

> 영어 [README.md](./README.md)가 기준 문서입니다. 번역과 내용이 다르면 영어 문서를 우선합니다.

## 왜 Ralph인가요?

일반적인 자율 코딩 루프는 하나의 모델을 반복 호출하고 다음 시도가 더 나아지기를 기대합니다. Ralph는 반복 과정을 명시적이고 관찰 가능하며 복구 가능한 구조로 만듭니다.

| 흔한 문제 | Ralph의 해결 방식 |
| :--- | :--- |
| 경량 모델이 암묵적으로 모든 고성능 모델을 지휘함 | 결정적인 TypeScript 상태 머신이 오케스트레이션하고 모델은 제한된 역할만 수행합니다. |
| 작업이 충분히 정리되기 전에 코드를 수정함 | `TaskContract`, 검증 계획, 모델 경로를 먼저 보여주고 명시적 승인을 받습니다. |
| 재시도가 같은 실수를 반복함 | Meta-Prompter가 Critic과 검증 실패 증거를 다음 제한된 지시로 변환합니다. |
| Worker가 자신의 결과를 스스로 통과시킴 | 결정적 검증기와 stateless Post-Critic이 평가하며 가능한 경우 다른 Provider를 선택합니다. |
| 루프 폭주 후 작업 트리를 되돌리기 어려움 | 완료·실패·중단된 모든 Iteration마다 로컬 Git checkpoint를 시도합니다. |
| 진행 상황이 LLM Context Window에만 남음 | 파일, 검증 결과, append-only 이벤트, Git history를 최종 진실의 원천으로 사용합니다. |
| 모델 폴백 체인을 직접 작성해야 함 | `ralph init`이 연결 상태와 서명된 카탈로그로 작업별 체인을 자동 계산합니다. |
| 터미널의 `running` 문구 외에는 알기 어려움 | Control Center에서 노드 상태, 증거, Git 변경, 사용량, 안전 중단을 실시간으로 확인합니다. |

## 차별점

- **코드보다 계약이 먼저:** 범위, 제외 항목, 완료 조건, 산출물, 검증 명령을 승인하기 전에는 쓰기 작업을 시작하지 않습니다.
- **신뢰보다 증거가 먼저:** Critic은 점수 앵커와 증거만 반환하며 총점과 Hard Gate는 로컬 엔진이 계산합니다.
- **후회보다 Git이 먼저:** Iteration checkpoint와 명시적 복구 절차로 자율 작업을 되돌릴 수 있습니다.
- **플랫폼 중립:** 일반 터미널, IDE Terminal, tmux, cmux, orca에서 동일하게 실행되며 Skill도 같은 CLI를 호출합니다.
- **멀티 Provider:** Codex, Claude Code, Antigravity, Gemini CLI 저장 로그인과 여러 API 연결을 함께 사용할 수 있습니다.
- **역할·작업별 라우팅:** 계약 작성, 비평, 메타 프롬프팅, 구현, 검증, 재심을 독립적으로 라우팅합니다.
- **제한된 API Worker 도구:** 프로젝트 파일과 Git 증거, 등록된 검증기는 사용할 수 있지만 임의 shell, push, 배포는 할 수 없습니다.
- **정직한 잔여량 표시:** 공식 구조화 인터페이스가 있을 때만 정확한 구독 잔여 퍼센트 또는 API 잔액을 표시합니다.

## 빠른 시작

### 요구사항

- Node.js 22 이상
- Git
- 변경 사항이 없는 Git 작업 트리
- 지원되는 CLI 로그인 또는 API 연결 한 개 이상

### npm 베타 게시 이후 설치

```bash
npm install -g @worldclasscitizen/ralph@beta
ralph --version
```

전역 설치 없이 한 번 실행할 수도 있습니다.

```bash
npx @worldclasscitizen/ralph@beta run --project /absolute/path/to/project "로그인 접근성을 개선하고 테스트까지 작성해줘"
```

### 현재 소스에서 설치

```bash
git clone https://github.com/worldclasscitizen/hackathon-hackthebeat.git
cd hackathon-hackthebeat
npm ci
npm run build
npm install -g .
ralph --version
```

개발 중에는 `npm link`도 사용할 수 있습니다.

### 프로젝트 초기화와 실행

```bash
cd /absolute/path/to/git-project
ralph init
ralph doctor
ralph run "로그인 접근성을 개선하고 테스트까지 작성해줘"
```

Ralph는 다음 순서로 진행합니다.

1. 사용 가능한 Provider와 인증 상태를 탐지합니다.
2. 별도 LLM 순위 호출 없이 작업·역할별 폴백 경로를 만듭니다.
3. 자연어 요청을 구조화된 작업 계약으로 작성합니다.
4. 범위, 제외 항목, 검증, 실행 프로필, 모델 경로를 보여줍니다.
5. 사용자의 명시적 승인을 기다립니다.
6. 승인 후에만 루프를 실행하고 평가합니다.

Git 저장소 밖에서는 임의 파일을 만들지 않으며 절대 경로를 요구합니다.

```bash
ralph run --project /absolute/path/to/project "캐시 계층을 리팩터링해줘"
```

## Ralph의 작동 방식

```text
자연어 요청
→ Contract Planner
→ 사용자 승인
→ Pre-Critic
→ Meta-Prompter
→ Worker
→ 결정적 Verifier
→ Post-Critic
→ 필요한 경우 경계 재심
→ 로컬 Git checkpoint
→ 통과 | 재시도 | 사용자 확인 필요 | 실패 | 중단
```

오퍼레이터는 Gemini Flash 같은 특정 모델이 아니라 TypeScript 상태 머신입니다. Meta-Prompter는 실패 증거를 다음 지시로 구체화할 수 있지만 승인된 계약 범위를 넓힐 수 없습니다. Meta-Prompter와 Worker는 정확한 Session ID로 이어갈 수 있고, Critic은 anchoring을 줄이기 위해 stateless로 실행됩니다.

### 평가와 종료

- 공통 루브릭 40점, 작업별 루브릭 60점
- 기본 통과선 85점
- 결정적 Verifier와 Post-Critic을 모두 통과해야 성공
- 80~90점 또는 Hard Gate가 불명확할 때만 독립 재심
- 최대 6회지만 첫 Iteration에서 통과하면 즉시 종료
- 동일 실패나 점수 정체가 반복되면 `needs_operator`로 전환

Critic은 항목별 앵커와 증거만 반환하고 Ralph가 총점과 Hard Gate를 계산합니다.

## 작업별 라우팅

| 작업 유형 | 최적화 대상 |
| :--- | :--- |
| `planning_architecture` | 요구사항, 트레이드오프, 경계, 아키텍처 결정 |
| `frontend_visual` | UI 구현, 시각 검증, 반응형, 접근성 |
| `backend_core` | API, 데이터 모델, 보안 경계, 핵심 비즈니스 로직 |
| `tdd_debugging` | 재현, 테스트, 원인 분리, 회귀 방지 |
| `static_review` | 린트, 타입, 보안, 유지보수성 검토 |
| `delivery_evidence` | 스크린샷, 기술 증거, 파급력 문서, 제출 준비 |

| 프로필 | 우선순위 | 권장 상황 |
| :--- | :--- | :--- |
| `balanced` | 적합성·신뢰성·Provider 다양성·비용/속도 | 기본값 |
| `quality` | 작업 적합성과 신뢰성 | 아키텍처, 위험한 변경, 최종 검토 |
| `fast` | 속도와 충분한 적합성 | 시간이 부족한 작업 |
| `budget` | 비용과 충분한 적합성 | 위험도가 낮고 양이 많은 작업 |

```bash
ralph config pipelines
ralph config explain --profile quality
ralph config preset fast
ralph run --model gpt-5.6-sol "인증 경계를 검토해줘"
```

## Provider와 인증

| 연결 | Adapter | 인증 |
| :--- | :--- | :--- |
| 내장 CLI | Codex, Claude Code, Antigravity, Gemini CLI | 해당 CLI의 저장 로그인을 재사용 |
| Native API | OpenAI, Anthropic, Google Gemini | OS 자격 증명 저장소 우선, 환경변수 대체 |
| 호환 API | DeepSeek, Z.AI, OpenAI-compatible | OS 자격 증명 저장소 또는 API Key 환경변수 |
| Custom process | Ralph JSON/NDJSON 계약을 구현한 임의 프로세스 | 프로세스 Adapter 설정에 따름 |

내장 로그인과 API Key는 별도 연결입니다. 예를 들어 `openai:codex-login`과 `openai:api`가 동시에 존재할 수 있습니다.

```bash
ralph providers detect
ralph auth status
ralph auth login openai:codex-login
printf '%s' "$DEEPSEEK_API_KEY" | ralph auth add deepseek:api --key-stdin
```

인증 오류, 정책 거부, 잘못된 요청은 다른 Provider로 몰래 우회하지 않습니다. Rate Limit, quota, timeout, 서버 오류, 빈 출력, schema 오류 같은 일시적 장애만 재시도와 폴백 대상입니다.

## 주요 명령

| 분류 | 명령 | 용도 |
| :--- | :--- | :--- |
| 실행 | `ralph init` | 프로젝트 등록, 연결 탐지, 기본 체인 생성 |
| 실행 | `ralph draft "<요청>"` | 실행 없이 계약만 작성 |
| 실행 | `ralph run "<요청>"` | 계약 작성, 승인, 루프 실행 |
| 실행 | `ralph status --watch` | 실행 상태 지속 확인 |
| 중단·복구 | `ralph stop [--force]` | 안전 중단 또는 강제 중단 |
| 중단·복구 | `ralph resume [run-id]` | 중단·실패 실행 재개 |
| 중단·복구 | `ralph recover [run-id]` | 부분 변경 유지·checkpoint·복구 선택 |
| 진단 | `ralph doctor [--fix|--offline|--json]` | Node, Git, 인증, 카탈로그, 라우팅 진단 |
| 설정 | `ralph config show|preset|pipelines|explain|export|import` | 라우팅 설정 관리 |
| 설정 | `ralph auth status|login|add|remove` | 로그인과 API 자격 증명 관리 |
| 설정 | `ralph catalog status|diff|update` | 서명된 모델 카탈로그 관리 |
| 관제 | `ralph dashboard --open` | Control Center 실행 |
| 관제 | `ralph logs --follow` | 안전한 이벤트 요약 스트리밍 |
| 관제 | `ralph usage` | Ralph 토큰 사용량 조회 |
| 관제 | `ralph capacity --refresh` | 공식 조회가 가능한 Provider 잔여량 조회 |
| 기록 | `ralph history list|delete|clear` | 종료된 로컬 실행 증거 관리 |
| 마이그레이션 | `ralph migrate [--cleanup]` | 기존 Bash 구조를 가져오고 선택적으로 정리 |

## 선택적 AI Skill

일반 터미널 명령이 기준입니다. Skill은 같은 `ralph` CLI를 호출하는 편의 계층이며 별도 루프 로직이 없습니다.

```bash
ralph integrations install
ralph integrations status
```

| 환경 | 호출 방식 |
| :--- | :--- |
| Codex | `$ralph 로그인 화면을 개선해줘` |
| Claude Code | `/ralph 로그인 화면을 개선해줘` |
| Antigravity | `/ralph 로그인 화면을 개선해줘` |
| Gemini CLI | Gemini CLI의 설치된 Ralph Skill 호출 방식 |
| 일반 Terminal·IDE Terminal·cmux·tmux·orca | `ralph run "로그인 화면을 개선해줘"` |

AI 채팅창에 `ralph run ...`만 입력하면 자연어로 취급될 수 있습니다. Skill을 설치하지 않았다면 실제 shell에서 실행합니다.

## Git 상태와 안전성

소비자 프로젝트 루트에 `.ralph`, `.antigravity`, `PROMPT.md`, 개인 JSON을 만들지 않습니다. 프로젝트 상태는 다음 Git 내부 경로에 저장합니다.

```bash
git rev-parse --git-path ralph
```

```text
ralph/
  config.json
  contracts/
  runs/
  sessions/
  progress.jsonl
  guardrails.md
  locks/
  dashboard/
```

- clean working tree에서만 실행을 시작합니다.
- 성공·실패·중단된 모든 Iteration 종료 시 로컬 commit을 시도합니다.
- 비밀 파일·비밀값·충돌이 감지되면 checkpoint를 차단합니다.
- 자동 push, 배포, rollback을 하지 않습니다.
- 첫 `Ctrl+C`는 안전 중단, 3초 안의 두 번째 입력은 강제 중단입니다.
- 부분 변경은 사용자 선택 없이 자동 삭제하지 않습니다.

## Ralph Control Center

```bash
ralph dashboard --open
```

대시보드는 `127.0.0.1`에만 열립니다. 기본적으로 현재 프로젝트만 보여주고 `--all`을 지정해야 이 컴퓨터에 등록된 다른 프로젝트도 함께 보여줍니다. 다른 팀원의 실행을 수집하지 않습니다.

- SSE 기반 실시간 노드 상태
- 비공개 사고과정을 노출하지 않는 판단·증거 요약
- Iteration 점수, 검증 결과, Git checkpoint 상태
- 색상으로 구분된 Git 변경과 추가·삭제 줄 수
- 모델, Provider, 추론 강도, 토큰 사용량
- 공식 구조화 조회가 가능한 Provider 잔여량
- 오퍼레이터 메모, 안전 중단, 실행 기록 편집
- 작은 화면에서도 작업 공간·브랜치·시작·종료 시각을 보존하는 반응형 UI

자세한 내용은 [Control Center 안내서](./docs/RALPH_CONTROL_CENTER.md)를 확인합니다.

## 개발과 1.0 조건

```bash
npm ci
npm run build
npm test
npm run smoke
```

`npm run smoke`는 실제 tarball을 만들어 빈 Git 저장소에 설치하고 실행 파일과 Git 내부 상태 초기화를 검증합니다.

현재는 `0.1.0-beta`입니다. TypeScript 런타임의 핵심 경로는 로컬 빌드·테스트·패키징·smoke 검증을 통과했지만, 다음 조건을 완료해야 `1.0.0`으로 승격합니다.

- macOS·Ubuntu·Windows, Node.js 22·24 원격 CI 통과
- 실제 Provider 로그인·API·폴백·중단·복구 통합 검증
- 기존 Bash 데이터 마이그레이션과 cleanup 검증
- 베타 사용자 피드백과 치명적 결함 해결
- 서명된 카탈로그의 GitHub Release 갱신 경로 검증
- `legacy/bash-template/` 제거

## 문서

| 문서 | 용도 |
| :--- | :--- |
| [시작 안내](./START_HERE.md) | 사용자와 AI 온보딩 |
| [도입 안내](./docs/ADOPTION.md) | 다른 프로젝트에 Ralph 적용 |
| [아키텍처](./docs/ARCHITECTURE.md) | 상태 머신, Session, 증거, 저장 구조 |
| [Provider](./docs/PROVIDERS.md) | Adapter, 인증, 모델, 잔여량 |
| [Control Center](./docs/RALPH_CONTROL_CENTER.md) | 대시보드와 로컬 기록 |
| [릴리스](./docs/RELEASING.md) | npm beta와 서명된 카탈로그 배포 |

## 라이선스

[MIT](./LICENSE)

Ralph는 Geoffrey Huntley가 대중화한 자율 반복 패턴을 기반으로 하며, 명시적 계약, 작업별 멀티 Provider 라우팅, 증거 기반 평가, 로컬 관제, Git 복구 구조를 추가했습니다.
