import {
  CapacityDetails,
  connectionName,
  type CapacityState,
} from "./capacity";
import type { Row } from "./presentation";
import { type Translate, useLanguage, useText } from "./locale";

const taskNames: Record<string, [string, string]> = {
  planning_architecture: ["계획·설계", "Planning and design"],
  frontend_visual: ["화면·디자인", "UI and design"],
  backend_core: ["서버·핵심 기능", "Server and core features"],
  tdd_debugging: ["테스트·오류 수정", "Testing and debugging"],
  static_review: ["코드 검토", "Code review"],
  delivery_evidence: ["결과물·검증 기록", "Delivery and evidence"],
  control: ["실행 관리", "Run management"],
};

const supportNames: Record<string, [string, string]> = {
  verified: ["실행 검증 완료", "Execution verified"],
  compatible: ["기본 연동 지원", "Standard integration"],
  experimental: ["시험 지원", "Experimental"],
  unavailable: ["실행 환경 없음", "Runtime unavailable"],
};

const usageNames: Record<string, [string, string]> = {
  reported: ["집계 완료", "Reported"],
  partial: ["일부 집계", "Partially reported"],
  unknown: ["미집계", "Unavailable"],
};

const primaryConnections = [
  "openai:codex-login",
  "anthropic:claude-login",
  "google:antigravity-login",
  "deepseek:api",
  "zai:general",
];

export type ProviderRow = {
  id: string;
  mode: string;
  enabled: boolean;
  installed: boolean;
  authentication: string;
  support: string;
  catalogVersion: number;
  routingCatalogVersion: number;
  routableModels: number;
  models: {
    modelId: string;
    displayName: string;
    inRoute: boolean;
    manual: boolean;
  }[];
  verification?: Row[];
};

function connectionStatus(provider: ProviderRow, t: Translate) {
  if (provider.mode === "api") {
    return provider.enabled && provider.authentication === "authenticated"
      ? t("키 등록됨", "API key saved")
      : t("API 키 필요", "API key required");
  }
  if (
    provider.enabled &&
    provider.installed &&
    ["authenticated", "unknown"].includes(provider.authentication)
  )
    return t("연결됨", "Connected");
  if (!provider.installed && provider.mode === "builtin")
    return t("CLI 설치 필요", "CLI installation required");
  if (!provider.installed) return t("실행 환경 필요", "Runtime required");
  if (provider.authentication === "unauthenticated")
    return t("로그인 필요", "Sign-in required");
  if (provider.authentication === "unknown")
    return t("로그인 확인 필요", "Check sign-in");
  return t("연결 꺼짐", "Disabled");
}

export function Metrics({
  providers,
  metrics,
  failed,
  capacity,
}: {
  providers?: ProviderRow[];
  metrics?: Row[];
  failed: boolean;
  capacity: CapacityState;
}) {
  const t = useText();
  const language = useLanguage();
  const position = language === "en" ? 1 : 0;
  const count = (value: number) => value.toLocaleString(language);
  const checkDate = new Intl.DateTimeFormat(language, { dateStyle: "medium" });
  const taskName = (key: string) =>
    taskNames[key]?.[position] ?? t("기타 작업", "Other tasks");
  const visibleProviders = providers?.filter(
    (provider) => provider.id !== "google:gemini-cli-login" || provider.enabled,
  );
  const callsTotal =
    metrics?.reduce((total, model) => total + model.calls, 0) ?? 0;
  const verified = metrics?.flatMap((m) =>
    (m.quality ?? []).map((quality: Row) => ({ model: m, quality })),
  );
  const catalog = visibleProviders?.[0];
  const primaryProviders = (visibleProviders ?? [])
    .filter(({ id, enabled }) => enabled || primaryConnections.includes(id))
    .sort((a, b) => {
      const position = (id: string) => {
        const index = primaryConnections.indexOf(id);
        return index === -1 ? primaryConnections.length : index;
      };
      return position(a.id) - position(b.id);
    });
  const otherProviders = (visibleProviders ?? []).filter(
    (p) => !primaryProviders.includes(p),
  );

  function providerCard(p: ProviderRow) {
    const status = connectionStatus(p, t);
    const connected =
      status === t("연결됨", "Connected") ||
      status === t("키 등록됨", "API key saved");
    return (
      <article key={p.id}>
        <div className="provider-card-top">
          <span className="eyebrow">
            {p.mode === "api"
              ? t("API 키", "API key")
              : p.mode === "builtin"
                ? t("계정 로그인", "Account sign-in")
                : t("로컬 실행", "Local process")}
          </span>
          <span className="provider-status" data-connected={connected}>
            {status}
          </span>
        </div>
        <h3>{connectionName(p.id, language)}</h3>
        <small>
          {connected && p.routableModels === 0
            ? t(
                "Ralph에서 실행할 수 있는 모델이 아직 없어요.",
                "No models are available to run in Ralph yet.",
              )
            : (supportNames[p.support]?.[position] ??
              t("지원 상태 확인 중", "Checking support"))}
        </small>
        <details className="provider-models">
          <summary>
            {t("모델 목록", "Models")}
            {p.models.length > 0 &&
              t(
                ` (${count(p.models.length)}개)`,
                ` (${count(p.models.length)})`,
              )}
          </summary>
          {p.models.length ? (
            <ul>
              {p.models.map((model) => (
                <li key={model.modelId}>
                  <span>{model.displayName}</span>
                  {model.displayName !== model.modelId && (
                    <small>{model.modelId}</small>
                  )}
                  <div className="provider-model-labels">
                    {model.manual && (
                      <span>{t("수동으로 추가", "Added manually")}</span>
                    )}
                    {model.inRoute ? (
                      <span data-active="true">
                        {t("실행 경로에 설정됨", "In a project route")}
                      </span>
                    ) : (
                      !model.manual && (
                        <span>{t("카탈로그 등록", "In catalog")}</span>
                      )
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("표시할 모델이 없어요.", "No models to show.")}</p>
          )}
        </details>
        {!!p.verification?.length && (
          <details className="provider-verification">
            <summary>{t("실행 검증 기록", "Execution verification")}</summary>
            <ul>
              {p.verification.map((v: Row) => (
                <li key={`${v.model}/${v.cliVersion}/${v.checkedAt}`}>
                  {v.model} · CLI {v.cliVersion} · {v.platform} · Node.js{" "}
                  {v.node}
                  {v.checkedAt &&
                    ` · ${checkDate.format(new Date(v.checkedAt))}`}
                </li>
              ))}
            </ul>
          </details>
        )}
      </article>
    );
  }

  return (
    <div className="metrics-page">
      <section
        className="metrics metrics-limits"
        aria-labelledby="limits-heading"
      >
        <h2 id="limits-heading">
          {t("남은 한도와 잔액", "Remaining limits and balances")}
        </h2>
        <CapacityDetails capacity={capacity} />
      </section>

      <section className="provider-section" aria-labelledby="providers-heading">
        <div className="provider-section-heading">
          <h2 id="providers-heading">
            {t("공급자 연결", "Provider connections")}
          </h2>
          {catalog && (
            <span>
              {t("모델 카탈로그", "Model catalog")} v{catalog.catalogVersion}
            </span>
          )}
        </div>
        <p>
          {t(
            "각 연결의 모델 목록에서 카탈로그에 등록된 모델과 프로젝트 실행 경로에 설정된 모델을 확인할 수 있어요.",
            "See catalog models and models in project routes for each connection.",
          )}
        </p>
        {catalog &&
          catalog.routingCatalogVersion !== catalog.catalogVersion && (
            <p>
              {t(
                `저장된 실행 경로는 카탈로그 v${catalog.routingCatalogVersion} 기준이에요.`,
                `Saved routes use catalog v${catalog.routingCatalogVersion}.`,
              )}
            </p>
          )}
        {!providers && !failed && (
          <p role="status">
            {t("연결 상태를 확인하고 있어요.", "Checking connections…")}
          </p>
        )}
        {visibleProviders?.length === 0 && (
          <p>{t("설정된 공급자가 없습니다.", "No providers configured.")}</p>
        )}
        <div className="provider-grid">
          {primaryProviders.map(providerCard)}
        </div>
        {otherProviders.length > 0 && (
          <details className="other-providers">
            <summary>{t("그 외 공급자", "Other providers")}</summary>
            <div className="provider-grid">
              {otherProviders.map(providerCard)}
            </div>
          </details>
        )}
      </section>

      {failed && (
        <p role="status">
          {t(
            "사용 내역과 연결 상태를 새로 불러오지 못했습니다. 잠시 뒤 다시 열어 보세요.",
            "Could not refresh usage and connections. Try again shortly.",
          )}
        </p>
      )}
      {!metrics && !failed && (
        <p role="status">
          {t("모델별 사용 내역을 불러오고 있어요.", "Loading model usage…")}
        </p>
      )}
      {metrics && (
        <>
          <section
            className="metrics activity-chart"
            aria-labelledby="invocations-heading"
          >
            <h2 id="invocations-heading">
              {t("모델별 호출 횟수", "Calls by model")}
            </h2>
            {!metrics.length && (
              <p>{t("기록된 호출이 없습니다.", "No calls recorded.")}</p>
            )}
            {metrics.map((m) => (
              <div
                className="distribution-row"
                key={`${m.connectionId}/${m.modelId}`}
              >
                <span>
                  {m.modelId}{" "}
                  <small>{connectionName(m.connectionId, language)}</small>
                </span>
                <meter
                  aria-label={`${m.modelId} ${connectionName(m.connectionId, language)} ${t("호출 비율", "call share")}`}
                  min={0}
                  max={Math.max(1, callsTotal)}
                  value={m.calls}
                />
                <b>{t(`${count(m.calls)}회`, `${count(m.calls)} calls`)}</b>
              </div>
            ))}
          </section>

          <section className="metrics">
            <h2>{t("작업 종류별 호출", "Calls by task")}</h2>
            {!metrics.length && (
              <p>{t("기록된 작업이 없습니다.", "No tasks recorded.")}</p>
            )}
            <div className="heatmap">
              {metrics.map((m) => (
                <div
                  key={`${m.connectionId}/${m.modelId}`}
                  className="heat-row"
                >
                  <strong>
                    {m.modelId}{" "}
                    <small>{connectionName(m.connectionId, language)}</small>
                  </strong>
                  {Object.entries(m.taskCalls ?? {}).map(([task, calls]) => (
                    <span
                      key={task}
                      style={{
                        background: `color-mix(in srgb, var(--active) ${Math.min(50, 8 + Number(calls) * 3)}%, var(--surface))`,
                      }}
                    >
                      {taskName(task)}{" "}
                      <b>
                        {t(
                          `${count(Number(calls))}회`,
                          `${count(Number(calls))} calls`,
                        )}
                      </b>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </section>

          <section className="metrics">
            <h2 id="model-usage-heading">
              {t("모델별 사용 내역", "Model usage")}
            </h2>
            {metrics.length ? (
              <table aria-labelledby="model-usage-heading">
                <thead>
                  <tr>
                    <th scope="col">
                      {t("모델 / 연결", "Model / connection")}
                    </th>
                    <th scope="col">{t("호출 횟수", "Calls")}</th>
                    <th scope="col">{t("입력 토큰", "Input tokens")}</th>
                    <th scope="col">{t("출력 토큰", "Output tokens")}</th>
                    <th scope="col">{t("캐시 토큰", "Cached tokens")}</th>
                    <th scope="col">{t("예상 비용", "Estimated cost")}</th>
                    <th scope="col">
                      {t("총 응답 시간", "Total response time")}
                    </th>
                    <th scope="col">
                      {t("토큰 집계 상태", "Token reporting")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m) => (
                    <tr key={`${m.connectionId}/${m.modelId}`}>
                      <td>
                        <b>{m.modelId}</b>
                        <small>
                          {connectionName(m.connectionId, language)}
                        </small>
                      </td>
                      <td>
                        {t(`${count(m.calls)}회`, `${count(m.calls)} calls`)}
                      </td>
                      <td>
                        {m.knownUsageCalls
                          ? count(m.inputTokens)
                          : t("미집계", "Unavailable")}
                      </td>
                      <td>
                        {m.knownUsageCalls
                          ? count(m.outputTokens)
                          : t("미집계", "Unavailable")}
                      </td>
                      <td>
                        {m.knownCachedCalls
                          ? count(m.cachedTokens)
                          : t("미집계", "Unavailable")}
                      </td>
                      <td>
                        {m.knownCostCalls ? (
                          <>
                            {t("약", "Est.")} ${m.estimatedCostUsd.toFixed(4)}
                            {m.costStatus === "partial_estimate" && (
                              <small>
                                {t("일부 호출만 반영", "Some calls included")}
                              </small>
                            )}
                          </>
                        ) : (
                          t("미집계", "Unavailable")
                        )}
                      </td>
                      <td>
                        {(m.durationMs / 1000).toFixed(1)}
                        {t("초", "s")}
                      </td>
                      <td>
                        {usageNames[m.usageStatus]?.[position] ??
                          t("미집계", "Unavailable")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>
                {t(
                  "기록된 모델 사용 내역이 없습니다.",
                  "No model usage recorded.",
                )}
              </p>
            )}
          </section>

          <section className="metrics">
            <h2 id="model-quality-heading">
              {t("모델별 검증 결과", "Verification by model")}
            </h2>
            <p>
              {t(
                "작업 종류와 검증 방식이 같은 결과를 모았어요. 기록이 20건 이상이면 모델 선택에 참고해요.",
                "Results are grouped by task and verification method. Groups of 20 or more inform model selection.",
              )}
            </p>
            {verified?.length ? (
              <table aria-labelledby="model-quality-heading">
                <thead>
                  <tr>
                    <th scope="col">{t("모델 / 작업 종류", "Model / task")}</th>
                    <th scope="col">
                      {t("통과 / 전체 검증", "Passed / total")}
                    </th>
                    <th
                      scope="col"
                      title={t(
                        "통과율의 95% 신뢰구간 하한",
                        "Lower bound of the 95% confidence interval",
                      )}
                    >
                      {t("보수적으로 본 통과율", "Conservative pass rate")}
                    </th>
                    <th scope="col">{t("기록 상태", "Data status")}</th>
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
                          {taskName(quality.taskCategory)} ·{" "}
                          {t("검증 방식", "Verification")}{" "}
                          {quality.verifierVersion.slice(0, 8)}
                        </small>
                      </td>
                      <td>
                        {count(quality.qualifiedSuccesses)} /{" "}
                        {count(quality.attempts)}
                        {t("건", "")}
                      </td>
                      <td>{(quality.lowerBound * 100).toFixed(1)}%</td>
                      <td>
                        {quality.dataStatus === "comparable"
                          ? t("비교 가능", "Comparable")
                          : t("기록 부족", "Insufficient data")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>
                {t(
                  "기록된 검증 결과가 없습니다.",
                  "No verification results recorded.",
                )}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
