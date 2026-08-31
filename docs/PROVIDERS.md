# Provider 연결과 정확한 사용 가능량

## 서명 bootstrap 카탈로그

아래 ID만 현재 `0.2.0-beta`의 자동 경로 후보입니다. 카탈로그는 출시 후 GitHub Releases의 서명된 JSON으로 갱신되며, 출시일로부터 6개월이 지난 모델은 자동 후보에서 제외됩니다.

| Provider·연결 | 공식 Model ID | 기본 effort | 용도 |
|---|---|---|---|
| OpenAI Codex | `gpt-5.6-sol` | `xhigh` | 최고 난도 코딩·추론 |
| OpenAI Codex | `gpt-5.6-terra` | `max` | 균형형 코딩 |
| OpenAI Codex | `gpt-5.6-luna` | `low` | 빠른 반복 |
| Anthropic | `claude-fable-5` | `max` | 최고 성능 장기 에이전트 |
| Anthropic | `claude-opus-5` | `max` | 복잡한 agentic coding·리뷰 |
| Anthropic | `claude-sonnet-5` | `high` | 속도·지능 균형 |
| Google Antigravity | `gemini-3.7-flash-high` | `high` | Antigravity가 노출하는 high 변형 |
| Google Gemini CLI/API | `gemini-3.7-flash` | `high` | 멀티모달·빠른 검증 |
| DeepSeek API | `deepseek-v4-pro` | `max` | 코딩·추론 API Worker |
| Z.AI General/Coding Plan | `glm-5.3` | `max` | 장기 코딩·에이전트 작업 |

Anthropic 최신 공개 라인업과 effort는 [Claude Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)와 [Effort](https://platform.claude.com/docs/en/build-with-claude/effort), Gemini는 [Gemini 3.7 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash), DeepSeek는 [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)과 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/), GLM은 [GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3)을 근거로 합니다. Antigravity 전용 ID는 설치된 `agy models` 목록과 교차 확인합니다.

## 연결 경계

| Adapter | 인증 | 실행 방식 | 잔여량·잔액 |
|---|---|---|---|
| `codex-builtin` | Codex 저장 로그인 | `codex exec`; 정책이 허용할 때만 exact session resume | Codex App Server 구조화 rate limit |
| `claude-code-builtin` | Claude.ai 저장 로그인 | `claude --print`; 정책이 허용할 때만 exact session resume | 정확한 자동 조회 미지원 |
| `antigravity-builtin` | Antigravity 저장 로그인 | `agy`; 정책이 허용할 때만 exact conversation resume | `/usage`에서 직접 확인, TUI 스크래핑 금지 |
| `gemini-cli-builtin` | Gemini CLI 저장 로그인 | headless JSON; 정책이 허용할 때만 exact session resume | 정확한 자동 조회 미지원 |
| `openai-api` | OS 저장소 또는 `OPENAI_API_KEY` | Responses API + 제한 도구 | 공식 잔액 API 없으면 조회 불가 |
| `anthropic-api` | OS 저장소 또는 `ANTHROPIC_API_KEY` | Messages API + 제한 도구 | 공식 잔액 API 없으면 조회 불가 |
| `gemini-api` | OS 저장소 또는 `GEMINI_API_KEY` | generateContent + 제한 도구 | 공식 잔액 API 없으면 조회 불가 |
| `deepseek-api` | OS 저장소 또는 `DEEPSEEK_API_KEY` | OpenAI 호환 tool call | 공식 `/user/balance` |
| `zai-general-api` | OS 저장소 또는 `GLM_GENERAL_API_KEY` | OpenAI 호환 tool call | 공식 잔액 API 없으면 조회 불가 |
| `zai-coding-plan` | OS 저장소 또는 `GLM_API_KEY` | Coding Plan 연결 | 공식 잔액 API 없으면 조회 불가 |
| `openai-compatible` | 연결별 환경변수 | OpenAI 호환 tool call | adapter가 제공할 때만 |
| `generic-process` | 외부 프로세스 책임 | JSON stdin → JSON/NDJSON stdout | 외부 adapter가 제공할 때만 |

API Worker 도구는 파일 목록, 텍스트 검색, 파일 읽기, SHA 기반 원자 편집·작성·삭제, Git status·diff와 등록 verifier만 제공합니다. 임의 shell, 네트워크, commit, push, 배포 또는 Ralph 상태 변경은 제공하지 않습니다.

## 인증 우선순위

1. 연결 ID에 저장된 OS 자격 증명 저장소
2. 연결의 `apiKeyEnv` 환경변수

builtin 로그인과 API key는 별도 연결이므로 동시에 있어도 섞이지 않습니다. Claude builtin 실행에서는 Anthropic API override 환경변수를 제거합니다.

`ralph init`은 목록 조회가 가능한 연결에서 실제 모델 목록도 확인합니다. Codex는 App Server `model/list`, Antigravity는 `agy models`, OpenAI 호환 API는 `GET /models`, Anthropic API는 `GET /v1/models`, Gemini API는 `GET /models`를 최대 3초 안에서 확인합니다. 목록 API가 없는 CLI는 서명 카탈로그를 사용하고 첫 실제 호출에서 접근 권한을 최종 확인합니다.

## 폴백 오류

같은 모델을 최대 2회 시도한 뒤 다음 모델로 전환합니다.

- 자동 재시도·폴백: 429, quota, timeout, 5xx, overloaded, 빈 응답, JSON schema 불일치
- 즉시 사용자 확인: 인증, 정책 거부, 잘못된 요청
- 자동 우회 금지: 알 수 없는 오류

재시도는 2초에서 최대 8초 사이의 jitter 지수 backoff를 사용합니다. 실패한 모델은 현재 run에서 격리합니다.

Circuit breaker는 `role + connection + model` 단위입니다. Router 실패가 같은 모델의 Worker나 Critic까지 잘못 격리하지 않습니다. Worker는 EvidencePacket에서 fresh context를 복원하는 것이 기본이고, 구조화된 context 사용량이 없으면 저장 session이 존재해도 자동 resume하지 않습니다.

## Generic process 계약

stdin에는 한 줄의 `AgentRequest` JSON을 전달합니다. stdout 마지막 JSON 또는 NDJSON result는 `AgentResult`여야 합니다. stderr에는 비밀값 없는 구조화 진단을 씁니다.

- exit 0: 성공
- exit 75: 재시도 가능한 일시 오류
- exit 77: 로그인·사용자 조치 필요
- 그 외: stderr와 상태를 분류하되 알 수 없는 오류는 자동 우회하지 않음
