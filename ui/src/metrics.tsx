import { CapacityDetails, connectionName } from "./capacity";
import type { Row } from "./presentation";

const taskNames: Record<string, string> = {
  planning_architecture: "계획·설계",
  frontend_visual: "화면·디자인",
  backend_core: "서버·핵심 기능",
  tdd_debugging: "테스트·오류 수정",
  static_review: "코드 검토",
  delivery_evidence: "결과물·검증 기록",
  control: "실행 관리",
};

const supportNames: Record<string, string> = {
  verified: "실행 검증 완료",
  compatible: "기본 연동 지원",
  experimental: "시험 지원",
  unavailable: "실행 환경 없음",
};

const usageNames: Record<string, string> = {
  reported: "집계 완료",
  partial: "일부 집계",
  unknown: "미집계",
};

const countFormat = new Intl.NumberFormat("ko-KR");
const checkDate = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" });
const taskName = (key: string) => taskNames[key] ?? "기타 작업";
const count = (value: number) => countFormat.format(value);

function connectionStatus(provider: Row) {
  if (provider.mode === "api") {
    return provider.enabled && provider.authentication === "authenticated"
      ? "키 등록됨"
      : "API 키 필요";
  }
  if (
    provider.enabled &&
    provider.installed &&
    ["authenticated", "unknown"].includes(provider.authentication)
  )
    return "연결됨";
  if (!provider.installed && provider.mode === "builtin")
    return "CLI 설치 필요";
  if (!provider.installed) return "실행 환경 필요";
  if (provider.authentication === "unauthenticated") return "로그인 필요";
  if (provider.authentication === "unknown") return "로그인 확인 필요";
  return "연결 꺼짐";
}

export function Metrics({
  providers,
  metrics,
  failed,
}: {
  providers?: Row[];
  metrics?: Row[];
  failed: boolean;
}) {
  const callsTotal =
    metrics?.reduce((total, model) => total + model.calls, 0) ?? 0;
  const verified = metrics?.flatMap((m) =>
    (m.quality ?? []).map((quality: Row) => ({ model: m, quality })),
  );

  return (
    <div className="metrics-page">
      <section
        className="metrics metrics-limits"
        aria-labelledby="limits-heading"
      >
        <h2 id="limits-heading">남은 한도와 잔액</h2>
        <CapacityDetails />
      </section>

      <section className="provider-section" aria-labelledby="providers-heading">
        <h2 id="providers-heading">공급자 연결</h2>
        <p>
          구독 계정과 API 키는 각각 연결해요. 일부 공급자의 잔여 한도는 공급자
          화면에서 확인할 수 있어요.
        </p>
        {!providers && !failed && (
          <p role="status">연결 상태를 확인하고 있어요.</p>
        )}
        {providers?.length === 0 && <p>설정된 공급자가 없습니다.</p>}
        <div className="provider-grid">
          {providers?.map((p) => {
            const status = connectionStatus(p);
            const connected = status === "연결됨" || status === "키 등록됨";
            return (
              <article key={p.id}>
                <div className="provider-card-top">
                  <span className="eyebrow">
                    {p.mode === "api"
                      ? "API 키"
                      : p.mode === "builtin"
                        ? "계정 로그인"
                        : "로컬 실행"}
                  </span>
                  <span className="provider-status" data-connected={connected}>
                    {status}
                  </span>
                </div>
                <h3>{connectionName(p.id)}</h3>
                <small>
                  {connected && p.routableModels === 0
                    ? "Ralph에서 실행할 수 있는 모델이 아직 없어요."
                    : p.id === "google:gemini-cli-login" && !connected
                      ? "개인 계정은 Antigravity로 연결해 주세요."
                      : (supportNames[p.support] ?? "지원 상태 확인 중")}
                </small>
                {!!p.verification?.length && (
                  <details className="provider-verification">
                    <summary>실행 검증 기록</summary>
                    <ul>
                      {p.verification.map((v: Row) => (
                        <li key={`${v.model}/${v.cliVersion}/${v.checkedAt}`}>
                          {v.model} · CLI {v.cliVersion} · {v.platform} ·
                          Node.js {v.node}
                          {v.checkedAt &&
                            ` · ${checkDate.format(new Date(v.checkedAt))}`}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {failed && (
        <p role="status">
          사용 내역과 연결 상태를 새로 불러오지 못했습니다. 잠시 뒤 다시 열어
          보세요.
        </p>
      )}
      {!metrics && !failed && (
        <p role="status">모델별 사용 내역을 불러오고 있어요.</p>
      )}
      {metrics && (
        <>
          <section
            className="metrics activity-chart"
            aria-labelledby="invocations-heading"
          >
            <h2 id="invocations-heading">모델별 호출 횟수</h2>
            {!metrics.length && <p>기록된 호출이 없습니다.</p>}
            {metrics.map((m) => (
              <div
                className="distribution-row"
                key={`${m.connectionId}/${m.modelId}`}
              >
                <span>
                  {m.modelId} <small>{connectionName(m.connectionId)}</small>
                </span>
                <meter
                  aria-label={`${m.modelId} ${connectionName(m.connectionId)} 호출 비율`}
                  min={0}
                  max={Math.max(1, callsTotal)}
                  value={m.calls}
                />
                <b>{count(m.calls)}회</b>
              </div>
            ))}
          </section>

          <section className="metrics">
            <h2>작업 종류별 호출</h2>
            {!metrics.length && <p>기록된 작업이 없습니다.</p>}
            <div className="heatmap">
              {metrics.map((m) => (
                <div
                  key={`${m.connectionId}/${m.modelId}`}
                  className="heat-row"
                >
                  <strong>
                    {m.modelId} <small>{connectionName(m.connectionId)}</small>
                  </strong>
                  {Object.entries(m.taskCalls ?? {}).map(([task, calls]) => (
                    <span
                      key={task}
                      style={{
                        background: `color-mix(in srgb, var(--active) ${Math.min(50, 8 + Number(calls) * 3)}%, var(--surface))`,
                      }}
                    >
                      {taskName(task)} <b>{count(Number(calls))}회</b>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </section>

          <section className="metrics">
            <h2 id="model-usage-heading">모델별 사용 내역</h2>
            {metrics.length ? (
              <table aria-labelledby="model-usage-heading">
                <thead>
                  <tr>
                    <th scope="col">모델 / 연결</th>
                    <th scope="col">호출 횟수</th>
                    <th scope="col">입력 토큰</th>
                    <th scope="col">출력 토큰</th>
                    <th scope="col">캐시 토큰</th>
                    <th scope="col">예상 비용</th>
                    <th scope="col">총 응답 시간</th>
                    <th scope="col">토큰 집계 상태</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m) => (
                    <tr key={`${m.connectionId}/${m.modelId}`}>
                      <td>
                        <b>{m.modelId}</b>
                        <small>{connectionName(m.connectionId)}</small>
                      </td>
                      <td>{count(m.calls)}회</td>
                      <td>
                        {m.knownUsageCalls ? count(m.inputTokens) : "미집계"}
                      </td>
                      <td>
                        {m.knownUsageCalls ? count(m.outputTokens) : "미집계"}
                      </td>
                      <td>
                        {m.knownCachedCalls ? count(m.cachedTokens) : "미집계"}
                      </td>
                      <td>
                        {m.knownCostCalls ? (
                          <>
                            {`약 $${m.estimatedCostUsd.toFixed(4)}`}
                            {m.costStatus === "partial_estimate" && (
                              <small>일부 호출만 반영</small>
                            )}
                          </>
                        ) : (
                          "미집계"
                        )}
                      </td>
                      <td>{(m.durationMs / 1000).toFixed(1)}초</td>
                      <td>{usageNames[m.usageStatus] ?? "미집계"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>기록된 모델 사용 내역이 없습니다.</p>
            )}
          </section>

          <section className="metrics">
            <h2 id="model-quality-heading">모델별 검증 결과</h2>
            <p>
              작업 종류와 검증 방식이 같은 결과를 모았어요. 기록이 20건 이상이면
              모델 선택에 참고해요.
            </p>
            {verified?.length ? (
              <table aria-labelledby="model-quality-heading">
                <thead>
                  <tr>
                    <th scope="col">모델 / 작업 종류</th>
                    <th scope="col">통과 / 전체 검증</th>
                    <th scope="col" title="통과율의 95% 신뢰구간 하한">
                      보수적으로 본 통과율
                    </th>
                    <th scope="col">기록 상태</th>
                  </tr>
                </thead>
                <tbody>
                  {verified.map(({ model, quality }) => (
                    <tr
                      key={`${model.connectionId}/${model.modelId}/${quality.taskCategory}/${quality.verifierVersion}`}
                    >
                      <td>
                        <b>{model.modelId}</b>
                        <small>
                          {taskName(quality.taskCategory)} · 검증 방식{" "}
                          {quality.verifierVersion.slice(0, 8)}
                        </small>
                      </td>
                      <td>
                        {count(quality.qualifiedSuccesses)} /{" "}
                        {count(quality.attempts)}건
                      </td>
                      <td>{(quality.lowerBound * 100).toFixed(1)}%</td>
                      <td>
                        {quality.dataStatus === "comparable"
                          ? "비교 가능"
                          : "기록 부족"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>기록된 검증 결과가 없습니다.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
