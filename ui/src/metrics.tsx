import type { Row } from "./presentation";

export function Metrics({
  providers,
  metrics,
}: {
  providers: Row[];
  metrics: Row[];
}) {
  return (
    <div className="metrics-page">
      <div className="provider-grid">
        {providers.map((p) => (
          <article key={p.id}>
            <span className="eyebrow">{p.mode}</span>
            <h2>{p.id}</h2>
            <p>
              {p.enabled ? "Enabled" : "Disabled"} · {p.support}
            </p>
            <small>
              {p.verification?.length
                ? p.verification
                    .map(
                      (v: Row) =>
                        `${v.model} · ${v.cliVersion} · ${v.platform} / ${v.node} · ${v.checkedAt}`,
                    )
                    .join("; ")
                : "Live conformance not yet recorded for this environment"}
            </small>
          </article>
        ))}
      </div>
      <section
        className="metrics activity-chart"
        aria-label="Invocation distribution"
      >
        <h2>Invocation distribution</h2>
        {metrics.map((m) => (
          <div
            className="distribution-row"
            key={`${m.connectionId}/${m.modelId}`}
          >
            <span>{m.modelId}</span>
            <meter
              aria-label={`${m.modelId} invocation share`}
              min={0}
              max={Math.max(
                1,
                metrics.reduce((n, m) => n + m.calls, 0),
              )}
              value={m.calls}
            />
            <b>{m.calls} calls</b>
          </div>
        ))}
      </section>
      <section className="metrics">
        <h2>Task distribution</h2>
        <div
          className="heatmap"
          role="table"
          aria-label="Task category invocation counts"
        >
          {metrics.map((m) => (
            <div
              key={`${m.connectionId}/${m.modelId}`}
              className="heat-row"
              role="row"
            >
              <strong>{m.modelId}</strong>
              {Object.entries(m.taskCalls ?? {}).map(([task, count]) => (
                <span
                  role="cell"
                  key={task}
                  style={{
                    background: `color-mix(in srgb, var(--active) ${Math.min(50, 8 + Number(count) * 3)}%, var(--surface))`,
                  }}
                >
                  {task.replaceAll("_", " ")}
                  <b>{String(count)}</b>
                </span>
              ))}
            </div>
          ))}
        </div>
        <h2>Model activity</h2>
        <table>
          <thead>
            <tr>
              <th>Model / connection</th>
              <th>Calls</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cached</th>
              <th>Cost</th>
              <th>Latency total</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={`${m.connectionId}/${m.modelId}`}>
                <td>
                  <b>{m.modelId}</b>
                  <small>{m.connectionId}</small>
                </td>
                <td>{m.calls}</td>
                <td>
                  {m.knownUsageCalls
                    ? m.inputTokens.toLocaleString()
                    : "Unknown"}
                </td>
                <td>
                  {m.knownUsageCalls
                    ? m.outputTokens.toLocaleString()
                    : "Unknown"}
                </td>
                <td>
                  {m.knownCachedCalls
                    ? m.cachedTokens.toLocaleString()
                    : "Unknown"}
                </td>
                <td>
                  {m.knownCostCalls
                    ? `~${m.estimatedCostUsd.toFixed(4)} (${m.costStatus})`
                    : "Unknown"}
                </td>
                <td>{(m.durationMs / 1000).toFixed(1)}s</td>
                <td>{m.usageStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!metrics.length && <p>No model usage recorded yet.</p>}
        <h2>Verified node outcomes</h2>
        <p>
          Local node checks, grouped by task and verifier version. Fewer than 20
          samples do not affect routing.
        </p>
        <table>
          <thead>
            <tr>
              <th>Model / task</th>
              <th>Passed / samples</th>
              <th>95% lower bound</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {metrics.flatMap((m) =>
              (m.quality ?? []).map((q: Row) => (
                <tr
                  key={`${m.connectionId}/${m.modelId}/${q.taskCategory}/${q.verifierVersion}`}
                >
                  <td>
                    {m.modelId}
                    <small>
                      {q.taskCategory} · {q.verifierVersion.slice(0, 8)}
                    </small>
                  </td>
                  <td>
                    {q.qualifiedSuccesses} / {q.attempts}
                  </td>
                  <td>{(q.lowerBound * 100).toFixed(1)}%</td>
                  <td>{q.dataStatus}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
