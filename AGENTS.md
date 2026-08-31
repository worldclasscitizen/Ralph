# Agent entry point

먼저 `START_HERE.md`를 읽습니다.

- 새 npm 런타임은 `src/`, `assets/`, `integrations/`, `tests/`에 구현합니다.
- `legacy/bash-template/`은 beta 마이그레이션 fixture이며 새 런타임 기능을 추가하지 않습니다.
- 소비자 프로젝트에는 `.ralph`, `.antigravity`, `PROMPT.md` 또는 개인 JSON을 만들지 않습니다.
- 프로젝트 상태는 `git rev-parse --git-path ralph`의 결과 아래에만 저장합니다.
- 작업 계약과 모델·검증 계획을 보여주고 사용자 승인을 받기 전에는 코드를 수정하지 않습니다.
- 파일·검증 결과·Git history를 모델 세션 기억보다 우선합니다.
- `.env`, 토큰, API key, 개인 실행 로그를 커밋하지 않습니다.
- 자동 push·배포·rollback은 구현하거나 실행하지 않습니다.
- 모델 카탈로그는 공식 근거, 6개월 만료, schema와 Ed25519 서명 규칙을 지킵니다.
- 변경 후 `npm run build`, `npm test`, `npm run smoke`를 실행합니다.
