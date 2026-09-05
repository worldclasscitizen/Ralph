# Stable release campaign: 2026-09-05

**Release status: blocked.** PR [#3](https://github.com/worldclasscitizen/Ralph/pull/3) remains a draft. No main merge, npm 0.3.0 publication or public GitHub release has occurred.

## Measured results

CI [33930145345](https://github.com/worldclasscitizen/Ralph/actions/runs/33930145345) passed on Windows, macOS and Linux with Node.js 22 and 24 at commit `0b1457f37193b988e3aae79ca793357d31969ae5`. All six environments installed the same archive. Each operating system completed five repetitions of five real process interruption boundaries. That CI result predates the subsequent benchmark harness fix; the PR must pass CI again at its final commit.

| Live check | Result | Calls | Wall time |
|---|---|---:|---:|
| Codex transport conformance | Four checks passed | 4 | Approximately 32 seconds |
| Fixed v0.2 baseline, first trial | Completed; external oracle passed | 5 | 217.944 seconds |
| v0.3 candidate, first trial | Paused before integration | 6 | 241.533 seconds |
| Remaining paired trials | Not run | 0 | — |

Total allowance consumption was **15 / 24 calls and 480,712 / 1,800,000 aggregate active milliseconds** (8 minutes 0.712 seconds). Cancellation and unsuccessful work count. API spending was zero. Token measurements are retained in the [failed comparison report](evidence/live-comparison.json); no monetary estimate is invented for the subscription connection. The [conformance report](evidence/history/live-provider-d852ba4e8c547e612be5d1e04de56a01fe13064d13bfb44e45f85ff8c2d8824a.json) records the actual model `gpt-5.6-luna`, CLI `0.153.1`, Windows and Node.js `24.11.1`.

## Failure and correction

The public task supplied only syntax checks and `git diff --check`. Its hidden external oracle ran only after final delivery. A candidate reviewer correctly reported missing behavioral evidence and scored the left branch 55.5, causing another worker iteration. The right branch completed after boundary adjudication, but the per-comparison six-call ceiling stopped the left branch before integration. No candidate completion or recovery success is inferred from its generated files.

Before the first candidate began, commit `8d6fb34aca21035a7609c0eaaabb7e66016e410f` narrowed each worker's goal to its own module. The baseline had already started with the previous harness. Both versions still used the same function contract, model and external oracle, but this mixed harness history is explicitly retained and cannot qualify as the final comparison.

The corrected fixture now contains frozen public behavioral examples for both modules. Both versions run those same tests. Each worker validates only its own module; the final node validates both. Workers cannot modify the test files. The external oracle remains separate and checks additional cases. Regression tests require that placeholders and incorrect implementations fail, and that an unfinished sibling does not fail a completed branch's local tests.

The campaign now records each trial's source identity, rejects source changes during execution, preserves failed trials, and checks the mock-estimated minimum call count against the remaining allowance before starting paid work. Nine remaining calls cannot finish a new comparison estimated at eighteen calls, even before conformance checks or retries. No additional live calls were started and no allowance was reset or increased.

## Deployment preparation

GitHub main requires the PR and six matrix checks plus the package check, without a separate human approval requirement. The `npm-release` environment permits main only. The new catalog signing key is outside the repository and stored as an encrypted environment secret; only its public key is published. Immutable GitHub releases are enabled.

The npm Trusted Publisher is configured for `worldclasscitizen/Ralph`, `release.yml`, environment `npm-release`, with direct `npm publish` permission. User security-key authentication completed successfully. Authentication setup is complete; publishing remains blocked by the verification results above.

## Original resumption conditions (superseded)

현재 정식 출시는 보류 상태입니다. 공급자 통신 검증은 통과했지만 그래프 실행의 필수 비교를 끝내지 못했습니다. 동작 검증을 보완한 뒤 모의 시험으로 재확인하며, 실패 이력과 남은 호출 예산은 보존합니다.

실검증을 재개하려면 수정한 동일 코드·검증 계약에 대한 비교와 공급자 보고서가 필요합니다. 남은 9회로 필수 비교를 완료할 수 없으므로 예산 변경은 사용자의 별도 결정 사항입니다. 검사 횟수나 통과 기준을 낮춰 출시하지 않습니다. 모든 출시 조건을 통과한 이후에만 PR 병합, 정확한 main 커밋의 재검증, npm 게시, GitHub Release 공개를 진행합니다.

## Approved functional release gate

The owner subsequently selected natural-language graph execution through verified delivery as the mandatory live gate. Repeated baseline comparisons are now historical reference. This is an explicit gate change, not a successful rerun of the failed comparison. The original reports, attempts and consumption above remain unchanged.

The remaining allowance is nine calls and 1,319,288 aggregate active milliseconds. A new generated-graph mock completed in eight calls. Before real work, source-byte proof must confirm reuse of the original four transport checks. No contract or graph is injected into the new real test; scope and frozen verifiers are checked before exact-plan approval. An incomplete real run still blocks release, and the allowance is never increased automatically.

사용자 선택에 따라 자연어 요청부터 그래프 생성·작업·검증·결과 반영까지의 실제 완주를 필수로 변경했습니다. 구버전 반복 비교는 참고 이력으로 보존합니다. 호출 한도는 그대로이며, 남은 예산 안에서 필수 검증을 마치지 못하면 출시를 보류합니다.

## Natural-language trial and contract schema correction

At source b1acb2dea2e79048f40d6241ce2f467a4cc0dc82, the new live trial stopped during contract planning after two calls (38.158 seconds wall time). The runtime persisted awaiting_input; neither the graph planner nor any worker started. Both returned JSON objects used objective instead of the required goal field and also contained worker/integration structures. The prompt named TaskContract without supplying its schema. The validator correctly refused both responses. See the original [failed functional report](evidence/live-functional.json) and the [response-shape review](evidence/live-functional-review.json), which records response hashes without private workspace paths.

The correction supplies one explicit TypeBox draft schema to both the contract prompt and the local draft validator. Errors name the missing field. Programmatic contract normalization remains compatible. Regression tests reject the observed wrong shape, malformed verifier arrays and invented approval fields. The corrected mock completes generated planning, two workers, integration, final validation, branch delivery and external acceptance in eight calls. This is mock evidence, not a corrected live success.

Transport evidence remains reusable: the adapter and fixture helper's recursively imported source files, original conformance requests, allowance implementation and lockfile are unchanged. The initial conservative 68-file comparison was narrowed to the actual 15-file dependency set; contract prompting is separately covered by the end-to-end gate. The original provider report and check date remain intact.

Total consumption is now **17 / 24 calls and 515,096 / 1,800,000 active milliseconds**. Seven calls remain, below the eight-call normal path. No further real call, allowance increase, main merge or publication has occurred. Retained run: run-8d700c7e-e441-49b8-ab87-7cd44141b11b.

실제 시험에서 계약 JSON 형식 안내 누락을 발견해 수정했습니다. 두 응답 모두 목표를 objective에 담았지만 런타임은 goal을 요구했습니다. 그래프와 Worker는 시작하지 않았습니다. 수정 후 모의 완주는 통과했으나 실제 재시험은 하지 않았습니다. 총 17회 사용·7회 잔여이며, 정상 경로의 예상 8회보다 부족해 정식 출시는 계속 보류합니다.

## Owner-directed count policy change and call accounting

The owner subsequently removed the cumulative call-count cap. The earlier limits and failures above describe the historical policy; they are not current limits. The shared 30-active-minute ceiling and no additional paid API connection remain. The V2 ledger archives the original V1 bytes and keeps all 17 calls and 515,096 active milliseconds. No additional live call was made to change or test the accounting policy.

One call means one request to the model, not one entire test. All 17 used the recorded Codex subscription connection and gpt-5.6-luna. Compilation, deterministic tests, Git operations and mock checks do not invoke a model. The real task used disposable Git projects: left.mjs sums finite non-negative numbers and rejects invalid input; right.mjs normalizes string whitespace and case and rejects invalid or empty input.

| Call | Purpose | Observed result |
|---:|---|---|
| 1 | Provider: produce structured JSON | Passed |
| 2 | Provider: create conformance.txt and verify its content | Passed |
| 3 | Provider: respond in a separate fresh session | Passed |
| 4 | Provider: start and cancel a request, await process closure | Cancellation check passed; the intentional interrupted call is recorded as failed |
| 5 | v0.2: initial review of the task and code | Review returned |
| 6 | v0.2: prepare implementation instructions | Instructions returned |
| 7 | v0.2: implement both functions | Implementation returned |
| 8 | v0.2: assess the implementation | Additional assessment required |
| 9 | v0.2: additional assessment | Run completed and external checks passed |
| 10 | v0.3 predefined graph: implement left.mjs | First implementation returned |
| 11 | v0.3 predefined graph: implement right.mjs | First implementation returned |
| 12 | v0.3: assess left.mjs | 55.5; behavioral evidence missing, another iteration required |
| 13 | v0.3: assess right.mjs | Borderline result required additional assessment |
| 14 | v0.3: second left.mjs implementation iteration | Changes returned; subsequent review never started under the old per-comparison cap |
| 15 | v0.3: additional right.mjs assessment | 89; right worker completed, integration did not start |
| 16 | Natural-language trial: generate the task contract | Invalid JSON shape; the prompt lacked the required contract schema |
| 17 | Natural-language trial: retry contract generation | Still invalid; graph planning and workers never started |

The four provider checks, five old-version calls, six predefined-graph calls and two contract-planning calls total 17. The missing behavioral evidence and missing contract schema were test setup and prompt defects, not mandatory overhead for every user request. Both corrections are covered by mock and deterministic tests; a corrected real end-to-end success is still required.

Provider reuse now uses an explicit V2 scope for unchanged requests, adapter/helper dependencies and lockfile. Accounting is checked separately without model calls; old V1 certificates keep their original scope. Original live results and dates are never rewritten. Functional source identity continues to include accounting code.

사용자 요청에 따라 누적 호출 횟수 제한을 없앴습니다. 17회는 연결 검사 4회, 구버전 작업 5회, 신버전 작업·평가 6회, 자동 계획 시도 2회입니다. 계획·구현·평가가 각각 AI 요청이며, 빌드·자동 테스트·Git 통합 자체는 AI를 부르지 않습니다. 기존 실패 기록과 호출 장부를 보존하며, 실제 완주 확인 전에는 정식 출시하지 않습니다.

## Current CLI and Windows Git inspection

The installed Codex CLI changed from 0.153.1 to 0.153.4. Calls 18–21 reran and passed the four transport checks. A new natural-language trial then used calls 22–27 for three contract/review pairs and stopped before graph generation. Windows sandbox commands ran as a separate account and Git refused the fixture owner. Original failure evidence is preserved in [the Windows review](evidence/live-windows-review.json). Total consumption at this point was 27 calls and 657522 active milliseconds.

The adapter now supplies a process-scoped safe.directory for the exact selected worktree. No global Git configuration or sandbox permissions change. A no-model sandbox probe confirms that the selected repository can be inspected, another repository remains untrusted, and read-only writes still fail. Contract prompts also explain the runtime's existing file-scope enforcement and prevent catch-all excludes. The adapter change requires new transport evidence before another full trial. See the [probe evidence](evidence/live-windows-git.json), [Codex Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox), and [process environment configuration](https://learn.chatgpt.com/docs/config-file/config-reference).

현재 CLI 버전 변경으로 연결 검사를 4회 다시 통과했습니다. 이어진 계약·검토 6회는 Windows 격리 계정의 Git 소유권 문제로 중단됐고 Worker는 시작되지 않았습니다. 해당 작업 폴더만 신뢰하는 프로세스 설정으로 수정했으며, 다른 저장소와 읽기 전용 쓰기 제한이 유지되는지 AI 호출 없이 확인했습니다.

## Graph compiler semantics

The workspace-scoped adapter passed four fresh transport checks (calls 28–31). The next trial passed contract generation and review, but three graph proposals failed local compilation (calls 32–36 overall). The proposals confused durable artifact IDs with paths, used duplicate artifact/order edges for the same pair, and invented verifier aliases or capability labels. The safe single-worker proposal did not qualify for this two-worker acceptance test. No worker started; [the report and review](evidence/live-graph-planning-review.json) preserve the failure.

The graph prompt now supplies the exact compiler semantics and allowed values while retaining the same schema and compiler rejection rules. Regression tests cover all observed invalid forms; no generated graph is manually rewritten. Total usage before the next trial is 36 calls and 777220 active milliseconds.

계약 생성·검토는 통과했지만 잘못된 간선·아티팩트·검증 명령 표기로 그래프가 거부됐습니다. 컴파일러는 유지하고 모델에 실제 실행 규칙을 명확히 전달하도록 수정했습니다. 단일 Worker로 축소된 계획을 병렬 그래프 성공으로 처리하지 않았습니다.
