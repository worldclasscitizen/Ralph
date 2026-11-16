# Dashboard and event API

Run `ralph dashboard --open` inside a configured project. The HTTP server binds to 127.0.0.1; the npm package includes built React/TypeScript/React Flow assets and ELK. No frontend development server is required by users. Developers edit `ui/src` and run `npm run build:ui`.

## Interaction

Find and switch sessions in the sidebar. Completed sessions keep their last graph. Scroll over the graph to zoom at the pointer, drag the background to pan, and use the zoom controls to fit the whole graph. The sidebar footer switches between light and dark themes. Open **이전 그래프 보기** in the run menu to inspect graph history.

Select a node to see its work, reports, and recorded activity. The **보고** button collects node results and notices that need attention. **사용량·한도** shows reported balances or limits and opens detailed model usage. The dashboard includes Galmuri11 as a local web font.

During a run, select a worker and use **방향 변경** to adjust its instructions within the approved scope and completion criteria. Ralph waits for affected work to reach a checkpoint, starts new generations for the affected nodes, and reuses independent completed results. The dashboard lists updated nodes and reused work. If a direction requires broader approval or a worker has exhausted its iteration budget, review a new plan.

In the run menu, **취소하고 변경 되돌리기** stops a run before delivery and removes its isolated worktrees and checkpoint refs while keeping the execution history. **안전하게 중지** keeps partial work for resumption. Discard applies to Ralph's local Git workspaces. External effects depend on what the project and provider executed.

## HTTP v2

| Method and path | Response |
|---|---|
| GET /api/v2/runs?offset=0&limit=30 | Paginated runs, total and project name |
| GET /api/v2/runs/:id | Projection with last applied seq |
| GET /api/v2/runs/:id?revision=1 | Historical projection |
| GET /api/v2/runs/:id/graph?revision=1 | Graph revision |
| GET /api/v2/runs/:id/nodes/:nodeId?revision=1 | Node generation and events |
| GET /api/v2/runs/:id/events?after=42 | SSE events after seq 42 |
| GET /api/v2/runs/:id/artifacts/:sha256 | Integrity-checked sanitized artifact |
| POST /api/v2/runs/:id/commands | Idempotent command submission |
| GET /api/v2/providers | Configured connection support status |
| GET /api/v2/metrics | Per-connection/model usage projection |
| GET /api/v2/session | Local control token |

SSE uses `event: ralph` and sequence numbers as IDs. `Last-Event-ID` overrides the query cursor. The client first loads a snapshot, then opens the stream from its seq, so reconnects can recover intervening events. Slow streams close when the transport buffer fills; clients reconnect by cursor. Usage projections deduplicate attempt IDs.

Commands include `commandId`, `expectedRevision`, and a type (`stop`, `cancel`, `resume`, `approve_final`, `note`, `steer`, `discard`). A `steer` command also includes `nodeId` and `instruction`. Reusing an ID with a different payload returns conflict; the same payload is idempotent. A stale new command returns 409. Commands are submitted as durable files; only the owning supervisor applies execution-state changes. Initial plan approval and clarification currently use the CLI/library, not this HTTP command set.

POST requires `X-Ralph-Token` from the same-origin session endpoint. Both legacy and v2 handlers check Origin; the server rejects non-loopback Host values. Artifacts are addressed by validated IDs, never arbitrary filesystem paths. Logs are local and may contain project-specific evidence; a control token is not multi-user authentication.

## Verification

`npm run test:e2e` starts a mock-provider run in a temporary Git project, then exercises the real packaged dashboard with Chromium. `tests/graph-api.test.ts` verifies SSE cursors, protected writes, duplicate commands, artifact path rejection and metrics. Screenshots under `test-results` are generated evidence, not hand-drawn mockups.
