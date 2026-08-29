# Agent entry point

이 저장소에서 작업하는 AI 에이전트는 먼저 `START_HERE.md`를 읽습니다.

- `.antigravity/config.json`은 공유 catalog이며 개인 fallback chain을 넣지 않습니다.
- 개인 선택은 Git에서 제외된 `.antigravity/config.local.json`과 `.ralph/commands.local.sh`에만 둡니다.
- 한 Ralph run에는 `.ralph/PROMPT.md`에 정의된 단일 작업만 수행합니다.
- 실행 전에 사용자에게 작업 계약과 모델·검증 계획을 설명하고 승인을 받습니다.
- 파일·검증 결과·Git history를 세션 기억보다 우선합니다.
- `.env`, 토큰, 비밀 키, 개인 실행 로그를 커밋하지 않습니다.
- 자동 push·배포·외부 시스템 변경은 별도 사용자 승인이 없으면 수행하지 않습니다.
