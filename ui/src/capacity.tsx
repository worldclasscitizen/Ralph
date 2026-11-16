import { useEffect, useState } from "react";
import { dashboardGet, Icon } from "./presentation";

type CapacityWindow = {
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

const connectionNames: Record<string, string> = {
  "openai:codex-login": "Codex 구독",
  "anthropic:claude-login": "Claude Code 구독",
  "google:antigravity-login": "Antigravity 구독",
  "google:gemini-cli-login": "Gemini CLI",
  "openai:api": "OpenAI API",
  "anthropic:api": "Anthropic API",
  "google:api": "Gemini API",
  "deepseek:api": "DeepSeek API",
  "zai:general": "Z.ai 일반 API",
  "zai:coding-plan": "Z.ai 코딩 플랜",
};

export const connectionName = (id: string) => connectionNames[id] ?? id;

const resetTime = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const currencyNames: Record<string, string> = {
  USD: "미국 달러",
  CNY: "중국 위안",
};

function windowName(window: CapacityWindow) {
  const match = /^(.*) (primary|secondary)$/.exec(window.label);
  const group = match?.[1];
  const prefix = group && group.toLowerCase() !== "codex" ? `${group} · ` : "";
  const minutes = window.durationMinutes;
  if (!minutes) {
    return prefix + (match?.[2] === "secondary" ? "추가 한도" : "기본 한도");
  }
  if (minutes === 10080) return prefix + "주간 한도";
  if (minutes % 1440 === 0) return `${prefix}${minutes / 1440}일 한도`;
  if (minutes % 60 === 0) return `${prefix}${minutes / 60}시간 한도`;
  return `${prefix}${minutes}분 한도`;
}

function capacityNote(connection: string, entry: CapacitySnapshot) {
  if (entry.status === "exact") return "";
  if (entry.status === "stale") return "마지막으로 확인한 수치예요.";
  if (entry.status === "auth_required") {
    return entry.kind === "api_balance"
      ? "API 키를 확인해 주세요."
      : "공급자 계정에 다시 로그인해 주세요.";
  }
  switch (connection) {
    case "google:antigravity-login":
      return "Antigravity에서 /usage로 남은 한도를 확인할 수 있어요.";
    case "anthropic:claude-login":
      return "Claude 설정의 사용량 메뉴에서 남은 한도를 확인할 수 있어요.";
    case "google:gemini-cli-login":
      return "Gemini CLI에서 /stats model로 사용량을 확인할 수 있어요.";
    case "openai:codex-login":
    case "deepseek:api":
      return "지금은 한도를 불러올 수 없어요. 잠시 뒤 다시 열어 보세요.";
    default:
      return "Ralph에서 잔액을 자동으로 조회할 수 없는 연결이에요.";
  }
}

export function CapacityDetails() {
  const [capacity, setCapacity] = useState<Record<string, CapacitySnapshot>>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    dashboardGet("/api/capacity")
      .then((data) => {
        if (current) setCapacity(data);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, []);
  if (!capacity) {
    return (
      <p role="status">
        {failed ? "한도를 불러오지 못했습니다." : "한도를 불러오고 있어요."}
      </p>
    );
  }
  if (!Object.keys(capacity).length) return <p>연결된 공급자가 없습니다.</p>;
  return (
    <div className="capacity-list">
      {Object.entries(capacity).map(([connection, entry]) => {
        const name = connectionName(connection);
        const note = capacityNote(connection, entry);
        return (
          <div className="capacity-row" key={connection}>
            <strong>{name}</strong>
            {entry.kind === "subscription" &&
              entry.windows?.map((window) => {
                const label = windowName(window);
                const resetAt = Date.parse(window.resetsAt ?? "");
                return (
                  <div className="capacity-value" key={window.label}>
                    <span>
                      {label}
                      {Number.isFinite(resetAt) && (
                        <small>
                          <time dateTime={window.resetsAt}>
                            {resetTime.format(resetAt)}
                          </time>
                          에 초기화
                        </small>
                      )}
                    </span>
                    <b>{window.remainingPercent}% 남음</b>
                    <meter
                      min={0}
                      max={100}
                      value={window.remainingPercent}
                      aria-label={`${name} ${label} 잔여 비율`}
                    />
                  </div>
                );
              })}
            {entry.kind === "api_balance" &&
              entry.balances?.map((balance) => (
                <div className="capacity-value" key={balance.currency}>
                  <span>남은 잔액</span>
                  <b>
                    {balance.total}{" "}
                    {currencyNames[balance.currency] ?? balance.currency}
                  </b>
                </div>
              ))}
            {note && <small className="capacity-note">{note}</small>}
            {entry.status === "exact" &&
              entry.kind === "api_balance" &&
              !entry.balances?.length && (
                <small>공급자가 잔액을 보내지 않았어요.</small>
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
}: {
  onClose: () => void;
  onMetrics: () => void;
}) {
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
      <p>연결된 계정의 남은 한도와 잔액을 확인할 수 있어요.</p>
      <CapacityDetails />
      <button onClick={onMetrics}>모델별 사용 내역 보기</button>
    </section>
  );
}
