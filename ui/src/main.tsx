import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { RunGraph } from "./graph";
import { Inspector, type InspectorTab } from "./inspector";
import { Metrics, type ProviderRow } from "./metrics";
import { Capacity, useCapacity } from "./capacity";
import { LanguageContext, type Language, useText } from "./locale";
import { Settings, type Theme } from "./settings";
import {
  api,
  formatTime,
  Icon,
  nodeTitle,
  StatusBadge,
  statusLabel,
  statusTone,
  type Row,
} from "./presentation";
import { projectEvent } from "./projection";
import { useExplanations } from "./explanations";

type View = "runs" | "metrics";
type Panel = "inbox" | "capacity" | "commands";
type Report = {
  id: string;
  runId: string;
  nodeId?: string;
  goal: string;
  text: string;
  timestamp: string;
  urgent: boolean;
};

const themes = [
  { key: "light", icon: "sun", label: "라이트", english: "Light" },
  { key: "dark", icon: "moon", label: "다크", english: "Dark" },
] as const;

function reportsFor(runs: Row[]): Report[] {
  return runs
    .flatMap((run) => {
      const reports: Report[] = Object.entries<Row>(run.nodes ?? {}).flatMap(
        ([id, node]) => {
          const text = node.error || node.result?.summary;
          const timestamp = node.endedAt;
          if (!text || !timestamp) return [];
          return [
            {
              id: `${run.runId}/${id}/${node.generation}/${timestamp}`,
              runId: run.runId,
              nodeId: id,
              goal: run.goal || run.runId,
              text,
              timestamp,
              urgent: statusTone(node.status) === "error",
            },
          ];
        },
      );
      if (
        run.message &&
        run.updatedAt &&
        ["failed", "paused", "awaiting_input"].includes(run.status)
      ) {
        reports.push({
          id: `${run.runId}/status/${run.status}/${String(run.message).slice(0, 200)}`,
          runId: run.runId,
          goal: run.goal || run.runId,
          text: run.message,
          timestamp: run.updatedAt,
          urgent: true,
        });
      }
      return reports;
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function savedReports(): string[] {
  try {
    const stored = JSON.parse(
      localStorage.getItem("ralph.dashboard.readReports") ?? "[]",
    );
    return Array.isArray(stored)
      ? stored.filter((id) => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function Dashboard() {
  const [language, setLanguage] = useState<Language>(() =>
    localStorage.getItem("ralph.dashboard.language") === "en" ? "en" : "ko",
  );
  useEffect(() => {
    document.documentElement.lang = language;
    localStorage.setItem("ralph.dashboard.language", language);
  }, [language]);
  return (
    <LanguageContext.Provider value={language}>
      <App language={language} setLanguage={setLanguage} />
    </LanguageContext.Provider>
  );
}

function App({ language, setLanguage }: {
  language: Language;
  setLanguage: (language: Language) => void;
}) {
  const t = useText();
  const capacity = useCapacity();
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const [runs, setRuns] = useState<Row[]>([]);
  const [project, setProject] = useState("");
  const [selected, setSelected] = useState("");
  const [view, setView] = useState<View>("runs");
  const [panel, setPanel] = useState<Panel>();
  const [run, setRun] = useState<Row>();
  const [graph, setGraph] = useState<Row>();
  const [node, setNode] = useState("");
  const [detail, setDetail] = useState<Row>();
  const [tab, setTab] = useState<InspectorTab>("work");
  const [metrics, setMetrics] = useState<Row[]>();
  const [providers, setProviders] = useState<ProviderRow[]>();
  const [metricsFailed, setMetricsFailed] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState("latest");
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem("ralph.dashboard.theme") === "dark" ? "dark" : "light",
  );
  const [notify, setNotify] = useState(
    () => localStorage.getItem("ralph.dashboard.notify") !== "off",
  );
  const [readReports, setReadReports] = useState(savedReports);
  const [easyKorean, setEasyKorean] = useState(
    () => localStorage.getItem("ralph.dashboard.easyKorean") !== "off",
  );
  const [toast, setToast] = useState<Report>();
  const [directionRequest, setDirectionRequest] = useState<{
    runId: string;
    commandId: string;
  }>();
  const [sendingDirection, setSendingDirection] = useState(false);
  const [discardRequest, setDiscardRequest] = useState<{
    runId: string;
    commandId: string;
  }>();
  const [sendingDiscard, setSendingDiscard] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const knownReports = useRef<Set<string>>(null);
  const loadRuns = useCallback(
    () =>
      api("runs")
        .then(({ runs, projectName }) => {
          setRuns(runs);
          setProject(projectName ?? "");
        })
        .catch((error) => setError(error.message)),
    [],
  );

  useEffect(() => {
    void loadRuns();
    const timer = setInterval(loadRuns, 3000);
    return () => clearInterval(timer);
  }, [loadRuns]);
  useEffect(() => {
    const first = runs.find((run) => !run.legacy);
    if (!selected && first) setSelected(first.runId);
  }, [runs, selected]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("ralph.dashboard.theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("ralph.dashboard.notify", notify ? "on" : "off");
  }, [notify]);
  useEffect(() => {
    localStorage.setItem("ralph.dashboard.easyKorean", easyKorean ? "on" : "off");
  }, [easyKorean]);
  useEffect(() => {
    localStorage.setItem(
      "ralph.dashboard.readReports",
      JSON.stringify(readReports),
    );
  }, [readReports]);
  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k")
        return;
      event.preventDefault();
      searchInput.current?.focus();
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  useEffect(() => {
    if (view !== "metrics") return;
    let current = true;
    setMetricsFailed(false);
    Promise.all([api("metrics"), api("providers")])
      .then(([metrics, providers]) => {
        if (!current) return;
        setMetrics(metrics);
        setProviders(providers);
      })
      .catch(() => {
        if (current) setMetricsFailed(true);
      });
    return () => {
      current = false;
    };
  }, [view]);

  useEffect(() => {
    if (!selected) return;
    let stream: EventSource | undefined;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    const query = revision === "latest" ? "" : `?revision=${revision}`;
    const refresh = async () => {
      const [snapshot, topology] = await Promise.all([
        api(`runs/${selected}${query}`),
        api(`runs/${selected}/graph${query}`),
      ]);
      if (cancelled || snapshot.seq < cursor) return;
      cursor = snapshot.seq;
      setRun(snapshot);
      setGraph((current) =>
        current?.runId === topology.runId &&
        current?.revision === topology.revision
          ? current
          : topology,
      );
    };
    const recover = () => {
      if (!cancelled && !refreshTimer)
        refreshTimer = setTimeout(() => {
          refreshTimer = undefined;
          refresh().catch((error) => {
            if (!cancelled) setError(error.message);
          });
        }, 100);
    };
    refresh()
      .then(() => {
        if (cancelled || revision !== "latest") return;
        stream = new EventSource(
          `/api/v2/runs/${selected}/events?after=${cursor}`,
        );
        stream.addEventListener("ralph", (message) => {
          const event = JSON.parse((message as MessageEvent).data);
          if (cancelled || event.seq <= cursor) return;
          if (event.seq > cursor + 1) {
            recover();
            return;
          }
          cursor = event.seq;
          setRun((current) =>
            current?.runId === selected
              ? projectEvent(current, event)
              : current,
          );
          if (event.type === "graph.revised") setGraph(event.payload.graph);
        });
        stream.onerror = recover;
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
      stream?.close();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [selected, revision]);

  const currentRun = run?.runId === selected ? run : undefined;
  const currentGraph =
    graph?.runId === selected &&
    (revision === "latest" || graph?.revision === Number(revision))
      ? graph
      : undefined;
  const specs: Row[] = currentGraph?.nodes ?? [];
  const explain = useExplanations(selected, easyKorean && language === "ko" && view === "runs", [
    ...specs.map((spec) => ({ kind: "title" as const, text: spec.goal })),
    ...specs.flatMap((spec) => [
      { kind: "description" as const, text: spec.direction },
      ...(spec.acceptanceCriteria ?? []).map((text: string) => ({ kind: "criterion" as const, text })),
    ]),
    ...Object.values<Row>(currentRun?.nodes ?? {}).map((entry) => ({
      kind: "report" as const,
      text: entry.error || entry.result?.summary,
    })),
    { kind: "report", text: currentRun?.latestRecovery?.diagnosis },
    { kind: "report", text: currentRun?.message },
  ]);
  const selectedRun = runs.find((item) => item.runId === selected);
  const inspected = currentGraph?.nodes.find(
    (entry: Row) => entry.nodeId === node,
  );
  useEffect(() => {
    if (!node || !selected) return;
    let current = true;
    const query = revision === "latest" ? "" : `?revision=${revision}`;
    api(`runs/${selected}/nodes/${node}${query}`)
      .then((data) => {
        if (current) setDetail(data);
      })
      .catch((error) => {
        if (current) setError(error.message);
      });
    return () => {
      current = false;
    };
  }, [node, selected, revision, currentRun?.seq]);

  const allReports = useMemo(() => {
    const sessions = runs.map((entry) =>
      entry.runId === currentRun?.runId && revision === "latest" && currentRun
        ? { ...entry, ...currentRun }
        : entry,
    );
    return reportsFor(sessions);
  }, [runs, currentRun, revision]);
  const read = useMemo(() => new Set(readReports), [readReports]);
  const unread = allReports.filter((report) => !read.has(report.id));
  useEffect(() => {
    if (!runs.length) return;
    if (knownReports.current && notify) {
      const incoming = allReports.find(
        (report) => report.urgent && !knownReports.current?.has(report.id),
      );
      if (incoming) setToast(incoming);
      else setToast((current) =>
        current && allReports.some((report) => report.id === current.id && report.urgent)
          ? current
          : undefined,
      );
    }
    knownReports.current = new Set(allReports.map((report) => report.id));
  }, [allReports, runs.length, notify]);

  const closeNode = useCallback(() => {
    setNode("");
    setDetail(undefined);
  }, []);
  const inspect = useCallback((id: string) => {
    setDetail(undefined);
    setTab("work");
    setNode((previous) => (previous === id ? "" : id));
  }, []);
  function changeView(next: View) {
    setPanel(undefined);
    setView(next);
  }
  function choose(entry: Row) {
    if (entry.legacy) {
      setError(
        t("이전 버전 실행 기록은 ralph history 또는 마이그레이션에서 확인할 수 있습니다.", "Use ralph history or migrate this run to view its record."),
      );
      return;
    }
    setSelected(entry.runId);
    setRevision("latest");
    closeNode();
    changeView("runs");
  }
  function openReport(report: Report) {
    setReadReports((previous) =>
      [...new Set([...previous, report.id])].slice(-1000),
    );
    setToast(undefined);
    if (
      selected !== report.runId ||
      node !== report.nodeId ||
      revision !== "latest"
    )
      setDetail(undefined);
    setSelected(report.runId);
    setRevision("latest");
    setNode(report.nodeId ?? "");
    setTab("report");
    changeView("runs");
  }
  const discardId =
    discardRequest?.runId === selected ? discardRequest?.commandId : undefined;
  const discardResult = discardId
    ? currentRun?.commands?.[discardId]
    : undefined;
  const pendingDirection =
    directionRequest?.runId === selected ? directionRequest : undefined;
  const directionResult =
    pendingDirection && currentRun?.commands?.[pendingDirection.commandId];
  async function command(
    type: string,
    fields?: { nodeId: string; instruction: string },
  ) {
    try {
      const { controlToken } = await api("session");
      const response = await fetch(`/api/v2/runs/${selected}/commands`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ralph-Token": controlToken,
        },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          expectedRevision: currentRun?.revision,
          type,
          ...fields,
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      const submitted = await response.json();
      if (fields)
        setDirectionRequest({
          runId: selected,
          commandId: submitted.commandId,
        });
      if (type === "discard")
        setDiscardRequest({ runId: selected, commandId: submitted.commandId });
      void loadRuns();
      return true;
    } catch (error) {
      setError(String(error));
      return false;
    }
  }
  const togglePanel = (next: Panel) =>
    setPanel((current) => (current === next ? undefined : next));
  const state = currentRun?.status ?? selectedRun?.status;
  const latest = revision === "latest";
  const nodeRows: Row[] = currentGraph?.nodes ?? [];
  const progress = nodeRows.map((task) =>
    statusTone(currentRun?.nodes?.[task.nodeId]?.status),
  );
  const done = progress.filter((tone) => tone === "done").length;
  const lastNode = nodeRows
    .map((spec) => ({ spec, info: currentRun?.nodes?.[spec.nodeId] }))
    .filter(({ info }) => info?.endedAt)
    .sort((a, b) => b.info.endedAt.localeCompare(a.info.endedAt))[0];
  const lastTime = lastNode?.info.endedAt ?? currentRun?.updatedAt;
  const candidates = runs.filter((entry) =>
    `${entry.goal ?? ""} ${entry.runId} ${project}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const showDirection =
    latest &&
    currentRun?.status === "running" &&
    inspected?.kind === "worker" &&
    !nodeRows.some((entry) => entry.nodeId === "repair");

  return (
    <div
      className="shell"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (panel) setPanel(undefined);
        else closeNode();
      }}
    >
      <aside className="sidebar" aria-label={t("세션", "Sessions")}>
        <div className="brand">Ralph Dashboard</div>
        <label className="session-search">
          <Icon name="search" />
          <input
            ref={searchInput}
            type="search"
            aria-label={t("세션 찾기", "Find a session")}
            placeholder={t("세션 찾기", "Find a session")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {!search && <kbd>⌘ K</kbd>}
        </label>
        <div className="sidebar-title">
          <strong>{t("세션", "Sessions")}</strong>
          <span>{String(candidates.length).padStart(2, "0")}</span>
        </div>
        <nav className="run-list" aria-label={t("실행 세션", "Run sessions")}>
          {candidates.map((entry) => {
            const count = unread.filter(
              (report) => report.runId === entry.runId,
            ).length;
            const active = selected === entry.runId && view === "runs";
            const sessionStatus =
              selected === entry.runId ? (state ?? entry.status) : entry.status;
            return (
              <button
                key={entry.runId}
                className="run-item"
                aria-current={active ? "true" : undefined}
                onClick={() => choose(entry)}
              >
                <span
                  className="lamp"
                  data-tone={statusTone(sessionStatus)}
                  title={statusLabel(sessionStatus, language)}
                />
                <span className="run-name">
                  <strong>{entry.goal ?? entry.runId}</strong>
                  <small>
                    {entry.legacy ? t("이전 버전", "Legacy") : project || entry.runId}
                  </small>
                </span>
                {count > 0 && (
                  <span
                    className="count"
                    aria-label={t(`읽지 않은 보고 ${count}개`, `${count} unread reports`)}
                  >
                    {count}
                  </span>
                )}
                {active && <Icon name="chevron" />}
              </button>
            );
          })}
          {search && !candidates.length && (
            <p className="no-sessions">{t("일치하는 세션이 없습니다.", "No matching sessions.")}</p>
          )}
        </nav>
        <footer className="sidebar-footer">
          <button
            className="settings-button"
            aria-haspopup="dialog"
            onClick={() => settingsDialog.current?.showModal()}
          >
            <Icon name="settings" />
            {t("설정", "Settings")}
          </button>
          <div className="theme-switch" role="group" aria-label={t("화면 테마", "Theme")}>
            {themes.map((option) => (
              <button
                key={option.key}
                title={t(option.label, option.english)}
                aria-label={t(`${option.label} 테마`, `${option.english} theme`)}
                aria-pressed={theme === option.key}
                onClick={() => setTheme(option.key)}
              >
                <Icon name={option.icon} />
              </button>
            ))}
          </div>
        </footer>
      </aside>
      <main>
        <header className="session-header">
          <div className="eyebrow">
            {view === "runs"
              ? `${project ? project + "  /  " : ""}${t("작업 공간", "Workspace")}`
              : `Ralph Dashboard  /  ${t("사용량·한도", "Usage & limits")}`}
          </div>
          <h1 title={selectedRun?.goal}>
            {view === "metrics"
              ? t("사용 내역", "Usage")
              : (selectedRun?.goal ?? t("실행 세션", "Run sessions"))}
          </h1>
          <div className="session-actions">
            {view === "runs" ? (
              <>
                <button
                  className="reports-button"
                  data-unread={unread.length > 0}
                  aria-expanded={panel === "inbox"}
                  onClick={() => togglePanel("inbox")}
                >
                  <Icon name="inbox" />
                  {t("보고", "Reports")}
                  {unread.length > 0 && (
                    <span className="count">{unread.length}</span>
                  )}
                </button>
                <button
                  className="capacity-button"
                  aria-expanded={panel === "capacity"}
                  onClick={() => togglePanel("capacity")}
                >
                  <Icon name="wallet" />
                  {t("사용량·한도", "Usage & limits")}
                </button>
              </>
            ) : (
              <button
                className="back-button"
                onClick={() => changeView("runs")}
              >
                {t("작업 화면으로", "Back to work")}
              </button>
            )}
          </div>
          {view === "runs" && (
            <div className="session-progress">
              {state && (
                <span className="live-state" data-tone={statusTone(state)}>
                  <span className="lamp" data-tone={statusTone(state)} />
                  {latest && state === "running"
                    ? t("실시간", "Live")
                    : statusLabel(state, language)}
                </span>
              )}
              {progress.length > 0 && (
                <>
                  <span className="completed-count">
                    {t(`${progress.length}개 중 ${done}개 완료`, `${done} of ${progress.length} complete`)}
                  </span>
                  <div
                    className="progress-lamps"
                    data-dense={progress.length > 12}
                    aria-label={t("작업 상태 표시등", "Task status indicators")}
                  >
                    {progress.map((tone, index) => (
                      <span
                        key={nodeRows[index].nodeId}
                        className="lamp"
                        data-tone={tone}
                        title={`${explain("title", nodeRows[index].goal) || nodeTitle(nodeRows[index])} · ${statusLabel(currentRun?.nodes?.[nodeRows[index].nodeId]?.status, language)}`}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </header>
        {error && (
          <div className="alert" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label={t("오류 닫기", "Dismiss error")}
              onClick={() => setError("")}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        {view === "metrics" && (
          <Metrics
            providers={providers}
            metrics={metrics}
            failed={metricsFailed}
            capacity={capacity}
          />
        )}
        <div className="run-body" hidden={view !== "runs"}>
          <div className="graph-column">
            <RunGraph
              key={`${selected}/${revision}`}
              graph={currentGraph}
              run={currentRun}
              explain={explain}
              inspected={node}
              onInspect={inspect}
              onClose={closeNode}
            />
            {currentRun?.message && (
              <div className="notice">
                {explain("report", currentRun.message) || currentRun.message}
                {latest && currentRun.message.includes("T3") && (
                  <button onClick={() => command("approve_final")}>
                    {t("최종 결과 확인", "Review final result")}
                  </button>
                )}
              </div>
            )}
            {latest && discardId && !discardResult && (
              <div role="status" className="notice">
                {state === "running"
                  ? t("작업 취소와 변경 되돌리기를 요청했습니다.", "Requested cancellation and rollback.")
                  : t("요청을 처리하기 전에 실행이 끝났거나 일시 정지됐습니다.", "The run finished or paused before the request was processed.")}
              </div>
            )}
            {latest && discardResult?.error && (
              <div role="alert" className="notice">
                {discardResult.error}
              </div>
            )}
            {latest && pendingDirection && !directionResult && (
              <div role="status" className="notice">
                {state === "running"
                  ? t("방향 변경을 요청했습니다. 관련 작업이 안전하게 멈출 수 있는 지점까지 기다리는 중입니다.", "Direction change requested. Waiting for the affected work to reach a safe stopping point.")
                  : t("방향을 바꾸기 전에 실행이 끝났거나 일시 정지됐습니다.", "The run finished or paused before the direction could change.")}
              </div>
            )}
            {latest && directionResult?.error && (
              <div role="alert" className="notice">
                {directionResult.error}
              </div>
            )}
            {latest && currentRun?.latestRecovery && (
              <div className="notice">
                <span>
                  {t(`${currentRun.latestRecovery.nodeId} 복구`, `Recovered ${currentRun.latestRecovery.nodeId}`)} ·{" "}
                  {explain("report", currentRun.latestRecovery.diagnosis) || currentRun.latestRecovery.diagnosis}
                  {currentRun.latestRecovery.reused.length > 0 &&
                    t(` · 완료 노드 ${currentRun.latestRecovery.reused.length}개 재사용`, ` · Reused ${currentRun.latestRecovery.reused.length} completed nodes`)}
                </span>
              </div>
            )}
            {latest && currentRun?.latestDirection && (
              <div role="status" className="notice">
                {t(
                  `${currentRun.latestDirection.nodeId}의 방향을 바꿨어요. 변경된 작업 ${currentRun.latestDirection.rerun.join(", ")}.`,
                  `Updated the direction for ${currentRun.latestDirection.nodeId}. Affected tasks: ${currentRun.latestDirection.rerun.join(", ")}.`,
                )}
                {currentRun.latestDirection.reused.length > 0 &&
                  t(` 다시 사용한 작업 ${currentRun.latestDirection.reused.join(", ")}.`, ` Reused tasks: ${currentRun.latestDirection.reused.join(", ")}.`)}
              </div>
            )}
            <footer className="run-footer">
              <div className="last-event">
                <StatusBadge status={lastNode?.info.status ?? state} footer />
                <span>
                  <strong>
                    {lastNode
                      ? `${explain("title", lastNode.spec.goal) || nodeTitle(lastNode.spec)} · ${statusLabel(lastNode.info.status, language)}`
                      : state
                        ? statusLabel(state, language)
                        : t("아직 실행 기록이 없습니다", "No runs yet")}
                  </strong>
                  {lastTime && (
                    <small>
                      {formatTime(lastTime, language)}
                      {currentRun?.resultHead && t(" · 결과 저장됨", " · Result saved")}
                    </small>
                  )}
                </span>
              </div>
              {selected && (
                <button
                  className="run-menu"
                  title={t("실행 메뉴", "Run menu")}
                  aria-expanded={panel === "commands"}
                  aria-label={t("실행 메뉴", "Run menu")}
                  onClick={() => togglePanel("commands")}
                >
                  <Icon name="branch" />
                  <span>{selected.slice(0, 12)}</span>
                </button>
              )}
            </footer>
          </div>
          {inspected && (
            <Inspector
              explain={explain}
              easyKorean={easyKorean && language === "ko" && view === "runs"}
              key={`${selected}/${node}/${revision}`}
              spec={inspected}
              detail={detail ?? currentRun?.nodes?.[node]}
              runId={selected}
              tab={tab}
              setTab={setTab}
              onClose={closeNode}
              sending={
                sendingDirection ||
                Boolean(pendingDirection && !directionResult)
              }
              send={
                showDirection
                  ? async (instruction) => {
                      setSendingDirection(true);
                      try {
                        return await command("steer", {
                          nodeId: node,
                          instruction,
                        });
                      } finally {
                        setSendingDirection(false);
                      }
                    }
                  : undefined
              }
            />
          )}
        </div>
        {panel && (
          <div className="panel-dismiss" onClick={() => setPanel(undefined)} />
        )}
        {panel === "capacity" && (
          <Capacity
            capacity={capacity}
            onClose={() => setPanel(undefined)}
            onMetrics={() => changeView("metrics")}
          />
        )}
        {panel === "inbox" && (
          <section className="popover inbox" aria-label={t("보고 센터", "Reports")}>
            <button
              className="icon-button popover-close"
              aria-label={t("보고 센터 닫기", "Close reports")}
              onClick={() => setPanel(undefined)}
            >
              <Icon name="close" />
            </button>
            <h2>
              {t("보고 센터", "Reports")}{" "}
              {unread.length > 0 && (
                <span className="count">{unread.length}</span>
              )}
            </h2>
            <p>
              {unread.length
                ? t(`읽지 않은 보고 ${unread.length}개`, `${unread.length} unread reports`)
                : t("읽지 않은 보고가 없습니다.", "No unread reports.")}
            </p>
            <div className="report-list">
              {allReports.slice(0, 30).map((report) => (
                <button
                  className="report-entry"
                  key={report.id}
                  data-unread={!read.has(report.id)}
                  onClick={() => openReport(report)}
                >
                  <span
                    className="lamp"
                    data-tone={report.urgent ? "error" : "done"}
                  />
                  <span>
                    <strong>
                      {report.goal}
                      {report.nodeId && ` · ${report.nodeId}`}
                    </strong>
                    <small title={report.text}>{explain("report", report.text) || report.text}</small>
                  </span>
                  <time>{formatTime(report.timestamp, language)}</time>
                </button>
              ))}
            </div>
            {unread.length > 0 && (
              <button
                onClick={() =>
                  setReadReports((previous) =>
                    [
                      ...new Set([
                        ...previous,
                        ...unread.map((report) => report.id),
                      ]),
                    ].slice(-1000),
                  )
                }
              >
                {t("모두 읽음", "Mark all as read")}
              </button>
            )}
          </section>
        )}
        {panel === "commands" && (
          <section className="popover commands" aria-label={t("실행 메뉴", "Run menu")}>
            <h2>{t("실행 메뉴", "Run menu")}</h2>
            <label>
              {t("이전 그래프 보기", "View earlier graphs")}
              <select
                aria-label={t("그래프 이력", "Graph history")}
                value={revision}
                onChange={(event) => {
                  setRevision(event.target.value);
                  closeNode();
                }}
              >
                <option value="latest">{t("최신 그래프", "Latest graph")}</option>
                {Array.from(
                  {
                    length: currentRun?.revision ?? selectedRun?.revision ?? 1,
                  },
                  (_, index) => (
                    <option key={index + 1} value={String(index + 1)}>
                      {t(`변경 이력 ${index + 1}`, `Revision ${index + 1}`)}
                    </option>
                  ),
                )}
              </select>
            </label>
            <button
              onClick={() => command("stop")}
              disabled={!latest || state !== "running"}
            >
              {t("안전하게 중지", "Stop safely")}
            </button>
            <button
              onClick={() => command("resume")}
              disabled={
                !latest ||
                !["paused", "awaiting_input", "failed"].includes(state)
              }
            >
              {t("다시 실행", "Run again")}
            </button>
            <button
              onClick={async () => {
                setSendingDiscard(true);
                try {
                  await command("discard");
                } finally {
                  setSendingDiscard(false);
                }
              }}
              disabled={
                !latest ||
                state !== "running" ||
                sendingDiscard ||
                Boolean(discardId && !discardResult?.error) ||
                !nodeRows.some((entry) => entry.kind === "worker")
              }
            >
              {t("취소하고 변경 되돌리기", "Cancel and roll back")}
            </button>
            <small>
              {t(
                `모델 호출 ${currentRun?.attempts ?? 0}회 · 실행 ${Math.round((currentRun?.activeMs ?? 0) / 1000)}초`,
                `${currentRun?.attempts ?? 0} model calls · ${Math.round((currentRun?.activeMs ?? 0) / 1000)}s active`,
              )}
            </small>
          </section>
        )}
        {notify && toast && view === "runs" && (
          <div className="report-toast">
            <button onClick={() => openReport(toast)}>
              <Icon name="inbox" />
              <span>
                {t("확인이 필요한 보고", "Report needs attention")}<strong>{toast.goal}</strong>
              </span>
            </button>
            <button
              className="icon-button"
              aria-label={t("알림 닫기", "Dismiss notification")}
              onClick={() => setToast(undefined)}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
      </main>
      <Settings
        dialog={settingsDialog}
        language={language}
        setLanguage={setLanguage}
        theme={theme}
        setTheme={setTheme}
        easyKorean={easyKorean}
        setEasyKorean={setEasyKorean}
        notify={notify}
        setNotify={setNotify}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Dashboard />);
