import { useEffect, useState } from "react";
import { dashboardGet, Icon } from "./presentation";
import { type Language, type Translate, useLanguage, useText } from "./locale";

export type CapacityWindow = {
  label: string;
  durationMinutes?: number;
  remainingPercent: number;
  resetsAt?: string;
};
type CapacitySnapshot = {
  status: "exact" | "unavailable" | "auth_required" | "stale";
} & (
  | { kind: "subscription"; windows?: CapacityWindow[] }
  | { kind: "api_balance"; balances?: { total: string; currency: string }[] }
);
export type CapacityState = {
  entries?: Record<string, CapacitySnapshot>;
  failed?: boolean;
};

const geminiId = "google:antigravity-login";
const billingUrl = "https://z.ai/manage-apikey/billing";
const names: Record<string, [string, string]> = {
  "openai:codex-login": ["Codex 구독제", "Codex subscription"],
  "anthropic:claude-login": ["Claude 구독제", "Claude subscription"],
  [geminiId]: ["Gemini 구독제", "Gemini subscription"],
  "google:gemini-cli-login": ["Gemini CLI (기존 연결)", "Gemini CLI (legacy)"],
  "openai:api": ["OpenAI API", "OpenAI API"],
  "anthropic:api": ["Anthropic API", "Anthropic API"],
  "google:api": ["Gemini API", "Gemini API"],
  "deepseek:api": ["DeepSeek API", "DeepSeek API"],
  "zai:general": ["GLM API", "GLM API"],
  "zai:coding-plan": ["GLM 코딩 플랜", "GLM Coding Plan"],
};

export const connectionName = (id: string, language: Language = "ko") =>
  names[id]?.[language === "en" ? 1 : 0] ?? id;

const providerLogos: Record<string, string> = {
  "openai:codex-login": "codex",
  "anthropic:claude-login": "claude",
  [geminiId]: "gemini",
  "deepseek:api": "deepseek",
  "zai:general": "zai",
};

export function ProviderName({ id }: { id: string }) {
  const language = useLanguage();
  const logo = providerLogos[id];
  return (
    <span className="provider-name">
      {logo && (
        <img
          className="provider-logo"
          data-logo={logo}
          src={`/icons/provider-${logo}.svg`}
          width="16"
          height="16"
          alt=""
        />
      )}
      {connectionName(id, language)}
    </span>
  );
}

function windowName(window: CapacityWindow, id: string, t: Translate) {
  const match = /^(.*) (primary|secondary)$/.exec(window.label);
  const bucket = window.label.replace(/-(5h|weekly)$/, "");
  const geminiGroup =
    bucket === "gemini"
      ? "Gemini"
      : bucket === "gemini-argon-wtu"
        ? "Gemini 4 Argon"
        : t("기타 Gemini 모델", "Other Gemini models");
  const group = id === geminiId ? geminiGroup : match?.[1];
  const prefix = group && group.toLowerCase() !== "codex" ? `${group} · ` : "";
  const minutes = window.durationMinutes;
  if (!minutes)
    return (
      prefix +
      (match?.[2] === "secondary"
        ? t("추가 한도", "Additional limit")
        : t("기본 한도", "Base limit"))
    );
  if (minutes === 10080) return prefix + t("주간 한도", "Weekly limit");
  if (minutes % 1440 === 0)
    return (
      prefix + t(`${minutes / 1440}일 한도`, `${minutes / 1440}-day limit`)
    );
  if (minutes % 60 === 0)
    return prefix + t(`${minutes / 60}시간 한도`, `${minutes / 60}-hour limit`);
  return prefix + t(`${minutes}분 한도`, `${minutes}-minute limit`);
}

function capacityNote(
  connection: string,
  entry: CapacitySnapshot,
  t: Translate,
) {
  if (entry.status === "exact") return "";
  if (entry.status === "stale")
    return t("마지막으로 확인한 수치예요.", "Last available result.");
  if (entry.status === "auth_required")
    return entry.kind === "api_balance"
      ? t("API 키를 확인해 주세요.", "Check your API key.")
      : t(
          "공급자 계정에 다시 로그인해 주세요.",
          "Sign in to the provider again.",
        );
  switch (connection) {
    case geminiId:
      return t(
        "한도를 불러오지 못했어요. Antigravity의 /usage에서도 확인할 수 있어요.",
        "Could not load limits. You can also check /usage in Antigravity.",
      );
    case "anthropic:claude-login":
      return t(
        "Claude 설정의 사용량 메뉴에서도 한도를 볼 수 있어요.",
        "See Usage in Claude settings.",
      );
    case "google:gemini-cli-login":
      return t(
        "Gemini CLI에서 /stats model로 확인할 수 있어요.",
        "Use /stats model in Gemini CLI.",
      );
    case "openai:codex-login":
    case "deepseek:api":
      return t(
        "지금은 한도를 불러올 수 없어요.",
        "Limits are temporarily unavailable.",
      );
    case "zai:general":
      return t(
        "남은 잔액은 Z.ai에서 확인할 수 있어요.",
        "See your remaining balance on Z.ai.",
      );
    default:
      return t(
        "Ralph에서 잔액을 자동으로 조회할 수 없는 연결이에요.",
        "Automatic balance lookup is unavailable.",
      );
  }
}

export function useCapacity(): CapacityState {
  const [state, setState] = useState<CapacityState>({});
  useEffect(() => {
    let current = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const entries = await dashboardGet("/api/capacity");
        if (current) setState({ entries });
      } catch {
        if (current) setState((last) => ({ ...last, failed: true }));
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    window.addEventListener("focus", load);
    return () => {
      current = false;
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, []);
  return state;
}

export function GeminiLimit({ capacity }: { capacity: CapacityState }) {
  const t = useText();
  const entry = capacity.entries?.[geminiId];
  if (!entry || entry.kind !== "subscription") return null;
  const window =
    entry.windows?.find(({ label }) => label === "gemini-5h") ??
    entry.windows?.find(({ label }) => label === "gemini-weekly");
  if (!window) return null;
  const outdated = capacity.failed || entry.status === "stale";
  return (
    <span
      className="gemini-limit"
      data-stale={Boolean(outdated)}
      title={`${windowName(window, geminiId, t)} · ${outdated ? t("마지막 확인 수치", "Last result") : t("남은 비율", "Remaining")}`}
    >
      Gemini {window.remainingPercent}%{outdated && " *"}
    </span>
  );
}

export function CapacityDetails({ capacity }: { capacity: CapacityState }) {
  const t = useText();
  const language = useLanguage();
  const { entries, failed } = capacity;
  const resetTime = new Intl.DateTimeFormat(
    language === "en" ? "en-US" : "ko-KR",
    {
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    },
  );
  if (!entries)
    return (
      <p role="status">
        {failed
          ? t("한도를 불러오지 못했습니다.", "Could not load limits.")
          : t("한도를 불러오고 있어요.", "Loading limits…")}
      </p>
    );
  if (!Object.keys(entries).length)
    return <p>{t("연결된 공급자가 없습니다.", "No connected providers.")}</p>;
  return (
    <div className="capacity-list">
      {Object.entries(entries).map(([connection, entry]) => {
        const name = connectionName(connection, language);
        const note = capacityNote(connection, entry, t);
        return (
          <div className="capacity-row" key={connection}>
            <strong>
              <ProviderName id={connection} />
            </strong>
            {entry.kind === "subscription" &&
              entry.windows?.map((window) => {
                const label = windowName(window, connection, t);
                const resetAt = Date.parse(window.resetsAt ?? "");
                return (
                  <div className="capacity-value" key={window.label}>
                    <span>
                      {label}
                      {Number.isFinite(resetAt) && (
                        <small>
                          {language === "en" && "Resets "}
                          <time dateTime={window.resetsAt}>
                            {resetTime.format(resetAt)}
                          </time>
                          {language === "ko" && "에 초기화"}
                        </small>
                      )}
                    </span>
                    <div className="capacity-meter-value">
                      <b>
                        {window.remainingPercent}% {t("남음", "left")}
                      </b>
                      <meter
                        min={0}
                        max={100}
                        value={window.remainingPercent}
                        aria-label={`${name} ${label} ${t("잔여 비율", "remaining")}`}
                      />
                    </div>
                  </div>
                );
              })}
            {entry.kind === "api_balance" &&
              entry.balances?.map((balance) => {
                const currency =
                  balance.currency === "USD"
                    ? t("미국 달러", "USD")
                    : balance.currency === "CNY"
                      ? t("중국 위안", "CNY")
                      : balance.currency;
                return (
                  <div className="capacity-value" key={balance.currency}>
                    <span>{t("남은 잔액", "Remaining balance")}</span>
                    <b>
                      {balance.total} {currency}
                    </b>
                  </div>
                );
              })}
            {note && <small className="capacity-note">{note}</small>}
            {connection === "zai:general" && (
              <a
                className="capacity-link"
                href={billingUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("Z.ai 결제 페이지 열기", "Open Z.ai billing")}
              </a>
            )}
            {entry.status === "exact" &&
              entry.kind === "api_balance" &&
              !entry.balances?.length && (
                <small>
                  {t(
                    "공급자가 잔액을 보내지 않았어요.",
                    "The provider did not return a balance.",
                  )}
                </small>
              )}
          </div>
        );
      })}
    </div>
  );
}

export function Capacity({
  onClose,
  onMetrics,
  capacity,
}: {
  onClose: () => void;
  onMetrics: () => void;
  capacity: CapacityState;
}) {
  const t = useText();
  return (
    <section
      className="popover capacity"
      aria-label={t("사용량 및 한도", "Usage and limits")}
    >
      <button
        className="icon-button popover-close"
        aria-label={t("사용량 닫기", "Close usage")}
        onClick={onClose}
      >
        <Icon name="close-capacity" />
      </button>
      <h2>{t("사용량 및 한도", "Usage and limits")}</h2>
      <p>
        {t(
          "연결된 계정의 남은 한도와 잔액을 확인할 수 있어요.",
          "Check the remaining limits and balances for connected accounts.",
        )}
      </p>
      <CapacityDetails capacity={capacity} />
      <button onClick={onMetrics}>
        {t("모델별 사용 내역 보기", "View model usage")}
      </button>
    </section>
  );
}
