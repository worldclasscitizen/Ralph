# Ralph Control Center

Control Center는 현재 사용자의 로컬 Ralph 실행을 관찰하는 Node 사이드카입니다. 라우팅, 프롬프트, 점수 또는 종료 조건을 바꾸지 않습니다.

```bash
ralph dashboard --open
ralph dashboard --port 7444 --open
ralph dashboard --all --open
ralph dashboard status
ralph dashboard stop
```

서버는 `127.0.0.1`에만 바인딩합니다. 기본 화면은 현재 Git 프로젝트만 보여주고 `--all`에서만 이 컴퓨터에 등록된 프로젝트를 합쳐 봅니다. 다른 팀원이나 원격 실행을 수집하지 않습니다.

## 화면

- Header: 작업공간 절대 경로, Git branch, 시작·종료 시각을 각각 표시합니다.
- LOOP HISTORY: 이 컴퓨터·이 프로젝트의 실행 기록입니다. `편집`을 누른 뒤 체크한 종료 기록을 한 번에 삭제하거나 전체 삭제할 수 있습니다.
- 작업 계약: 승인된 목표, 포함·제외, 구현 요구, 완료 기준, 검증과 산출물을 보여줍니다. 백틱 텍스트는 code UI로 표시합니다.
- ITERATION: 실행 주체의 정확한 model ID·effort, 시도, 증거, 판정, checkpoint를 보여줍니다.
- EXECUTION: 각 노드는 접힌 상태에서 완료·실행 중·주의·실패·대기만 보여주고 누르면 판단 요약과 증거가 열립니다.
- 모델·토큰: Ralph 호출에서 Provider가 반환한 입력·출력·cache·reasoning·총 token과 모델 비율을 보여줍니다.
- Provider 사용 가능량: 계정 잔여량 또는 API 잔액을 Ralph token 사용량과 분리해 보여줍니다.

`M`은 수정, `A`는 추가, `D`는 삭제, `??`는 아직 Git이 추적하지 않는 새 파일입니다. 추가와 `+`는 초록, 삭제와 `-`는 빨강, 수정은 노랑, 미추적은 보라색으로 표시합니다.

## 상태 의미

- 초록 완료: 해당 노드의 관찰 가능한 결과가 정상 저장됐습니다.
- 파랑 실행 중: 현재 살아 있는 run의 현재 노드입니다.
- 노랑 주의: 재시도, fallback, 평가 독립성 저하 또는 사용자 확인 가능성이 있습니다.
- 빨강 실패: 노드가 실패했거나 중단된 run의 마지막 실행 노드입니다.
- 회색 대기: 아직 실행되지 않았습니다.

Git checkpoint는 AI가 아니라 로컬 Git 안전 코드가 만듭니다. 실패하면 비밀 파일, 충돌, Git 상태 또는 commit 오류를 확인해야 합니다. npm 버전은 오류를 run event와 progress 원장에 저장합니다.

## Iteration과 평가

최대 6회는 상한입니다. 첫 회라도 Worker와 verifier가 성공하고, Post-Critic Hard Gate가 명확히 통과하며, 공통 40점 + 작업별 60점의 로컬 계산이 85점 이상이면 종료합니다.

Critic은 점수나 verdict를 반환하지 않고 항목별 `absent`, `partial`, `verified`, `complete`와 증거만 반환합니다. 로컬 엔진이 각각 0%, 50%, 80%, 100% 앵커로 계산합니다. 80~90점 또는 `unknown` Hard Gate에서만 독립 재심을 호출합니다.

## 개입

오퍼레이터 메모는 저장 뒤 다음 Critic·Meta·Worker 중 가장 먼저 시작하는 한 노드에만 전달되고 자동으로 비워집니다. 현재 모델 호출의 비공개 생각에 끼어들지 않습니다.

- 다음 노드에 제약 추가: 오퍼레이터 메모 저장
- 안전한 경계에서 중단: 대시보드 `안전 중단` 또는 `ralph stop`
- 현재 프로세스 강제 중단: `ralph stop --force`
- 목표 변경: 중단 후 새 `ralph run "새 요청"`

대시보드를 닫아도 Ralph run은 계속됩니다. 반대로 run이 끝나도 대시보드는 기록 열람용으로 남아 있습니다.

## 기록 삭제

LOOP HISTORY 삭제는 모델 응답, verifier, token과 event 같은 Git 내부 로컬 실행 증거를 지웁니다. 제품 코드와 이미 만든 Git checkpoint commit은 바뀌지 않습니다. 해당 run의 Ralph 사용량 집계에서도 빠지므로 비용·품질 회고에 필요하면 보관합니다. 실행 중인 run은 삭제할 수 없습니다.

## CLI만 사용하는 환경

```bash
ralph status --watch
ralph logs --follow
ralph usage
ralph capacity
```

대시보드는 편의 UI이며 CLI 기능의 필수 조건이 아닙니다.
