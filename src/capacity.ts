import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  CapacitySnapshot,
  CapacityWindow,
  ProjectConfig,
} from "./types.js";
import { adapterMap } from "./providers/index.js";
import {
  antigravityCapacitySource,
  readAntigravityCapacity,
} from "./providers/antigravity-capacity.js";
import { ensureState } from "./state.js";
import { resolveExecutable, writeJson } from "./util.js";

interface RateLimitWindow {
  usedPercent: number;
  resetsAt?: number | null;
  windowDurationMins?: number | null;
}
interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
}

function capacityWindow(
  label: string,
  window: RateLimitWindow,
): CapacityWindow {
  return {
    label,
    remainingPercent: Math.max(0, 100 - window.usedPercent),
    ...(window.windowDurationMins
      ? { durationMinutes: window.windowDurationMins }
      : {}),
    ...(window.resetsAt
      ? { resetsAt: new Date(window.resetsAt * 1000).toISOString() }
      : {}),
  };
}

async function codexCapacity(): Promise<CapacitySnapshot> {
  const executable = await resolveExecutable("codex");
  return await new Promise((resolve) => {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    const child = spawn(
      executable.command,
      [...executable.prefix, "app-server", "--stdio"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env },
    );
    let buffer = "";
    let settled = false;
    const finish = (value: CapacitySnapshot) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish({
          kind: "subscription",
          status: "unavailable",
          fetchedAt: new Date().toISOString(),
          source: "Codex App Server account/rateLimits/read",
          detail: "3초 안에 응답하지 않았습니다.",
        }),
      3_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as {
            id?: number;
            result?: {
              rateLimits?: RateLimitSnapshot;
              rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
            };
          };
          if (message.id !== 2 || !message.result) continue;
          clearTimeout(timer);
          const snapshots = message.result.rateLimitsByLimitId
            ? Object.values(message.result.rateLimitsByLimitId)
            : message.result.rateLimits
              ? [message.result.rateLimits]
              : [];
          const windows = snapshots.flatMap((snapshot) => {
            const name = snapshot.limitName ?? snapshot.limitId ?? "Codex";
            return [
              ...(snapshot.primary
                ? [capacityWindow(`${name} primary`, snapshot.primary)]
                : []),
              ...(snapshot.secondary
                ? [capacityWindow(`${name} secondary`, snapshot.secondary)]
                : []),
            ];
          });
          finish({
            kind: "subscription",
            status: windows.length ? "exact" : "unavailable",
            ...(windows.length ? { windows } : {}),
            fetchedAt: new Date().toISOString(),
            source: "Codex App Server account/rateLimits/read",
          });
        } catch {
          // notifications and non-JSON lines are ignored
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({
        kind: "subscription",
        status: "unavailable",
        fetchedAt: new Date().toISOString(),
        source: "Codex App Server account/rateLimits/read",
        detail: error.message,
      });
    });
    child.stdin.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "ralph", title: "Ralph CLI", version: "0.4.0" }, capabilities: null } })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ id: 2, method: "account/rateLimits/read", params: null })}\n`,
    );
  });
}

function unsupportedSubscription(
  source: string,
  detail: string,
): CapacitySnapshot {
  return {
    kind: "subscription",
    status: "unavailable",
    fetchedAt: new Date().toISOString(),
    source,
    detail,
  };
}

type ProjectCapacity = Record<string, CapacitySnapshot>;
const capacityInFlight = new Map<string, Promise<ProjectCapacity>>();

export async function capacityForProject(
  projectRoot: string,
  config: ProjectConfig,
  refresh = false,
): Promise<Record<string, CapacitySnapshot>> {
  const paths = await ensureState(projectRoot);
  const cache = join(paths.dashboard, "capacity-v3.json");
  const enabled = config.connections.filter((item) => item.enabled);
  let cached: ProjectCapacity = {};
  try {
    const info = await stat(cache);
    cached = JSON.parse(await readFile(cache, "utf8")) as ProjectCapacity;
    if (
      !refresh &&
      Date.now() - info.mtimeMs < 5 * 60 * 1000 &&
      Object.keys(cached).length === enabled.length &&
      enabled.every((connection) => Object.hasOwn(cached, connection.id))
    )
      return cached;
  } catch {
    /* refresh */
  }
  const requestKey = JSON.stringify([
    cache,
    enabled.map((item) => item.id).sort(),
  ]);
  const pending = capacityInFlight.get(requestKey);
  if (pending) return pending;
  const adapters = adapterMap(config);
  const load = async (): Promise<ProjectCapacity> => {
    const entries = await Promise.all(
      enabled.map(async (connection) => {
        const id = connection.id;
        let snapshot: CapacitySnapshot;
        if (connection.adapter === "codex-builtin")
          snapshot = await codexCapacity();
        else if (connection.adapter === "antigravity-builtin")
          snapshot = await readAntigravityCapacity().catch(() =>
            unsupportedSubscription(
              antigravityCapacitySource,
              "Gemini 구독 한도를 불러오지 못했습니다.",
            ),
          );
        else if (connection.adapter === "claude-code-builtin")
          snapshot = unsupportedSubscription(
            "Claude Code",
            "정확한 구조화 잔여량 인터페이스가 확인되지 않았습니다.",
          );
        else if (connection.adapter === "gemini-cli-builtin")
          snapshot = unsupportedSubscription(
            "Gemini CLI",
            "정확한 구조화 잔여량 인터페이스가 확인되지 않았습니다.",
          );
        else {
          const adapter = adapters.get(id);
          snapshot = adapter?.capacity
            ? await adapter.capacity()
            : {
                kind: "api_balance",
                status: "unavailable",
                fetchedAt: new Date().toISOString(),
                source: id,
                detail: "공식 잔액 endpoint가 확인되지 않았습니다.",
              };
        }
        const previous = cached[id];
        if (
          snapshot.status === "unavailable" &&
          (previous?.status === "exact" || previous?.status === "stale")
        )
          snapshot = { ...previous, status: "stale" };
        return [id, snapshot] as const;
      }),
    );
    const output = Object.fromEntries(entries);
    await writeJson(cache, output);
    return output;
  };
  const request = load();
  capacityInFlight.set(requestKey, request);
  try {
    return await request;
  } finally {
    capacityInFlight.delete(requestKey);
  }
}
