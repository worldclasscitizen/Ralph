# 다른 프로젝트에 도입하기

이 템플릿은 두 가지 방식으로 사용할 수 있습니다.

## 1. 새 프로젝트의 기반으로 사용

저장소를 fork하거나 template repository에서 새 저장소를 만든 뒤 제품 코드를 추가합니다. 이 방식은 루프 제어 파일과 Git 안전 정책을 처음부터 유지하기 가장 쉽습니다.

1. 개인 설정 예제를 실제 파일로 복사합니다.
2. 사용할 Provider와 모델만 남깁니다.
3. builtin CLI에 로그인하거나 직접 API 키를 `.env`에 넣습니다.
4. 프로젝트 검증 명령을 연결합니다.
5. `PROMPT.md`를 AI와 함께 작성하고 기준 커밋을 만듭니다.
6. `--check`, `--smoke`, 실제 run 순서로 확인합니다.

## 2. 기존 Git 프로젝트에 설치

템플릿 저장소 밖에서 다음 명령을 실행합니다.

```bash
./scripts/install.sh /absolute/path/to/existing-project
```

설치기는 다음 원칙을 지킵니다.

- 대상이 Git 저장소인지 확인합니다.
- 기존 `.ralph` 또는 `.antigravity`가 있으면 덮어쓰지 않고 중단합니다.
- 오케스트레이션 디렉터리와 대시보드 문서만 복사합니다.
- 대상의 `README.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`는 건드리지 않습니다.
- 대상에 `.env.example`이 이미 있으면 Provider 예시를 `.env.ralph.example`로 복사합니다.
- 필요한 ignore 규칙은 구분된 블록으로 `.gitignore`에 한 번만 추가합니다.
- `RALPH_START_HERE.md`를 설치해 대상 프로젝트의 AI가 온보딩을 시작할 위치를 제공합니다.

설치 후 프로젝트의 기존 에이전트 안내 파일에는 다음 한 줄만 사람이 맞는 위치에 추가합니다.

> Ralph 작업을 준비하거나 실행할 때는 먼저 `RALPH_START_HERE.md`를 읽습니다.

## 프로젝트 검증 명령 연결

기본 `.ralph/verify-project.sh`는 루프 자체를 검증한 뒤 루트 `package.json`에 존재하는 `test`, `lint`, `typecheck`, `build` 스크립트를 실행합니다.

다른 스택이나 별도 명령은 개인 `.ralph/commands.local.sh`에 다음처럼 지정할 수 있습니다.

```bash
export RALPH_VERIFY_CMD='make verify'
```

검증 명령은 비대화형이어야 하고 실패할 때 0이 아닌 종료 코드를 반환해야 합니다. 테스트가 없는 프로젝트에서 단순히 성공하는 명령을 넣으면 Critic의 근거가 약해지고 불필요한 반복 또는 잘못된 통과가 생깁니다.

## 도입 직후 체크리스트

- [ ] `.antigravity/config.local.json`에 실제 모델만 있습니다.
- [ ] `.ralph/commands.local.sh`의 모든 선택 alias가 실행 가능합니다.
- [ ] `.env`는 Git에서 제외되고 비밀값이 다른 파일에 없습니다.
- [ ] `.ralph/verify-project.sh` 또는 `RALPH_VERIFY_CMD`가 실제 프로젝트를 검사합니다.
- [ ] `.ralph/PROMPT.md`에는 절대 프로젝트 경로와 단일 작업이 있습니다.
- [ ] 기준 커밋 뒤 working tree가 깨끗합니다.
- [ ] 대시보드가 `127.0.0.1`에서만 열립니다.

## 업데이트 전략

이미 도입한 프로젝트는 설치기를 다시 실행해 덮어쓰지 않습니다. 템플릿의 새 버전을 별도 clone한 뒤 `.ralph`, `.antigravity`, 문서 변경을 diff로 검토하고 프로젝트 고유 verifier·model alias·guardrail을 보존하면서 선택적으로 병합합니다.
