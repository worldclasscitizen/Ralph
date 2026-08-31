# npm·카탈로그 릴리스

## npm beta

```bash
npm ci
npm run build
npm test
npm run test:coverage
npm run docs:build
npm run smoke
npm audit --audit-level=moderate
npm pack --dry-run
npm publish --access public --tag beta
```

배포 tarball에는 `dist/`, `assets/`, `integrations/`, 범용 `docs/`, `START_HERE.md`, `README.md`, `README.ko.md`, `LICENSE`만 포함됩니다. VitePress 빌드 결과, `legacy/`, 테스트, 실행 상태와 비밀값은 포함되지 않습니다.

## 모델 카탈로그 서명

Ed25519 private key는 저장소와 npm tarball에 절대 넣지 않습니다. 릴리스 담당자는 안전한 저장소에서 key를 복원하고 절대 경로를 환경변수로 전달합니다.

```bash
RALPH_CATALOG_PRIVATE_KEY=/absolute/secure/path/catalog-ed25519-private.pem \
  node scripts/sign-catalog.mjs assets/catalog.json assets/catalog.sig
```

현재 개발 머신의 beta signing key는 저장소 밖 사용자 보안 경로에만 있으며 파일 권한은 `0600`입니다. 정식 릴리스 전에는 별도 백업·회전 정책과 CI secret 주입 방식을 확정해야 합니다.

1. 공식 Provider 문서와 실제 모델 목록으로 ID·capability·effort를 확인합니다.
2. `version`을 이전 릴리스보다 반드시 높입니다.
3. `releasedAt`부터 `expiresAt`까지 184일을 넘기지 않습니다.
4. `npm test`로 schema·서명·라우터·24개 Critic 표본을 검증합니다.
5. `catalog.json`과 `catalog.sig`를 같은 GitHub Release asset으로 게시합니다.
6. rollback 버전, 500KB 초과 파일 또는 잘못된 서명은 client가 거부하는지 확인합니다.
