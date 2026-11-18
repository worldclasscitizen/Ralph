import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CapacitySnapshot, CapacityWindow } from "../types.js";
import { runCommand } from "../util.js";
import { cleanGoogleBuiltinEnv } from "./cli.js";

export const antigravityCapacitySource = "Antigravity CLI statusLine";

const capture = `
const fs = require("node:fs");
const path = require("node:path");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
if (input.product === "antigravity" && input.quota && Object.keys(input.quota).length) {
  const quota = Object.fromEntries(Object.entries(input.quota).map(([key, value]) => {
    const { remaining_fraction, reset_time, reset_in_seconds, disabled } = value ?? {};
    return [key, { remaining_fraction, reset_time, reset_in_seconds, disabled }];
  }));
  const temporary = path.join(__dirname, "quota-" + process.pid + ".json");
  fs.writeFileSync(temporary, JSON.stringify(quota), { mode: 0o600 });
  fs.renameSync(temporary, path.join(__dirname, "quota.json"));
}
`;

const shellQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\\''") + "'";

export function antigravityWindows(
  value: unknown,
  now: number,
): CapacityWindow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const windows: CapacityWindow[] = [];
  for (const [label, raw] of Object.entries(value)) {
    if (!label.startsWith("gemini-") || !raw || typeof raw !== "object") continue;
    const { remaining_fraction, reset_time, reset_in_seconds, disabled } = raw;
    if (
      disabled === true ||
      typeof remaining_fraction !== "number" ||
      !Number.isFinite(remaining_fraction) ||
      remaining_fraction < 0 ||
      remaining_fraction > 1
    )
      continue;
    const durationMinutes = label.endsWith("-5h")
      ? 300
      : label.endsWith("-weekly")
        ? 10080
        : undefined;
    let reset = typeof reset_time === "string" ? Date.parse(reset_time) : NaN;
    if (
      !Number.isFinite(reset) &&
      Number.isFinite(reset_in_seconds) &&
      reset_in_seconds >= 0
    )
      reset = now + reset_in_seconds * 1000;
    windows.push({
      label,
      remainingPercent: Math.round(remaining_fraction * 1000) / 10,
      ...(durationMinutes ? { durationMinutes } : {}),
      ...(Number.isFinite(reset) && Math.abs(reset) <= 8.64e15
        ? { resetsAt: new Date(reset).toISOString() }
        : {}),
    });
  }
  return windows;
}

export async function readAntigravityCapacity(): Promise<CapacitySnapshot> {
  let windows: CapacityWindow[] = [];
  if (process.platform === "darwin" || process.platform === "linux") {
    const root = await mkdtemp(join(tmpdir(), "ralph-agy-capacity-"));
    try {
      const hook = join(root, "status.cjs");
      await writeFile(hook, capture, { mode: 0o600 });
      const command = [process.execPath, hook].map(shellQuote).join(" ");
      const settings = JSON.stringify({
        statusLine: { type: "command", command, enabled: true },
      });
      const args = ["agy", "--mode", "plan", "--settings", settings];
      const terminalArgs =
        process.platform === "darwin"
          ? ["-q", "/dev/null", ...args]
          : ["-q", "-c", args.map(shellQuote).join(" "), "/dev/null"];
      // The CLI sends its documented JSON to the status hook only in a terminal session.
      // This session has an empty workspace and receives no model prompt.
      const pipe = join(root, "input");
      const fifo = await runCommand("mkfifo", [pipe], { timeoutMs: 1_000 });
      if (fifo.exitCode !== 0)
        throw new Error("Could not allocate terminal input");
      // macOS script rejects the socket Node uses for child stdio pipes.
      const input = await open(pipe, "r+");
      const child = spawn(
        "/bin/sh",
        [
          "-c",
          'fifo=$1; shift; cat "$fifo" | "$@"',
          "ralph-quota",
          pipe,
          "script",
          ...terminalArgs,
        ],
        {
          cwd: root,
          env: { ...cleanGoogleBuiltinEnv(), TERM: "xterm-256color" },
          stdio: "ignore",
          detached: true,
        },
      );
      let closed = false;
      const finished = new Promise<void>((resolve) => {
        const done = () => {
          closed = true;
          resolve();
        };
        child.once("error", done);
        child.once("close", done);
      });
      try {
        const deadline = Date.now() + 8_000;
        while (!closed && Date.now() < deadline) {
          try {
            windows = antigravityWindows(
              JSON.parse(await readFile(join(root, "quota.json"), "utf8")),
              Date.now(),
            );
            if (windows.length) break;
          } catch {
            // The hook has not written a snapshot yet.
          }
          await delay(150);
        }
      } finally {
        if (!closed) await input.write("\x04").catch(() => {});
        await input.close();
        await Promise.race([finished, delay(300)]);
        if (!closed && child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            /* already exited */
          }
        }
        await Promise.race([finished, delay(500)]);
        if (!closed && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already exited */
          }
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
  return {
    kind: "subscription",
    status: windows.length ? "exact" : "unavailable",
    ...(windows.length ? { windows } : {}),
    fetchedAt: new Date().toISOString(),
    source: antigravityCapacitySource,
  };
}
