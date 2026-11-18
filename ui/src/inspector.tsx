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
import { type Language, type Translate, useLanguage, useText } from "./locale";
import { VirtualLog } from "./virtual-log";
import { useExplanations, type Explain } from "./explanations";

export type InspectorTab = "work" | "report" | "activity";
const tabs = { work: ["작업", "Work"], report: ["보고", "Reports"], activity: ["활동", "Activity"] } as const;
const activityNames: Record<string, [string, string]> = {
  "node.status": ["작업 상태 변경","Task status changed"],
  "route.selected": ["모델 선택","Model selected"],
  "invocation.started": ["모델 호출 시작","Model call started"],
  "invocation.finished": ["모델 호출 종료","Model call ended"],
  "evidence.saved": ["검증 기록 저장","Evidence saved"],
};

function activityNote(event: Row): string | undefined {
  const payload = event.payload;
  return payload.error || payload.summary || payload.result?.summary ||
    payload.reason || payload.message;
}

function activityDescription(event: Row, t: Translate, language: Language) {
  const payload = event.payload;
  const model = payload.modelId || t("배정된 모델", "the assigned model");
  if (event.type === "node.status") {
    const status = statusLabel(payload.status, language);
    return t(`작업 상태가 ‘${status}’로 바뀌었어요.`, `Task status changed to ${status}.`);
  }
  if (event.type === "invocation.started") return t(`${model}에 작업을 요청했어요.`, `Requested work from ${model}.`);
  if (event.type === "invocation.finished") return t(`${model} 호출이 끝났어요.`, `The call to ${model} finished.`);
  if (event.type === "route.selected") return t(`${model}을 이 작업에 배정했어요.`, `Assigned ${model} to this task.`);
  if (event.type === "evidence.saved") return t("검증에서 확인한 내용을 저장했어요.", "Saved verification evidence.");
  return t("실행 중 발생한 활동을 기록했어요.", "Recorded activity from this run.");
}

function DirectionForm({
  send,
  disabled,
}: {
  send: (instruction: string) => Promise<boolean>;
  disabled: boolean;
}) {
  const t = useText();
  const [instruction, setInstruction] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await send(instruction.trim())) setInstruction("");
  }
  return (
    <form className="direction-form" onSubmit={submit}>
      <label htmlFor="worker-direction">{t("방향 변경", "Change direction")}</label>
      <textarea
        id="worker-direction"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder={t("예를 들어 토글 대신 드롭다운을 사용해 주세요.", "For example, use a dropdown instead of a toggle.")}
        maxLength={4000}
        required
        disabled={disabled}
      />
      <small>{t("승인된 범위와 완료 기준 안에서 방향을 추가할 수 있어요.", "Add directions within the approved scope and completion criteria.")}</small>
      <button disabled={disabled || !instruction.trim()}>{t("변경 적용", "Apply change")}</button>
    </form>
  );
}

export function Inspector({
  spec,
  detail,
  runId,
  project,
  explain,
  easyKorean,
  tab,
  setTab,
  onClose,
  send,
  sending,
}: {
  spec: Row;
  detail?: Row;
  runId: string;
  project: string;
  explain: Explain;
  easyKorean: boolean;
  tab: InspectorTab;
  setTab: (tab: InspectorTab) => void;
  onClose: () => void;
  send?: (instruction: string) => Promise<boolean>;
  sending: boolean;
}) {
  const t = useText();
  const language = useLanguage();
  const position = language === "en" ? 1 : 0;
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
    api(`runs/${runId}/artifacts/${latestId}`, project)
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
  }, [runId, project, latestId]);
  const artifact =
    latestArtifact?.id === latestId ? latestArtifact?.data : undefined;
  const status = detail?.status;
  const tone = statusTone(status);
  const checks: Row[] = artifact?.verifier?.commands ?? [];
  const criteria: string[] = spec.acceptanceCriteria ?? [];
  const latestReport: string | undefined =
    artifact?.summary || detail?.result?.summary || detail?.error;
  const recent = events.slice(-60).reverse();
  const explainDetail = useExplanations(runId, project, easyKorean, [
    { kind: "report", text: artifact?.summary },
    ...checks.map((check) => ({ kind: "check" as const, text: check.command })),
    { kind: "activity", text: detail?.rationale },
    ...recent.map((event) => ({ kind: "activity" as const, text: activityNote(event) })),
  ]);
  const title = nodeTitle(spec);
  const description = spec.direction || criteria[0];
  const easyTitle = explain("title", spec.goal) || title;
  const easyDescription = (spec.direction
    ? explain("description", spec.direction)
    : explain("criterion", criteria[0])) || description;
  const easyReport = (text?: string) =>
    explainDetail("report", text) || explain("report", text) || text;
  const criteriaDone = status === "completed" ? criteria.length : 0;

  function latestUpdate() {
    return (
      latestReport && (
        <div className="agent-report" key={latestReport}>
          <strong data-tone={tone}>
            <span className="lamp" data-tone={tone} />
            {modelLabel({ ...spec, ...detail }, language) || t("실행 결과", "Run result")} ·{" "}
            {statusLabel(status, language)}
          </strong>
          <p title={latestReport}>{easyReport(latestReport)}</p>
        </div>
      )
    );
  }

  return (
    <aside className="inspector" aria-label={t("노드 상세", "Node details")}>
      <div className="inspector-scroll">
        <button
          className="icon-button inspector-close"
          aria-label={t("노드 상세 닫기", "Close node details")}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
        <div className="inspector-heading">
          <div className="eyebrow">{t("노드 상세", "Node details")}&nbsp; / &nbsp;{spec.nodeId}</div>
          <h2 title={title}>{easyTitle}</h2>
          {description && <p title={description}>{easyDescription}</p>}
          <div className="inspector-state" data-tone={tone}>
            <StatusBadge status={status} />
            <strong>
              {status ? statusLabel(status, language) : t("불러오는 중", "Loading")}
              <Elapsed
                startedAt={detail?.startedAt}
                endedAt={detail?.endedAt}
                active={tone === "active"}
              />
            </strong>
            <small>
              {modelLabel({ ...spec, ...detail }, language) || t("모델 배정 전", "No model assigned")}
            </small>
          </div>
        </div>
        <nav className="inspector-tabs" aria-label={t("노드 상세 보기", "Node detail views")}>
          {(Object.keys(tabs) as InspectorTab[]).map((id) => (
            <button
              key={id}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {tabs[id][position]}
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
                <h3>{t("하위 작업", "Subtasks")}</h3>
                {criteria.length > 0 && (
                  <small>
                    {t(`${criteria.length}개 중 ${criteriaDone}개 완료`, `${criteriaDone} of ${criteria.length} complete`)}
                  </small>
                )}
              </div>
              {criteria.map((criterion, index) => (
                <div className="subtask" key={index}>
                  <StatusBadge
                    status={status === "completed" ? status : undefined}
                  />
                  <span title={criterion}>{explain("criterion", criterion) || criterion}</span>
                  <small>{status === "completed" ? t("완료", "Complete") : t("완료 기준", "Completion criteria")}</small>
                </div>
              ))}
              {checks.map((check, index) => (
                <div className="subtask" key={index}>
                  <StatusBadge
                    status={check.exitCode === 0 ? "completed" : "failed"}
                  />
                  <span title={check.command}>{explainDetail("check", check.command) || check.command}</span>
                  <small>{check.exitCode === 0 ? t("통과", "Passed") : t("실패", "Failed")}</small>
                </div>
              ))}
              {!criteria.length && !checks.length && (
                <p>{t("기록된 하위 작업이 없습니다.", "No subtasks recorded.")}</p>
              )}
            </section>
            <section className="inspector-section">
              <h3>{t("이 노드의 보고", "Node reports")}</h3>
              {latestUpdate() || <p>{t("아직 저장된 보고가 없습니다.", "No reports saved yet.")}</p>}
            </section>
            <button className="detail-link" onClick={() => setTab("activity")}>
              <Icon name="activity" />
              {t("활동 기록", "Activity log")}{events.length > 0 && ` ${events.length}`}
            </button>
          </>
        )}
        {tab === "report" && (
          <section className="inspector-section">
            <h3>{t("에이전트 보고", "Agent reports")}</h3>
            {latestUpdate() || <p>{t("아직 저장된 보고가 없습니다.", "No reports saved yet.")}</p>}
            {detail?.result?.summary &&
              detail.result.summary !== latestReport && (
                <p title={detail.result.summary}>{easyReport(detail.result.summary)}</p>
              )}
          </section>
        )}
        {spec.direction && (
          <p className="worker-direction" title={spec.direction}>{easyDescription}</p>
        )}
        {tab === "activity" && (
          <div className="inspector-section activity-list">
            <h3>{t("활동 기록", "Activity log")}</h3>
            {recent.map((event) => {
              const note = activityNote(event);
              const explanation = explainDetail("activity", note);
              return (
                <details key={event.eventId ?? event.seq}>
                  <summary>
                    <Icon name={event.type === "evidence.saved" ? "file" : "tool"} />
                    <span>{explanation || activityNames[event.type]?.[position] || t("활동 기록", "Activity log")}</span>
                    <time>{formatTime(event.timestamp, language)}</time>
                  </summary>
                  <p className="activity-description">
                    {explanation ? activityDescription(event, t, language) : note || activityDescription(event, t, language)}
                  </p>
                  <details>
                    <summary>{t("원문 기록", "Original record")}</summary>
                    <VirtualLog
                      text={JSON.stringify(event.payload, null, 2)}
                      label={t("활동 상세 기록", "Activity details")}
                    />
                  </details>
                </details>
              );
            })}
            {!events.length && <p>{t("아직 저장된 활동이 없습니다.", "No activity saved yet.")}</p>}
            <dl>
              <dt>{t("모델 선택 근거", "Model selection rationale")}</dt>
              <dd title={detail?.rationale}>{explainDetail("activity", detail?.rationale) || detail?.rationale || "—"}</dd>
              <dt>{t("실행 횟수", "Attempts")}</dt>
              <dd>{detail?.iteration ?? "—"}</dd>
              <dt>{t("시작 시각", "Start time")}</dt>
              <dd>{detail?.startedAt ? formatTime(detail.startedAt, language) : "—"}</dd>
            </dl>
          </div>
        )}
        {artifacts.length > 0 && (
          <section className="inspector-section evidence">
            <h3>{t("검증 기록", "Verification records")}</h3>
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
                project={project}
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
              {t("방향 변경", "Change direction")}
            </button>
          )}
        </footer>
      )}
    </aside>
  );
}

function Evidence({
  runId,
  project,
  id,
  saved,
}: {
  runId: string;
  project: string;
  id: string;
  saved?: Row;
}) {
  const t = useText();
  const [artifact, setArtifact] = useState<Row>();
  const [problem, setProblem] = useState("");
  useEffect(() => {
    if (saved) return;
    let current = true;
    api(`runs/${runId}/artifacts/${id}`, project)
      .then((result) => {
        if (current) setArtifact(result);
      })
      .catch((error) => {
        if (current) setProblem(error.message);
      });
    return () => {
      current = false;
    };
  }, [runId, project, id, saved]);
  const evidence = saved ?? artifact;
  if (!evidence) return <p>{problem || t("검증 기록을 불러오는 중입니다.", "Loading verification records…")}</p>;
  return (
    <>
      <details open>
        <summary>{t("검증 결과", "Verification result")}</summary>
        <pre>
          {JSON.stringify(evidence.evaluation ?? evidence.verifier, null, 2)}
        </pre>
      </details>
      <details>
        <summary>{t("파일 변경 내용", "File changes")}</summary>
        <VirtualLog
          text={evidence.diff ?? t("기록된 변경 내용이 없습니다.", "No changes recorded.")}
          label={t("파일 변경 기록", "File change log")}
        />
      </details>
    </>
  );
}
