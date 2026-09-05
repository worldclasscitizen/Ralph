import { open, unlink, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { atomicJson, sha256 } from "./release.mjs";
import { LiveTestBudgetSchema, assertReleaseSchema } from "../../dist/release/schema.js";

/** Persistent call accounting with a shared active-time ceiling; no call-count cap. */
export class LiveBudget {
  constructor(path, releaseId = "ralph-0.3.0") { this.path = path; this.releaseId = releaseId; }
  async locked(fn) {
    await mkdir(dirname(this.path), { recursive: true });
    const guard = await open(`${this.path}.lock`, "wx", 0o600);
    try { return await fn(); }
    finally { await guard.close(); await unlink(`${this.path}.lock`); }
  }
  async load() { return this.locked(() => this.loadLocked()); }
  async loadLocked() {
    let state, bytes;
    try { bytes = await readFile(this.path); state = JSON.parse(bytes); }
    catch (e) {
      if (e.code !== "ENOENT") throw e;
      state = { schemaVersion: 2, releaseId: this.releaseId, maxCalls: null, maxActiveMs: 1800000,
        apiSpendUsd: 0, calls: 0, activeMs: 0, pending: null, attempts: [] };
      await atomicJson(this.path, state);
    }
    assertReleaseSchema(LiveTestBudgetSchema, state);
    if (state.releaseId !== this.releaseId) throw new Error("Budget belongs to another release");
    if (state.schemaVersion === 1) {
      const digest = sha256(bytes), backup = `${this.path}.v1-${digest}.json`;
      try { await writeFile(backup, bytes, { flag: "wx", mode: 0o600 }); }
      catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (sha256(await readFile(backup)) !== digest) throw new Error("Previous ledger archive integrity mismatch");
      }
      state = { ...state, schemaVersion: 2, maxCalls: null, previousLedger: {
        file: basename(backup), sha256: digest, changedAt: new Date().toISOString(), reason: "call_count_cap_removed",
      } };
      assertReleaseSchema(LiveTestBudgetSchema, state);
      await atomicJson(this.path, state);
    }
    return state;
  }
  async invoke(purpose, fn, outerSignal, maxMs = 90_000) {
    return this.locked(async () => {
      const state = await this.loadLocked();
      if (state.pending) throw new Error("Unconfirmed live call; inspect the retained process before further spending");
      if (state.activeMs >= state.maxActiveMs) throw new Error("Live release active time budget exhausted");
      const reservedMs = Math.min(maxMs, state.maxActiveMs - state.activeMs);
      const attemptId = randomUUID(), startedAt = Date.now();
      state.calls++;
      state.pending = { attemptId, startedAt, reservedMs };
      await atomicJson(this.path, state);
      let outcome = "failed", usage = null;
      try {
        const signal = AbortSignal.any([AbortSignal.timeout(reservedMs), ...(outerSignal ? [outerSignal] : [])]);
        const value = await fn(signal);
        usage = value?.usage ?? null;
        outcome = value?.exitCode && value.exitCode !== 0 ? "failed" : "returned";
        return value;
      } finally {
        const durationMs = Date.now() - startedAt;
        state.activeMs += durationMs;
        state.pending = null;
        state.attempts.push({ attemptId, purpose, durationMs, outcome, usage });
        await atomicJson(this.path, state);
      }
    });
  }
}
