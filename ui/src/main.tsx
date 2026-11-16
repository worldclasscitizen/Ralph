import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { RunGraph } from "./graph";
import { Inspector, type InspectorTab } from "./inspector";
import { Metrics } from "./metrics";
import {
  api,
  dashboardGet,
  formatTime,
  Icon,
  nodeTitle,
  StatusBadge,
  statusLabel,
  statusTone,
  type Row,
} from "./presentation";
import { projectEvent } from "./projection";

type Theme = "light" | "dark";
type View = "runs" | "settings" | "metrics";
type Panel = "inbox" | "capacity" | "commands";
type CapacitySnapshot = {
  status: "exact" | "unavailable" | "auth_required" | "stale";
  detail?: string;
} & (
  | {
      kind: "subscription";
      windows?: {
        label: string;
        remainingPercent: number;
        resetsAt?: string;
      }[];
    }
  | { kind: "api_balance"; balances?: { total: string; currency: string }[] }
);
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
  { key: "light", icon: "sun", label: "라이트", description: "밝은 배경" },
  { key: "dark", icon: "moon", label: "다크", description: "어두운 배경" },
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

function Capacity({
  onClose,
  onMetrics,
}: {
  onClose: () => void;
  onMetrics: () => void;
}) {
  const [capacity, setCapacity] = useState<Record<string, CapacitySnapshot>>();
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    dashboardGet("/api/capacity")
      .then((data) => {
        if (current) setCapacity(data);
      })
      .catch((failure) => {
        if (current) setError(failure.message);
      });
    return () => {
      current = false;
    };
  }, []);
  return (
    <section className="popover capacity" aria-label="사용량 및 한도">
      <button
        className="icon-button popover-close"
        aria-label="사용량 닫기"
        onClick={onClose}
      >
        <Icon name="close-capacity" />
      </button>
      <h2>사용량 및 한도</h2>
      <p>연결된 서비스가 제공하는 수치를 표시해요.</p>
      {!capacity && <p>{error || "사용량을 불러오는 중입니다."}</p>}
      {capacity && !Object.keys(capacity).length && (
        <p>연결된 서비스가 없습니다.</p>
      )}
      {Object.entries(capacity ?? {}).map(([connection, entry]) => (
        <div className="capacity-row" key={connection}>
          <strong>{connection}</strong>
          {entry.kind === "subscription" &&
            entry.windows?.map((window) => (
              <div className="capacity-value" key={window.label}>
                <span>
                  {window.label}
                  {window.resetsAt &&
                    ` · ${formatTime(window.resetsAt)}에 초기화`}
                </span>
                <b>{window.remainingPercent}%</b>
                <meter
                  min={0}
                  max={100}
                  value={window.remainingPercent}
                  aria-label={`${connection} ${window.label}`}
                />
              </div>
            ))}
          {entry.kind === "api_balance" &&
            entry.balances?.map((balance) => (
              <div className="capacity-value" key={balance.currency}>
                <span>남은 크레딧</span>
                <b>
                  {balance.total} {balance.currency}
                </b>
              </div>
            ))}
          {entry.status !== "exact" && (
            <small title={entry.detail}>
              {entry.status === "stale"
                ? "마지막으로 확인된 수치"
                : entry.status === "auth_required"
                  ? "로그인 필요"
                  : "확인할 수 없음"}
            </small>
          )}
        </div>
      ))}
      <button onClick={onMetrics}>모델별 사용 내역 보기</button>
    </section>
  );
}

function Settings({
  theme,
  setTheme,
  notify,
  setNotify,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  notify: boolean;
  setNotify: (notify: boolean) => void;
}) {
  return (
    <div className="settings-pane">
      <section className="settings-card">
        <h2>화면</h2>
        <p>작업 그래프를 보는 화면 테마를 선택해요.</p>
        <div className="theme-cards">
          {themes.map((option) => (
            <button
              key={option.key}
              aria-pressed={theme === option.key}
              onClick={() => setTheme(option.key)}
            >
              <Icon name={option.key === "light" ? "sun-card" : "moon-card"} />
              <strong>{option.label}</strong>
              <small>{option.description}</small>
              {theme === option.key && <span>선택됨</span>}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-card">
        <h2>보고</h2>
        <div className="settings-row">
          <div>
            <strong>확인이 필요한 보고 알림</strong>
            <p>실행이 멈추거나 내 확인이 필요할 때 알려줘요.</p>
          </div>
          <button
            aria-label="확인이 필요한 보고 알림"
            aria-pressed={notify}
            onClick={() => setNotify(!notify)}
          >
            {notify ? "켜짐" : "꺼짐"}
          </button>
        </div>
      </section>
    </div>
  );
}

function App() {
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
  const [metrics, setMetrics] = useState<Row[]>([]);
  const [providers, setProviders] = useState<Row[]>([]);
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
    Promise.all([api("metrics"), api("providers")])
      .then(([metrics, providers]) => {
        setMetrics(metrics);
        setProviders(providers);
      })
      .catch((error) => setError(error.message));
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
        "이전 버전 실행 기록은 ralph history 또는 마이그레이션에서 확인할 수 있습니다.",
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
      <aside className="sidebar" aria-label="세션">
        <div className="brand">Ralph Dashboard</div>
        <label className="session-search">
          <Icon name="search" />
          <input
            ref={searchInput}
            type="search"
            aria-label="세션 찾기"
            placeholder="세션 찾기"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {!search && <kbd>⌘ K</kbd>}
        </label>
        <div className="sidebar-title">
          <strong>세션</strong>
          <span>{String(candidates.length).padStart(2, "0")}</span>
        </div>
        <nav className="run-list" aria-label="실행 세션">
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
                  title={statusLabel(sessionStatus)}
                />
                <span className="run-name">
                  <strong>{entry.goal ?? entry.runId}</strong>
                  <small>
                    {entry.legacy ? "이전 버전" : project || entry.runId}
                  </small>
                </span>
                {count > 0 && (
                  <span
                    className="count"
                    aria-label={`읽지 않은 보고 ${count}개`}
                  >
                    {count}
                  </span>
                )}
                {active && <Icon name="chevron" />}
              </button>
            );
          })}
          {search && !candidates.length && (
            <p className="no-sessions">일치하는 세션이 없습니다.</p>
          )}
        </nav>
        <footer className="sidebar-footer">
          <button
            className="settings-button"
            aria-current={view === "settings" ? "page" : undefined}
            onClick={() =>
              changeView(view === "settings" ? "runs" : "settings")
            }
          >
            <Icon name="settings" />
            설정
          </button>
          <div className="theme-switch" role="group" aria-label="화면 테마">
            {themes.map((option) => (
              <button
                key={option.key}
                title={option.label}
                aria-label={`${option.label} 테마`}
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
              ? `${project ? project + "  /  " : ""}작업 공간`
              : `Ralph Dashboard  /  ${view === "settings" ? "설정" : "사용량·한도"}`}
          </div>
          <h1 title={selectedRun?.goal}>
            {view === "settings"
              ? "설정"
              : view === "metrics"
                ? "사용 내역"
                : (selectedRun?.goal ?? "실행 세션")}
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
                  보고
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
                  사용량·한도
                </button>
              </>
            ) : (
              <button
                className="back-button"
                onClick={() => changeView("runs")}
              >
                작업 화면으로
              </button>
            )}
          </div>
          {view === "runs" && (
            <div className="session-progress">
              {state && (
                <span className="live-state" data-tone={statusTone(state)}>
                  <span className="lamp" data-tone={statusTone(state)} />
                  {latest && state === "running"
                    ? "실시간"
                    : statusLabel(state)}
                </span>
              )}
              {progress.length > 0 && (
                <>
                  <span className="completed-count">
                    {progress.length}개 중 {done}개 완료
                  </span>
                  <div
                    className="progress-lamps"
                    data-dense={progress.length > 12}
                    aria-label="작업 상태 표시등"
                  >
                    {progress.map((tone, index) => (
                      <span
                        key={nodeRows[index].nodeId}
                        className="lamp"
                        data-tone={tone}
                        title={`${nodeTitle(nodeRows[index])} · ${statusLabel(currentRun?.nodes?.[nodeRows[index].nodeId]?.status)}`}
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
              aria-label="오류 닫기"
              onClick={() => setError("")}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        {view === "settings" && (
          <Settings
            theme={theme}
            setTheme={setTheme}
            notify={notify}
            setNotify={setNotify}
          />
        )}
        {view === "metrics" && (
          <Metrics providers={providers} metrics={metrics} />
        )}
        <div className="run-body" hidden={view !== "runs"}>
          <div className="graph-column">
            <RunGraph
              key={`${selected}/${revision}`}
              graph={currentGraph}
              run={currentRun}
              inspected={node}
              onInspect={inspect}
              onClose={closeNode}
            />
            {currentRun?.message && (
              <div className="notice">
                {currentRun.message}
                {latest && currentRun.message.includes("T3") && (
                  <button onClick={() => command("approve_final")}>
                    최종 결과 확인
                  </button>
                )}
              </div>
            )}
            {latest && discardId && !discardResult && (
              <div role="status" className="notice">
                {state === "running"
                  ? "작업 취소와 변경 되돌리기를 요청했습니다."
                  : "요청을 처리하기 전에 실행이 끝났거나 일시 정지됐습니다."}
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
                  ? "방향 변경을 요청했습니다. 관련 작업이 안전하게 멈출 수 있는 지점까지 기다리는 중입니다."
                  : "방향을 바꾸기 전에 실행이 끝났거나 일시 정지됐습니다."}
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
                  {currentRun.latestRecovery.nodeId} 복구 ·{" "}
                  {currentRun.latestRecovery.diagnosis}
                  {currentRun.latestRecovery.reused.length > 0 &&
                    ` · 완료 노드 ${currentRun.latestRecovery.reused.length}개 재사용`}
                </span>
              </div>
            )}
            {latest && currentRun?.latestDirection && (
              <div role="status" className="notice">
                {currentRun.latestDirection.nodeId}의 방향을 바꿨어요. 변경된
                작업 {currentRun.latestDirection.rerun.join(", ")}.
                {currentRun.latestDirection.reused.length > 0 &&
                  ` 다시 사용한 작업 ${currentRun.latestDirection.reused.join(", ")}.`}
              </div>
            )}
            <footer className="run-footer">
              <div className="last-event">
                <StatusBadge status={lastNode?.info.status ?? state} footer />
                <span>
                  <strong>
                    {lastNode
                      ? `${nodeTitle(lastNode.spec)} · ${statusLabel(lastNode.info.status)}`
                      : state
                        ? statusLabel(state)
                        : "아직 실행 기록이 없습니다"}
                  </strong>
                  {lastTime && (
                    <small>
                      {formatTime(lastTime)}
                      {currentRun?.resultHead && " · 결과 저장됨"}
                    </small>
                  )}
                </span>
              </div>
              {selected && (
                <button
                  className="run-menu"
                  title="실행 메뉴"
                  aria-expanded={panel === "commands"}
                  aria-label="실행 메뉴"
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
            onClose={() => setPanel(undefined)}
            onMetrics={() => changeView("metrics")}
          />
        )}
        {panel === "inbox" && (
          <section className="popover inbox" aria-label="보고 센터">
            <button
              className="icon-button popover-close"
              aria-label="보고 센터 닫기"
              onClick={() => setPanel(undefined)}
            >
              <Icon name="close" />
            </button>
            <h2>
              보고 센터{" "}
              {unread.length > 0 && (
                <span className="count">{unread.length}</span>
              )}
            </h2>
            <p>
              {unread.length
                ? `읽지 않은 보고 ${unread.length}개`
                : "읽지 않은 보고가 없습니다."}
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
                    <small>{report.text}</small>
                  </span>
                  <time>{formatTime(report.timestamp)}</time>
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
                모두 읽음
              </button>
            )}
          </section>
        )}
        {panel === "commands" && (
          <section className="popover commands" aria-label="실행 메뉴">
            <h2>실행 메뉴</h2>
            <label>
              이전 그래프 보기
              <select
                aria-label="그래프 이력"
                value={revision}
                onChange={(event) => {
                  setRevision(event.target.value);
                  closeNode();
                }}
              >
                <option value="latest">최신 그래프</option>
                {Array.from(
                  {
                    length: currentRun?.revision ?? selectedRun?.revision ?? 1,
                  },
                  (_, index) => (
                    <option key={index + 1} value={String(index + 1)}>
                      변경 이력 {index + 1}
                    </option>
                  ),
                )}
              </select>
            </label>
            <button
              onClick={() => command("stop")}
              disabled={!latest || state !== "running"}
            >
              안전하게 중지
            </button>
            <button
              onClick={() => command("resume")}
              disabled={
                !latest ||
                !["paused", "awaiting_input", "failed"].includes(state)
              }
            >
              다시 실행
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
              취소하고 변경 되돌리기
            </button>
            <small>
              모델 호출 {currentRun?.attempts ?? 0}회 · 실행{" "}
              {Math.round((currentRun?.activeMs ?? 0) / 1000)}초
            </small>
          </section>
        )}
        {notify && toast && view === "runs" && (
          <div className="report-toast">
            <button onClick={() => openReport(toast)}>
              <Icon name="inbox" />
              <span>
                확인이 필요한 보고<strong>{toast.goal}</strong>
              </span>
            </button>
            <button
              className="icon-button"
              aria-label="알림 닫기"
              onClick={() => setToast(undefined)}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
