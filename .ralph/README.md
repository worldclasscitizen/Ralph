# Ralph Meta-Optimization Loop

이 디렉터리는 같은 프롬프트를 무작정 재시도하는 스크립트가 아니다. 매 반복마다 실패 증거를 Critic이 판정하고, Meta-Prompter가 다음 Worker 지시문을 다시 설계한다.

```text
현재 상태 평가
  → Critic JSON (transient 장애 시 자동 fallback)
  → Meta-Prompter가 PROMPT.md 전체 재작성 (자동 fallback)
  → Worker가 구현 (taskPipelines 기반 자동 fallback)
  → 테스트·린트·타입 검사
  → 사후 Critic이 작업별 항목·증거 수준 반환
  → 로컬 채점 엔진이 점수와 pass/retry/needs_operator 계산
  → 통과선 ±5점 또는 미확인 Hard Gate일 때만 다른 Critic이 경계 재심
  → progress에 결과·중간 실패 원인 기록
  → guardrails에 일반화된 재발 방지 교훈 누적
  → 이터레이션 Git checkpoint 강제 커밋
  → 통과 또는 다음 반복

각 단계는 best-effort 관찰 이벤트도 `runs/<run-id>/events.jsonl`에 남긴다. 이 이벤트는 로컬 Control Center가 읽을 뿐이며 기록 실패가 루프의 판단이나 종료 코드를 바꾸지 않는다.
```

## 파일이 존재하는 이유

| 파일 | 역할 | 사람이 주로 수정하는 시점 |
|---|---|---|
| `ralph-loop.sh` | 단계 실행, 로그 보존, 종료 조건 판정 | 루프 정책을 바꿀 때 |
| `resolve-config.sh` | 공용 catalog에 대해 개인 Provider·모델·Reasoning·폴백 참조 검증 | 설정 구조나 검증 규칙을 바꿀 때 |
| `git-checkpoint.sh` | 깨끗한 시작점 검사, 민감 파일 차단, 이터레이션별 로컬 커밋 | checkpoint 안전 정책을 바꿀 때 |
| `observability.sh` | 단계·모델 시도·폴백·검증·판정을 비차단 JSONL 이벤트로 기록 | 대시보드에 새 이벤트를 추가할 때 |
| `ralph-dashboard.sh`·`dashboard/` | 로컬 실행을 작업 보드·단계·증거 스트림으로 표시 | 평소에는 실행만 하고 코드는 수정하지 않음 |
| `record-usage.py`·`tool_harness/usage.py` | 공급자 응답의 실제 token usage를 호출 단위 공통 형식으로 기록 | 모델 어댑터의 usage 규격을 추가할 때 |
| `PROMPT.md` | Worker에게 전달되는 현재 작업 계약 | 새 기능 시작 전; 이후 Meta가 진화시킴 |
| `META_PROMPT.md` | 실패를 다음 프롬프트로 변환하는 규칙 | 메타 최적화 품질을 바꿀 때 |
| `CRITIC_RUBRIC.md` | Critic의 항목·증거 출력 계약과 4단계 점수 앵커 | 평가 출력 규격을 바꿀 때 |
| `rubrics/base.json`·`rubrics/<task-id>.json` | 공통 40점과 6대 작업별 60점 기준·Hard Gate | 작업별 완료 증거와 배점을 바꿀 때 |
| `critic_engine.py` | 항목 점수 합산, Hard Gate, 3상태 판정, 반복 정체 차단 | 결정적 채점·종료 정책을 바꿀 때 |
| `critic_calibration.py`·`evals/critic/` | 6대 task의 명확 통과·경계·실패·환경 차단 24개 고정 sample 점검 | threshold·앵커·경계 폭을 바꿀 때 |
| `guardrails.md` | 금지사항과 재발 방지 교훈 | 공통 규칙 추가 또는 잘못된 자동 교훈 정리 |
| `progress.txt` | run·iteration별 결과와 중간 실패의 분류·원인·대응·증거 경로 | Ralph가 자동 append; 사람이 사실과 다른 기록만 교정 |
| `commands.local.sh` | 모델 alias·역할별 실행 명령 레지스트리 | 사용자가 자기 AI 도구를 연결할 때 |
| `OPERATOR_NOTE.local.md` | 실행 중 다음 AI 단계에 전달할 사람의 개입 지시 | 우선순위·금지사항·새 증거를 중간에 추가할 때 |
| `api-text-agent.sh` | DeepSeek·GLM 일반 API를 텍스트 Critic/Meta로 호출 | API형 모델을 역할 명령에 연결할 때 |
| `antigravity-agent.sh` | Antigravity CLI의 Gemini를 Ralph stdin/stdout 계약으로 변환 | Antigravity 내장 로그인을 자동 루프에 연결할 때 |
| `claude-builtin-agent.sh` | Anthropic API override를 제거하고 Claude.ai 저장 로그인으로 Claude Code 실행 | Claude builtin Critic/Meta/Worker 연결 시 |
| `codex-builtin-agent.sh` | Codex 저장 로그인으로 실행하고 JSON 이벤트에서 최종 응답·token usage를 분리 | Codex builtin Critic/Meta/Worker 연결 시 |
| `tool-agent.py`·`tool_harness/` | DeepSeek·GLM의 tool call을 저장소 sandbox 도구로 실행 | API형 모델을 실제 Worker로 연결할 때 |
| `verify-project.sh` | JSON·Bash와 존재하는 앱 test/lint/typecheck/build를 검사 | 기본 verifier; 앱 스크립트가 생기면 자동 실행 |
| `test-fallback-router.sh` | 가짜 429 자동 전환, Gemini quota 소진 자동 전환, 401 인증 오류 비우회를 검증. 개인 설정 대신 `tests/fallback-config.local.json`을 `RALPH_LOCAL_CONFIG`로 주입해 사용자 모델 조합과 무관하게 돈다 | fallback router 변경 시 |
| `test-antigravity-agent.sh` | 가짜 `agy`로 quota 오류·빈 SUCCESS 응답을 구조화된 실패로 내보내고 실제 본문만 성공 처리하는지 검증 | Antigravity 래퍼 변경 시 |
| `tests/fallback-config.local.json` | fallback 테스트 전용 개인 설정. `tests/fallback-commands.sh`의 가짜 alias와 짝을 이룬다 | fallback 테스트 시나리오를 바꿀 때 |
| `test-git-checkpoints.sh` | clean baseline, empty checkpoint, 민감 파일 차단을 임시 Git 저장소에서 검증 | Git checkpoint 변경 시 |
| `test-antigravity-sessions.sh` | AGY exact session 재개, node 격리, 만료 복구, 절대 경로를 검증 | AGY adapter나 session 정책 변경 시 |
| `runs/` | 반복별 프롬프트, 로그, 판정, checkpoint, session 증거 | 자동 생성; Git 제외 |

`ralph-loop.sh`와 `resolve-config.sh`는 `RALPH_TEAM_CONFIG`·`RALPH_LOCAL_CONFIG` 환경변수로 설정 파일 경로를 바꿀 수 있다. 테스트와 임시 실험용이며 평소에는 비워 둔다.

## 왜 모델을 스크립트에 고정하지 않는가

사용자마다 접근 가능한 모델이 다르기 때문이다. 공유 `config.json`은 허용 가능한 Provider·모델 ID·Reasoning·태스크·재시도 규격만 정의한다. `config.local.json`은 실제 Provider 연결, 선택 모델, 추론 강도, Worker의 6대 작업별 순서와 Critic·Meta의 `fallbackChains`를 기록한다. `commands.local.sh`의 `ralph_command_for(role, alias, mode)`가 실제 CLI/API 명령을 반환한다.

`resolve-config.sh`는 개인 선택이 공용 catalog에 존재하는지, Provider mode와 reasoning 값이 허용되는지, 모든 chain이 선택 모델만 참조하는지 검사한다. Ralph는 Critic·Meta에서 `fallbackChains`, Worker에서 선택 task의 `taskPipelines`를 순서대로 읽고, 명령 레지스트리에 해당 역할용 명령이 없는 alias는 증거를 남긴 뒤 건너뛴다.

`YOUR_CRITIC_AGENT_COMMAND` 같은 이전 자리표시자와 역할별 단일 명령 변수는 더 이상 사용하지 않는다. 현재 예제는 Gemini·Claude의 모델 alias별 Critic/Meta/Worker 명령을 함수 case로 제공한다.

## 런타임 fallback 규칙

1. 명령이 `429`, quota 소진(Antigravity의 `Individual quota reached` 포함), timeout, `500/502/503/504`, overloaded 등으로 실패하면 `rate_limit`, `timeout`, `server_error`로 분류한다. `agy`가 종료 코드 0과 `SUCCESS`를 반환해도 최종 본문이 공백이면 `antigravity-agent.sh`가 `empty_response` 실패로 바꾼다. 두 종류 모두 stderr의 `RALPH_AGENT_ERROR`로 Ralph 분류기에 전달한다.
2. 한 모델을 최대 2회 시도하며 첫 재시도 전 2초부터 최대 8초까지 지수 backoff한다.
3. 재시도를 소진하면 그 모델을 현재 run에서 degraded로 표시하고 다음 실행 가능한 alias로 전환한다.
4. 인증, `400`/schema, 정책 거부, 알 수 없는 오류는 다른 모델로 우회하지 않고 즉시 중단한다.
5. 각 시도와 `retry_same_model`, `fallback_next_model`, `skip_unavailable`, `success`는 `runs/<run-id>/fallback-events.jsonl`에 남는다. 실패 시점에는 원문 stderr를 복사하지 않고 분류된 원인·대응·증거 경로를 `runs/<run-id>/failures.jsonl`과 `progress.txt`에도 즉시 기록한다.
6. DeepSeek·GLM API Worker는 `tool-agent.py`가 `RALPH_AGENT_ERROR` 구조로 실패 원인을 반환하며, Ralph는 이 구조를 문자열 추측보다 우선해 분류한다.

## 역할과 명령

- Critic: 코드를 수정하지 않고 작업별 criterion 수준·증거, Hard Gate와 finding만 JSON으로 출력한다. 총점과 최종 판정은 만들지 않는다.
- Meta-Prompter: Critic 결과를 바탕으로 다음 `PROMPT.md` 전체를 출력한다.
- Worker: 저장소를 직접 수정하고 검증한다. 로그인형 모델은 agent CLI, API형 모델은 공용 tool-call 하네스를 사용한다.
- Verifier: LLM이 아니라 테스트·린트·타입 검사 같은 결정적 명령이다.

DeepSeek와 GLM General은 공식 `tool_calls`를 반환하면 `tool-agent.py`가 파일 목록·문자열 검색·SHA 기반 원자 편집·백업 삭제·Git diff·결정적 verifier를 실행하고 결과를 `role=tool`로 되돌려준다. 임의 shell·네트워크·배포·Git push/commit은 도구로 제공하지 않고, `.ralph/**`와 `.antigravity/**` 제어면은 Worker가 자기 실행 규칙을 바꾸지 못하도록 보호한다. DeepSeek thinking tool call의 `reasoning_content`도 후속 요청에 보존한다.

GLM Coding Plan 키는 자체 HTTP 클라이언트가 직접 소비하지 않는다. `tool-agent.py`가 공식 지원 Claude Code를 비밀·Git 메타데이터가 빠진 임시 작업공간에서 실행하고 성공한 UTF-8 변경만 SHA 충돌 검사 후 실제 저장소에 반영한다. GLM General 직접 하네스는 별도 `GLM_GENERAL_API_KEY`와 `zai-general` model alias가 있을 때만 사용한다.

Claude 자체 모델은 `.ralph/claude-builtin-agent.sh`가 `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`을 실행 프로세스에서 제거하고 `claude auth status`의 Claude.ai first-party 저장 로그인을 확인한 뒤 실행한다. GLM Coding Plan용 Claude Code 환경은 별도 자식 프로세스에만 설정되므로 실제 Claude 구독 로그인과 섞이지 않는다.

## 진행 상태의 원본과 Git checkpoint

Ralph의 진행 상태는 LLM의 대화 Context Window가 아니라 저장소 파일과 Git history가 원본이다. `PROMPT.md`는 현재 작업 계약, 코드와 테스트는 실제 구현 상태, `progress.txt`는 성공·재시도·중간 실패의 시간순 원장, `guardrails.md`는 반복 가능한 교훈, `runs/<run-id>/`와 `state.json`은 상세 로컬 실행 증거를 보존한다. 각 Critic·Meta·Worker 호출은 최근 progress도 다시 읽으므로 특정 모델 세션이 끊겨도 다음 모델이 실패 원인부터 작업을 재구성할 수 있다.

실제 run은 깨끗한 작업 트리에서만 시작한다. 사전 Critic 또는 Meta가 실패한 경우까지 포함해 시작된 각 이터레이션은 `chore(ralph): <task> iteration <n> <status>` 형식의 로컬 checkpoint를 시도한다. 정상 종료 checkpoint는 Iteration 경계이고, Meta·Worker 실패 뒤 checkpoint는 실패 기록과 당시 변경을 복구하기 위한 안전 저장일 뿐 성공을 뜻하지 않는다. 중간 실패 기록과 Critic 교훈도 checkpoint 전에 append되므로 해당 커밋에서 함께 복구된다. 파일 변경이 없는 이터레이션도 empty commit으로 기록하며, 커밋 본문과 `runs/<run-id>/git-checkpoint-<n>.json`에 Worker·Verifier 종료 코드와 Critic 판정을 남긴다. 민감 파일·Git 안전 조건 때문에 commit이 차단되면 `checkpoint_failed` 이벤트와 `git-checkpoint-<n>.stderr`를 남기고 루프를 실패 종료한다. `.stderr`는 Git 안전 스크립트의 오류 스트림을 저장한 일반 텍스트 진단 로그다. 계측 도입 전 실행처럼 파일이 실제로 없으면 대시보드는 원인을 추정하지 않는다. 자동 push는 하지 않는다.

이 정책 때문에 새 작업을 위해 `PROMPT.md`를 수정했거나 사람이 직접 만든 변경이 있으면 Ralph 실행 전에 먼저 검토하고 기준 커밋으로 저장해야 한다. 이는 사람의 미완성 변경과 Worker 변경이 하나의 자동 커밋에 섞이는 것을 방지한다.

## Ralph Control Center

Control Center는 루프와 별도로 실행되는 로컬 관찰용 사이드카다. Ralph의 모델 선택, 프롬프트 재작성, 폴백, 검증, 점수, 체크포인트 조건을 변경하지 않는다. `ralph-loop.sh`는 이벤트 기록에 실패해도 계속 실행하고, 대시보드는 기존 `PROMPT.md`, `runs/`, `state.json`, Git 상태를 읽어 화면을 만든다. 사용자가 버튼을 명시적으로 누를 때만 Operator Note를 저장하거나 종료된 상세 run 로그를 삭제한다.

처음 실행하거나 화면 상태·중간 개입 방법을 확인할 때는 사용자 중심 안내서인 `docs/RALPH_CONTROL_CENTER.md`를 먼저 읽는다. 이 절은 구현 계약과 안전 경계를 설명한다.

별도 터미널에서 다음을 실행한다.

```bash
.ralph/ralph-dashboard.sh --check
.ralph/ralph-dashboard.sh --open
```

기본 주소는 `http://127.0.0.1:7331`이다. 다른 로컬 포트를 쓰려면 `--port 7444`처럼 지정한다. 서버는 loopback 주소에만 바인딩하며 외부 서비스, 다른 사용자의 컴퓨터, 원격 DB로 데이터를 보내지 않는다.

화면에서는 다음을 확인한다.

- `PROMPT.md`의 구현 요구사항과 완료 조건 목록. 명시적인 `[x]` 또는 전체 run 통과만 완료로 표시하며 추측으로 완료 처리하지 않는다.
- Iteration별 Pre-Critic → Meta-Prompter → Worker → Verifier → Post-Critic → Git checkpoint 상태.
- 모델 alias, 시도 횟수, 폴백·재시도, Critic 요약·점수·판정, verifier 로그, 현재 diff와 checkpoint.
- `모델·토큰` 페이지의 정확한 모델명·추론 강도, 모델별 담당 단계, 호출별 입출력 token usage와 비율 차트. 새 래퍼는 공급자의 구조화된 usage를 분리 기록하고, 계측 도입 전 Codex CLI 로그나 총량만 제공된 호출은 `총량만 기록됨`으로 표시해 입력·출력을 추정하지 않는다.
- 실행 중 출력 파일이 실제로 증가하면 SSE로 갱신되는 최신 출력. 모델의 비공개 사고과정이 아니라 응답·판단 요약·도구·검증 증거를 표시한다.
- 과거 로컬 run 선택과 증거 파일 열람. `.env`, 개인 설정, run 디렉터리 밖 파일은 API로 열 수 없다.
- `편집` 모드에서 종료된 로컬 run을 체크해 `선택 삭제`하거나 `전체 삭제`한다. 모델 응답·검증·토큰 상세 로그만 지우며 코드와 Git 커밋은 바꾸지 않는다. 실행 중인 run은 선택할 수 없고 일괄 삭제에서도 보호된다.

상단 `오퍼레이터 메모`는 `.ralph/OPERATOR_NOTE.local.md`를 원자적으로 갱신한다. 사용자가 버튼을 눌렀을 때만 다음 Critic·Meta·Worker 입력에 영향을 주며, 실행 중인 단일 모델 호출에는 끼어들지 않는다. 즉시 중단은 기존대로 Ralph를 실행한 터미널에서 `Ctrl+C`를 사용한다.

## 세션 지속형 하이브리드

AGY 세션은 작업 기억으로만 사용한다. 구현 연속성이 필요한 Meta-Prompter와 Worker만 세션을 유지하고, 독립 평가가 필요한 Critic은 매번 stateless로 실행해 이전 점수에 anchoring되지 않게 한다. 세션 키는 `Ralph run + task + node stage + model alias`이며 Meta-Prompter와 Worker도 서로 conversation을 공유하지 않는다. 같은 node와 모델이 다음 이터레이션에 다시 호출될 때만 저장된 정확한 `conversation_id`를 `--conversation`으로 지정한다. 전역의 최근 대화를 고르는 `--continue`는 사용하지 않는다.

모든 호출 앞에는 프로젝트 절대 경로, 현재 Git HEAD와 working tree, “현재 파일·Git·검증 증거가 이전 세션 기억보다 우선한다”는 canonical state contract를 삽입한다. 다른 fallback 모델은 전체 파일 증거로 새 세션을 시작하며, conversation 만료·삭제·손상 시 기존 ID를 격리하고 같은 입력으로 새 세션을 만든다. 한 세션이 12 turns에 도달해도 새 세션으로 회전한다.

이 구조는 node 간 개입을 만들지 않는다. node 사이의 유일한 handoff는 `PROMPT.md`, Critic JSON, verifier 로그, Git 상태처럼 스크립트가 명시적으로 조립한 산출물이다. Meta·Worker의 세션 ID·생성·재개·초기화 이벤트는 `runs/<run-id>/sessions/`와 `session-events.jsonl`에만 저장되며 Git에 커밋되지 않는다. Critic과 Smoke test는 항상 stateless로 실행한다.

## 준비

필수 도구는 Bash 3.2 이상, Python 3.11 이상, `jq`, Git이다.

```bash
cp .ralph/commands.local.sh.example .ralph/commands.local.sh
chmod +x .ralph/ralph-loop.sh .ralph/resolve-config.sh .ralph/git-checkpoint.sh .ralph/critic_engine.py .ralph/critic_calibration.py .ralph/claude-builtin-agent.sh .ralph/codex-builtin-agent.sh .ralph/record-usage.py .ralph/tool-agent.py
chmod +x .ralph/ralph-dashboard.sh .ralph/observability.sh .ralph/dashboard/server.py
```

먼저 `config.local.json`에 개인 Provider·모델·reasoning·Worker `taskPipelines`·Critic/Meta `fallbackChains`를 작성한다. Critic chain에는 가능하면 서로 다른 공급자의 모델을 2개 이상 두고, Worker primary와 같은 alias만으로 구성하지 않는다. Post-Critic은 다른 실행 가능한 모델이 있으면 실제 Worker alias를 자동으로 건너뛰며, 통과선 경계 재심은 Worker와 1차 Critic 양쪽과 다른 모델을 선택한다. 이어 `commands.local.sh`의 `ralph_command_for`에 각 alias·역할의 agent 명령을 등록한다. AI 명령은 stdin을 프롬프트로 받아 stdout에 응답해야 한다. 비밀값은 명령 문자열이나 로그에 넣지 않는다.

Antigravity의 채팅 입력창 자체를 Bash가 조작하는 대신 같은 계정의 `agy` headless CLI를 사용한다. 실제 run에서는 node별 exact conversation을 재개하지만 Smoke test는 stateless다. Antigravity IDE는 진행 관찰·수동 개입·프롬프트 편집에 사용한다.

먼저 설정만 검사한다.

```bash
.ralph/resolve-config.sh --check
.ralph/ralph-loop.sh --check
```

외부 모델 연결까지 읽기 전용으로 한 번 확인하려면 다음을 실행한다. 이 명령은 소량의 모델 사용량을 쓰지만 `PROMPT.md`나 저장소를 수정하지 않는다.

```bash
.ralph/ralph-loop.sh --smoke
```

루프 설명을 출력하려면:

```bash
.ralph/ralph-loop.sh --explain
```

실행 예시:

```bash
git status --short
.ralph/ralph-loop.sh --task backend_core
```

`git status --short`가 비어 있지 않으면 Ralph가 실행을 거부한다. 현재 변경을 검토하고 기준 커밋을 만든 뒤 다시 실행한다.

지원 task ID:

- `planning_architecture`
- `frontend_visual`
- `backend_core`
- `tdd_debugging`
- `static_review`
- `delivery_evidence`

## 성공 조건

Critic은 임의 점수와 `verdict`를 반환하지 않는다. `critic_engine.py`가 공통 40점과 선택 task 60점의 각 항목을 `absent=0%`, `partial=50%`, `verified=80%`, `complete=100%` 앵커로 계산한다. 다음 조건이 모두 충족되어야 종료 코드 0으로 끝난다.

1. Worker와 `RALPH_VERIFY_CMD`가 성공한다.
2. 사후 Critic의 모든 작업별 criterion과 Hard Gate 증거가 유효하다.
3. Hard Gate 실패·미확인과 높은 차단 finding이 없다.
4. 계산 점수가 `RALPH_MIN_CRITIC_SCORE` 이상이다.

계산 결과는 `pass`, `retry`, `needs_operator` 세 가지다. 코드·증거 보완으로 해결 가능하면 `retry`, 환경·로그인·권한·범위 결정·미확인 Hard Gate이면 `needs_operator`로 즉시 멈춘다. 동일 실패 fingerprint가 두 번 연속 반복되거나 세 평가에서 점수 개선이 두 번 연속 3점 미만이면 폭주 방지를 위해 `needs_operator`가 된다. 모델이 “완료했다”고 말하는 것만으로는 종료하지 않는다.

`경계 재심`은 모든 실행에 Critic 두 개를 호출하는 기능이 아니다. 1차 계산 점수가 통과선의 ±5점(기본 85점이면 80~90점)이거나 Hard Gate가 `unknown`일 때만 다른 모델이 같은 증거를 다시 평가한다. 명확한 65점 실패나 100점 통과에는 추가 비용을 쓰지 않는다.

`고정 sample 보정`은 정답을 미리 정한 6 task × 4상태, 총 24개 사례로 점수 산식이 명확한 통과를 떨어뜨리거나 명확한 실패를 통과시키지 않는지 검사하는 오프라인 테스트다. 유료 모델을 호출하지 않는다.

```bash
python3 .ralph/critic_calibration.py --threshold 85 --margin 5
```

`maxIterations`의 기본 6은 고정 실행 횟수가 아니라 상한이다. 첫 반복이라도 로컬 채점 엔진이 `pass`를 계산하면 즉시 끝난다. Critic과 Meta-Prompter가 앞으로 생성하는 한국어는 `CRITIC_RUBRIC.md`와 `META_PROMPT.md`의 `합니다`체 규칙을 따르며, 감사용 과거 실행 원문은 수정하지 않는다.

## 작업 중 개입

- `.ralph/OPERATOR_NOTE.local.md`를 수정하면 다음 Critic/Meta/Worker 입력부터 새 지시가 포함된다.
- 현재 실행 중인 단일 모델 호출을 즉시 바꾸려면 `Ctrl+C`로 루프를 중단한다.
- 중단 뒤 `git diff`, `git log --oneline --grep='^chore(ralph):'`, 현재 run 로그를 확인한다. 완료된 이터레이션은 커밋되어 있고 중단된 현재 이터레이션만 working tree에 남는다.
- 잘못된 완료 checkpoint는 `git revert <commit>`으로 되돌리는 방식을 우선한다. 현재 미완성 diff를 제거하는 명령은 내용을 잃을 수 있으므로 반드시 사람이 diff를 확인한 뒤 실행한다.
- 실행 중 `PROMPT.md` 직접 수정은 Meta-Prompter와 충돌할 수 있으므로, 목표 변경은 중단 후 수행한다.

## 안전 경계

- 루프는 각 이터레이션을 로컬 checkpoint로 자동 커밋하지만 push·배포는 하지 않는다.
- 시작 전 working tree가 깨끗하지 않거나 detached HEAD, merge/rebase 중이면 실행을 거부한다.
- `.env`, `credentials.json`, 개인 설정, private key 경로 또는 비밀값 패턴이 감지되면 checkpoint를 만들지 않고 루프를 중단한다.
- 실제 외부 서비스 변경은 Worker 명령의 권한 범위에 달려 있으므로 agent 도구의 승인 정책을 유지한다.
- 직접 API 하네스는 공용 `workerHarnessPolicy`의 보호 경로·크기·왕복·도구 횟수 상한을 강제하고 비정상 종료 시 자체 변경을 롤백한다.
- `tool-events-*.jsonl`에는 tool 이름·상태·사용량·변경 요약만 기록하며 API 키와 reasoning 원문은 저장하지 않는다.
- Control Center는 `127.0.0.1`에서만 실행하고, 읽는 증거의 비밀값 의심 패턴을 화면에 보내기 전에 마스킹한다.
- AGY conversation ID는 현재 run의 Git 제외 디렉터리에만 저장하고, 다른 task·node·model에 재사용하지 않는다.
- 실행 전의 사용자 변경을 되돌리지 않는다.
- `commands.local.sh`, `runs/`, `state.json`은 Git에서 제외된다.
- 자동 누적 교훈이 잘못됐으면 사람이 `guardrails.md`에서 수정할 수 있다.
