# 프로젝트 도입과 일상 사용

## 처음 한 번

```bash
npm install -g @worldclasscitizen/ralph
cd /absolute/path/to/git-project
ralph init
ralph doctor
```

`ralph init`은 프로젝트 루트에 제어 파일을 복사하지 않습니다. `git rev-parse --git-path ralph`로 찾은 Git 내부 경로에 프로젝트 설정과 실행 증거를 만듭니다. 전역 Provider 연결 정보는 운영체제 사용자 설정과 자격 증명 저장소에 둡니다.

팀원은 저장소를 clone한 뒤 각자의 컴퓨터에서 `ralph init`과 Provider 로그인을 수행합니다. 모델 접근 권한과 구독은 공유되지 않으며 팀 저장소에 개인 fallback JSON을 커밋하지 않습니다.

## 새 작업

```bash
ralph run "자연어 작업 요청"
```

1. `contractPlanner`가 자연어를 한 작업의 계약으로 만듭니다.
2. Ralph가 포함·제외 범위, 완료 기준, verifier와 모델 경로를 표시합니다.
3. 사용자가 승인하면 코드를 수정합니다.
4. Critic → Meta → Worker → Verifier → Post-Critic이 실행됩니다.
5. 통과선 경계에서만 다른 Provider 재심을 시도합니다.
6. 매 Iteration의 상태를 로컬 Git checkpoint로 남깁니다.
7. `pass`, `needs_operator`, `failed`, `interrupted` 중 하나로 끝납니다.

한 run에는 하나의 독립적으로 검증 가능한 작업만 넣습니다. 목표가 크게 바뀌면 현재 run을 안전 중단하고 새 자연어 요청으로 새 계약을 만듭니다.

## AI 환경에서 시작

```bash
ralph integrations install
```

Codex `$ralph`, Claude Code `/ralph`, Antigravity `/ralph`, Gemini CLI Skill은 모두 같은 CLI를 호출합니다. AI는 자연어와 현재 절대 경로를 전달하고 계약을 설명하지만 사용자 대신 승인하지 않습니다.

## CI와 비대화형 프로토콜

```bash
printf '%s' "$REQUEST" | ralph draft --project /abs/project --stdin --json
printf '%s' "$APPROVED_CONTRACT" | ralph run --project /abs/project --contract-stdin --yes --events ndjson
ralph status --project /abs/project --json
```

JSON·NDJSON 모드에서 stdout은 기계 판독 데이터 전용이고 사람용 안내와 오류는 stderr로 분리됩니다. `--yes`는 사용자가 외부 UI에서 이미 승인했음을 전달하는 명시적 승인 신호입니다.

## 업데이트

```bash
npm update -g @worldclasscitizen/ralph
ralph doctor
ralph catalog diff
```

Ralph는 매 실행마다 원격 카탈로그를 기다리지 않습니다. 24시간 이내에는 네트워크를 사용하지 않고, 오래된 cache는 최대 3초의 제한된 확인 뒤 검증된 이전 카탈로그로 계속 동작합니다.

## 제거

npm 패키지를 지워도 프로젝트 코드에는 영향이 없습니다.

```bash
ralph integrations uninstall
npm uninstall -g @worldclasscitizen/ralph
```

Git 내부 `ralph/` 상태는 실행 증거와 복구 정보이므로 필요 여부를 확인한 뒤 직접 보관하거나 삭제합니다.
