# Ralph Orchestration Template

메타 프롬프트로 실패 원인을 반영하고 Ralph Loop로 결과를 반복 개선하며, 작업별 최적 AI를 역할에 따라 연결하는 재사용 가능한 멀티 에이전트 오케스트레이션 템플릿입니다.

이 저장소에는 특정 제품 코드, 기획서, 고객 데이터, 실행 이력이 없습니다. 새 프로젝트의 기반으로 fork하거나 기존 Git 저장소에 안전하게 설치할 수 있습니다.

## 핵심 구성

- Critic → Meta-Prompter → Worker → Verifier → Post-Critic → Git checkpoint 파이프라인
- 작업별 모델 체인과 rate-limit·timeout·빈 응답 자동 fallback
- 로그인형 Gemini·Claude·Codex 및 API형 DeepSeek·GLM 어댑터
- 파일·검증 결과·Git 커밋을 최종 진실의 원천으로 사용하는 복구 가능한 실행
- 점수 앵커와 Hard Gate가 있는 결정적 Critic 엔진
- 로컬 실행 상태, 증거, Git 변경, 모델별 token 사용량을 보여주는 대시보드

## 빠른 시작

```bash
cp .antigravity/config.local.json.example .antigravity/config.local.json
cp .ralph/commands.local.sh.example .ralph/commands.local.sh
cp .env.example .env
chmod +x .ralph/*.sh .ralph/*.py
.ralph/verify-project.sh
```

그 다음 AI에게 다음과 같이 요청합니다.

> `START_HERE.md`를 읽고 제 환경에 맞는 Ralph 설정을 순서대로 안내한 뒤, 제가 설명하는 작업을 `.ralph/PROMPT.md`의 실행 계약으로 작성해 주세요. 실행 전에는 반드시 제 승인을 기다려 주세요.

승인 후 실행합니다.

```bash
git add . && git commit -m "chore: initialize project baseline"
.ralph/ralph-loop.sh --task backend_core
```

대시보드는 별도 터미널에서 실행합니다.

```bash
.ralph/ralph-dashboard.sh --open
```

기본 주소는 `http://127.0.0.1:7331`입니다.

## 기존 프로젝트에 설치

이 저장소를 별도로 clone한 뒤 다음 명령을 사용합니다. 대상에 같은 제어 파일이 있으면 덮어쓰지 않고 중단합니다.

```bash
./scripts/install.sh /absolute/path/to/your-project
```

자세한 선택 기준과 충돌 처리 방법은 `docs/ADOPTION.md`를 읽습니다.

## 문서 지도

| 파일 | 용도 |
|---|---|
| `START_HERE.md` | 사람과 AI가 함께 수행하는 온보딩 내비게이션 |
| `.antigravity/REASONING_GUIDE.md` | 공급자·모델·reasoning 설정과 작업별 라우팅 참고 |
| `.antigravity/config.json` | 공유 가능한 Provider·모델·정책 catalog |
| `.antigravity/config.local.json.example` | 개인 모델 선택과 fallback chain 예시 |
| `.ralph/README.md` | 루프 상태, 종료 조건, 안전 경계의 상세 계약 |
| `.ralph/PROMPT.md` | 현재 단일 작업의 범위·증거·완료 조건 템플릿 |
| `docs/RALPH_CONTROL_CENTER.md` | 로컬 대시보드 사용법 |
| `docs/ADOPTION.md` | fork 및 기존 프로젝트 도입 방법 |

## 안전 원칙

- `.env`, 개인 설정, 개인 명령, 실행 로그는 Git에 올리지 않습니다.
- Worker는 `.ralph/**`, `.antigravity/**`, `.git/**` 같은 제어면을 수정할 수 없습니다.
- 루프는 각 이터레이션을 로컬 커밋하지만 자동 push·배포는 하지 않습니다.
- 실행은 깨끗한 working tree에서만 시작합니다.
- 한 번의 run에는 하나의 명확한 작업 계약만 둡니다.

## 라이선스

MIT License입니다. 프로젝트 요구에 맞게 fork하고 수정할 수 있습니다.
