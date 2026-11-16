import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  api,
  Elapsed,
  formatTime,
  Icon,
  modelLabel,
  nodeTitle,
  StatusBadge,
  statusLabel,
  statusTone,
  type Row,
} from "./presentation";
import { VirtualLog } from "./virtual-log";

export type InspectorTab = "work" | "report" | "activity";
const tabs = { work: "작업", report: "보고", activity: "활동" } as const;
const activityNames: Record<string, string> = {
  "node.status": "작업 상태 변경",
  "route.selected": "모델 선택",
  "invocation.started": "모델 호출 시작",
  "invocation.finished": "모델 호출 종료",
  "evidence.saved": "검증 기록 저장",
};

function DirectionForm({
  send,
  disabled,
}: {
  send: (instruction: string) => Promise<boolean>;
  disabled: boolean;
}) {
  const [instruction, setInstruction] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await send(instruction.trim())) setInstruction("");
  }
  return (
    <form className="direction-form" onSubmit={submit}>
      <label htmlFor="worker-direction">방향 변경</label>
      <textarea
        id="worker-direction"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="예를 들어 토글 대신 드롭다운을 사용해 주세요."
        maxLength={4000}
        required
        disabled={disabled}
      />
      <small>승인된 범위와 완료 기준 안에서 방향을 추가할 수 있어요.</small>
      <button disabled={disabled || !instruction.trim()}>변경 적용</button>
    </form>
  );
}

export function Inspector({
  spec,
  detail,
  runId,
  tab,
  setTab,
  onClose,
  send,
  sending,
}: {
  spec: Row;
  detail?: Row;
  runId: string;
  tab: InspectorTab;
  setTab: (tab: InspectorTab) => void;
  onClose: () => void;
  send?: (instruction: string) => Promise<boolean>;
  sending: boolean;
}) {
  const [latestArtifact, setLatestArtifact] = useState<{
    id: string;
    data: Row;
  }>();
  const [openedEvidence, setOpenedEvidence] = useState("");
  const [problem, setProblem] = useState("");
  const [direction, setDirection] = useState(false);
  const events: Row[] = detail?.events ?? [];
  const artifacts = [
    ...new Set<string>([
      ...(detail?.result?.evidenceIds ?? []),
      ...events
        .filter((event) => event.type === "evidence.saved")
        .map((event) => event.payload.artifactId),
    ]),
  ];
  const latestId = artifacts.at(-1);
  useEffect(() => {
    if (!latestId) return;
    let current = true;
    api(`runs/${runId}/artifacts/${latestId}`)
      .then((result) => {
        if (current) {
          setLatestArtifact({ id: latestId, data: result });
          setProblem("");
        }
      })
      .catch((error) => {
        if (current) setProblem(error.message);
      });
    return () => {
      current = false;
    };
  }, [runId, latestId]);
  const artifact =
    latestArtifact?.id === latestId ? latestArtifact?.data : undefined;
  const status = detail?.status;
  const tone = statusTone(status);
  const checks: Row[] = artifact?.verifier?.commands ?? [];
  const criteria: string[] = spec.acceptanceCriteria ?? [];
  const latestReport: string | undefined =
    artifact?.summary || detail?.result?.summary || detail?.error;
  const recent = events.slice(-60).reverse();
  const title = nodeTitle(spec);
  const description = spec.direction || criteria[0];
  const criteriaDone = status === "completed" ? criteria.length : 0;

  function latestUpdate() {
    return (
      latestReport && (
        <div className="agent-report" key={latestReport}>
          <strong data-tone={tone}>
            <span className="lamp" data-tone={tone} />
            {modelLabel({ ...spec, ...detail }) || "실행 결과"} ·{" "}
            {statusLabel(status)}
          </strong>
          <p title={latestReport}>{latestReport}</p>
        </div>
      )
    );
  }

  return (
    <aside className="inspector" aria-label="노드 상세">
      <div className="inspector-scroll">
        <button
          className="icon-button inspector-close"
          aria-label="노드 상세 닫기"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
        <div className="inspector-heading">
          <div className="eyebrow">노드 상세&nbsp; / &nbsp;{spec.nodeId}</div>
          <h2 title={title}>{title}</h2>
          {description && <p title={description}>{description}</p>}
          <div className="inspector-state" data-tone={tone}>
            <StatusBadge status={status} />
            <strong>
              {status ? statusLabel(status) : "불러오는 중"}
              <Elapsed
                startedAt={detail?.startedAt}
                endedAt={detail?.endedAt}
                active={tone === "active"}
              />
            </strong>
            <small>
              {modelLabel({ ...spec, ...detail }) || "모델 배정 전"}
            </small>
          </div>
        </div>
        <nav className="inspector-tabs" aria-label="노드 상세 보기">
          {(Object.keys(tabs) as InspectorTab[]).map((id) => (
            <button
              key={id}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {tabs[id]}
              {id === "activity" && events.length > 0 && (
                <small>{events.length}</small>
              )}
            </button>
          ))}
        </nav>
        {problem && (
          <p className="inline-error" role="alert">
            {problem}
          </p>
        )}
        {tab === "work" && (
          <>
            <section className="inspector-section">
              <div className="section-heading">
                <h3>하위 작업</h3>
                {criteria.length > 0 && (
                  <small>
                    {criteria.length}개 중 {criteriaDone}개 완료
                  </small>
                )}
              </div>
              {criteria.map((criterion, index) => (
                <div className="subtask" key={index}>
                  <StatusBadge
                    status={status === "completed" ? status : undefined}
                  />
                  <span title={criterion}>{criterion}</span>
                  <small>{status === "completed" ? "완료" : "완료 기준"}</small>
                </div>
              ))}
              {checks.map((check, index) => (
                <div className="subtask" key={index}>
                  <StatusBadge
                    status={check.exitCode === 0 ? "completed" : "failed"}
                  />
                  <span title={check.command}>{check.command}</span>
                  <small>{check.exitCode === 0 ? "통과" : "실패"}</small>
                </div>
              ))}
              {!criteria.length && !checks.length && (
                <p>기록된 하위 작업이 없습니다.</p>
              )}
            </section>
            <section className="inspector-section">
              <h3>이 노드의 보고</h3>
              {latestUpdate() || <p>아직 저장된 보고가 없습니다.</p>}
            </section>
            <button className="detail-link" onClick={() => setTab("activity")}>
              <Icon name="activity" />
              활동 기록{events.length > 0 && ` ${events.length}`}
            </button>
          </>
        )}
        {tab === "report" && (
          <section className="inspector-section">
            <h3>에이전트 보고</h3>
            {latestUpdate() || <p>아직 저장된 보고가 없습니다.</p>}
            {detail?.result?.summary &&
              detail.result.summary !== latestReport && (
                <p title={detail.result.summary}>{detail.result.summary}</p>
              )}
          </section>
        )}
        {spec.direction && (
          <p className="worker-direction" title={spec.direction}>{description}</p>
        )}
        {tab === "activity" && (
          <div className="inspector-section activity-list">
            <h3>활동 기록</h3>
            {recent.map((event) => (
              <details key={event.eventId ?? event.seq}>
                <summary>
                  <Icon name={event.type === "evidence.saved" ? "file" : "tool"} />
                  <span>{activityNames[event.type] ?? event.type}</span>
                  <time>{formatTime(event.timestamp)}</time>
                </summary>
                <VirtualLog
                  text={JSON.stringify(event.payload, null, 2)}
                  label="활동 상세 기록"
                />
              </details>
            ))}
            {!events.length && <p>아직 저장된 활동이 없습니다.</p>}
            <dl>
              <dt>모델 선택 근거</dt>
              <dd title={detail?.rationale}>{detail?.rationale ?? "—"}</dd>
              <dt>실행 횟수</dt>
              <dd>{detail?.iteration ?? "—"}</dd>
              <dt>시작 시각</dt>
              <dd>{detail?.startedAt ? formatTime(detail.startedAt) : "—"}</dd>
            </dl>
          </div>
        )}
        {artifacts.length > 0 && (
          <section className="inspector-section evidence">
            <h3>검증 기록</h3>
            {artifacts.map((id) => (
              <button
                key={id}
                aria-label={`Inspect ${id.slice(0, 12)}`}
                aria-expanded={openedEvidence === id}
                onClick={() => {
                  if (openedEvidence === id) {
                    setOpenedEvidence("");
                    return;
                  }
                  setOpenedEvidence(id);
                }}
              >
                <Icon name="file" />
                {id.slice(0, 12)}
              </button>
            ))}
            {openedEvidence && (
              <Evidence
                key={openedEvidence}
                runId={runId}
                id={openedEvidence}
                saved={openedEvidence === latestId ? artifact : undefined}
              />
            )}
          </section>
        )}
      </div>
      {send && (
        <footer className="inspector-footer">
          {direction ? (
            <DirectionForm send={send} disabled={sending} />
          ) : (
            <button onClick={() => setDirection(true)}>
              <Icon name="branch-direction" />
              방향 변경
            </button>
          )}
        </footer>
      )}
    </aside>
  );
}

function Evidence({
  runId,
  id,
  saved,
}: {
  runId: string;
  id: string;
  saved?: Row;
}) {
  const [artifact, setArtifact] = useState<Row>();
  const [problem, setProblem] = useState("");
  useEffect(() => {
    if (saved) return;
    let current = true;
    api(`runs/${runId}/artifacts/${id}`)
      .then((result) => {
        if (current) setArtifact(result);
      })
      .catch((error) => {
        if (current) setProblem(error.message);
      });
    return () => {
      current = false;
    };
  }, [runId, id, saved]);
  const evidence = saved ?? artifact;
  if (!evidence) return <p>{problem || "검증 기록을 불러오는 중입니다."}</p>;
  return (
    <>
      <details open>
        <summary>검증 결과</summary>
        <pre>
          {JSON.stringify(evidence.evaluation ?? evidence.verifier, null, 2)}
        </pre>
      </details>
      <details>
        <summary>파일 변경 내용</summary>
        <VirtualLog
          text={evidence.diff ?? "기록된 변경 내용이 없습니다."}
          label="파일 변경 기록"
        />
      </details>
    </>
  );
}
