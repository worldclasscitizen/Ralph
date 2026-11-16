import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

export type Row = Record<string, any>;
export type Tone = "done" | "active" | "error" | "wait";

const iconSizes = {
  search: 17,
  chevron: 13,
  settings: 18,
  sun: 14,
  moon: 14,
  "sun-card": 20,
  "moon-card": 20,
  wallet: 16,
  inbox: 15,
  plan: 18,
  backend: 18,
  frontend: 18,
  review: 18,
  verify: 18,
  git: 18,
  minus: 15,
  plus: 15,
  fit: 15,
  branch: 15,
  "branch-direction": 16,
  close: 17,
  "close-capacity": 16,
  run: 14,
  check: 14,
  "check-footer": 15,
  fail: 14,
  wait: 14,
  activity: 16,
  file: 16,
  tool: 16,
} as const;
type IconName = keyof typeof iconSizes;
export function Icon({ name }: { name: IconName }) {
  return (
    <span
      aria-hidden="true"
      className="icon"
      style={
        {
          "--icon": `url("/icons/${name}.svg")`,
          "--icon-size": `${iconSizes[name]}px`,
        } as CSSProperties
      }
    />
  );
}

const statusLabels: Record<string, string> = {
  completed: "완료",
  running: "실행 중",
  verifying: "검증 중",
  queued: "호출 대기",
  failed: "실패",
  blocked: "진행 불가",
  retry_wait: "재시도 대기",
  cancelled: "취소됨",
  interrupted: "중단됨",
  pending: "시작 전",
  awaiting_input: "확인 필요",
  paused: "일시 정지",
  stopping: "중지 중",
  planning: "계획 중",
  ready: "준비됨",
};
export const statusLabel = (status?: string) =>
  status ? (statusLabels[status] ?? status) : "시작 전";

export function statusTone(status?: string): Tone {
  if (status === "completed") return "done";
  if (["running", "verifying", "planning", "stopping"].includes(status ?? ""))
    return "active";
  if (
    [
      "failed",
      "blocked",
      "interrupted",
      "retry_wait",
      "awaiting_input",
    ].includes(status ?? "")
  )
    return "error";
  return "wait";
}
const statusIcons = {
  done: "check",
  active: "run",
  error: "fail",
  wait: "wait",
} as const;
export function StatusBadge({
  status,
  footer,
}: {
  status?: string;
  footer?: boolean;
}) {
  const tone = statusTone(status);
  return (
    <span className="status-badge" data-tone={tone}>
      <Icon
        name={footer && tone === "done" ? "check-footer" : statusIcons[tone]}
      />
    </span>
  );
}

const taskIcons: Record<string, IconName> = {
  planning_architecture: "plan",
  frontend_visual: "frontend",
  backend_core: "backend",
  tdd_debugging: "verify",
  static_review: "review",
  delivery_evidence: "file",
};
export function TaskIcon({ task }: { task: Row }) {
  const name =
    task.kind === "integrate"
      ? "git"
      : task.kind === "validate"
        ? "verify"
        : (taskIcons[task.taskType] ?? "plan");
  return <Icon name={name} />;
}
export const nodeTitle = (task: Row) => task.goal || task.nodeId;
export function modelLabel(task: Row) {
  if (task.modelId) return task.modelId;
  if (task.kind === "integrate") return "로컬 Git";
  if (task.kind === "validate") return "로컬 검증";
  return "";
}

export const formatTime = (date: string) =>
  new Date(date).toLocaleTimeString("ko-KR", {
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export function Elapsed({
  startedAt,
  endedAt,
  active,
}: {
  startedAt?: string;
  endedAt?: string;
  active: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!startedAt || !active || endedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt, endedAt, active]);
  if (!startedAt || (!endedAt && !active)) return null;
  const elapsed = Math.max(
    0,
    Math.floor(
      ((endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt)) / 1000,
    ),
  );
  if (!Number.isFinite(elapsed)) return null;
  return (
    <>
      {" "}
      · {elapsed >= 60 && `${Math.floor(elapsed / 60)}분 `}
      {elapsed % 60}초
    </>
  );
}

export async function dashboardGet(path: string) {
  const response = await fetch(path);
  if (!response.ok) throw new Error((await response.json()).error);
  return response.json();
}
export const api = (path: string) => dashboardGet(`/api/v2/${path}`);
