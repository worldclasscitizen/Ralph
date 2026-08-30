# Ralph 온보딩 내비게이션

이 문서는 사람이나 AI가 저장소를 처음 열었을 때 설치부터 첫 승인 직전까지 순서대로 안내하는 단일 진입점입니다.

## 사용자가 하는 일

1. Node.js 22 이상과 Git이 설치되어 있는지 확인합니다.
2. 일반 터미널에서 `npm install -g @worldclasscitizen/ralph`를 실행합니다.
3. Ralph를 적용할 Git 프로젝트의 절대 경로로 이동합니다.
4. `ralph init`을 실행해 프로젝트를 등록하고 사용 가능한 Provider를 탐지합니다.
5. `ralph doctor`를 실행해 로그인, API key, Git 상태와 모델 경로를 확인합니다.
6. `unauthenticated` 또는 인증 필요로 표시된 연결만 해당 CLI에서 로그인하거나 OS 자격 증명 저장소에 API key를 추가합니다.
7. 필요하면 `ralph integrations install codex claude antigravity gemini`로 AI 제품용 Skill을 설치합니다.
8. 자연어 작업을 `ralph run "요청"`으로 전달합니다.
9. 화면에 나온 작업 계약, 제외 범위, 검증 명령과 모델 경로를 읽습니다.
10. 내용이 맞을 때만 명시적으로 승인합니다.
11. `ralph status --watch` 또는 `ralph dashboard --open`으로 진행을 확인합니다.
12. 다음 노드에만 반영할 지시는 대시보드 오퍼레이터 메모에 저장합니다.
13. 멈추려면 `ralph stop`, 부분 상태를 정리하려면 `ralph recover`를 사용합니다.
14. 종료 뒤 Git checkpoint와 verifier 증거를 검토한 후 사람이 원격 push·배포 여부를 결정합니다.

## AI가 사용자를 안내하는 순서

1. 현재 Git 프로젝트의 절대 경로를 실제 명령으로 확인합니다.
2. `ralph doctor --project <절대 경로> --json`을 실행합니다.
3. 로그인이나 key가 필요한 연결만 사용자가 직접 조치하도록 정확한 명령을 안내합니다.
4. 사용자의 자연어 요청을 `ralph draft --project <절대 경로> --stdin --json`에 전달합니다.
5. 계약의 `executionProfile`로 `ralph config explain --profile <profile>`을 실행해 목표, 포함·제외, 완료 기준, 검증과 정확한 Worker 경로를 쉽게 설명합니다.
6. 사용자 승인 전에는 `ralph run --contract-stdin`을 실행하거나 코드를 수정하지 않습니다.
7. 승인 후 변경되지 않은 계약 JSON을 `ralph run --contract-stdin --yes --events ndjson`으로 전달합니다.
8. 이벤트, verifier, Git checkpoint와 최종 판정만 설명하며 비공개 사고과정을 추측하지 않습니다.

## Provider 로그인

`ralph init`은 설치된 CLI를 탐지하지만 다른 팀원의 로그인까지 대신하지 않습니다. 각 컴퓨터에서 한 번씩 로그인해야 합니다.

```bash
ralph auth status
ralph auth login openai:codex-login
ralph auth login anthropic:claude-login
```

Antigravity와 Gemini CLI는 구조화된 로그인 상태 명령이 없을 수 있으므로 공식 IDE/CLI에서 로그인한 뒤 실제 호출 또는 `ralph doctor`로 확인합니다. Ralph는 로그인 token 파일을 읽거나 복사하지 않습니다.

API key는 JSON이나 Markdown에 넣지 않습니다.

```bash
printf '%s' "$DEEPSEEK_API_KEY" | ralph auth add deepseek:api --key-stdin
```

OS 자격 증명 저장소를 사용할 수 없는 환경에서만 `DEEPSEEK_API_KEY`, `GLM_GENERAL_API_KEY` 같은 환경변수를 사용합니다. `.env.example`은 변수 이름 참고용일 뿐이며 프로젝트에 `.env`를 만들도록 강제하지 않습니다.

## 기본 체인과 개인 설정

여섯 Worker 작업 체인과 `contractPlanner`, `critic`, `metaPrompter`, `adjudicator` 체인은 `ralph init`이 자동 생성합니다. 개인 JSON을 새로 만들 필요가 없습니다.

```bash
ralph config pipelines
ralph config explain
ralph config preset balanced
```

자동 경로보다 직접 지정한 override가 우선합니다. export한 config에는 비밀값이 없으며, 수정본을 가져올 때는 같은 프로젝트 절대 경로와 schema version을 유지합니다.

```bash
ralph config export > /safe/path/ralph-config.json
ralph config import /safe/path/ralph-config.json
```

## 작업 계약은 어디에 있나요?

npm 버전에는 프로젝트 루트의 `PROMPT.md`가 없습니다. `contractPlanner`가 자연어를 구조화된 `TaskContract`로 만들고 Git 내부 `ralph/contracts/`에 저장합니다. 사용자는 CLI 또는 AI Skill에서 계약을 확인하고 승인하면 됩니다.

```bash
ralph show contract
ralph show progress
ralph show guardrails
```

## 실행이 끝나는 기준

- Worker가 정상 종료합니다.
- 등록된 결정적 verifier가 모두 통과합니다.
- Post-Critic이 모든 항목과 증거를 반환합니다.
- Hard Gate 실패·미확인이 없습니다.
- 로컬 엔진 점수가 기본 85점 이상입니다.

최대 Iteration 6회는 고정 횟수가 아니라 상한입니다. 첫 회에 통과하면 즉시 끝납니다. 같은 실패가 두 번 반복되거나 점수가 두 번 연속 3점 미만으로만 개선되면 `needs_operator`로 멈춥니다.

## 기존 Bash 템플릿 사용자

```bash
ralph migrate
ralph migrate --cleanup
```

첫 명령은 legacy 설정, PROMPT, progress, guardrails와 run 증거를 Git 내부 상태로 가져오되 비밀값을 복사하지 않습니다. `--cleanup`은 가져온 내용을 확인하고 명시적으로 승인한 뒤에만 기존 `.ralph`와 `.antigravity`를 제거합니다.

## 이 소스 저장소를 개발하는 경우

```bash
npm install
npm run build
npm test
npm run smoke
```

`legacy/bash-template/`은 beta 마이그레이션 fixture입니다. 새 기능은 `src/`, `assets/`, `integrations/`, `tests/`에 구현합니다.
