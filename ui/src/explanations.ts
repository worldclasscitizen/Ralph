import { useCallback, useEffect, useRef, useState } from "react";
import {
  explanationBatchSize,
  explanationInputLimit,
  type ExplanationItem,
  type ExplanationKind,
} from "../../src/dashboard/explanation-input";
import { api, apiPath } from "./presentation";

export type Explain = (kind: ExplanationKind, text?: string) => string | undefined;
type Candidate = { kind: ExplanationKind; text?: string };

function inputText(text?: string) {
  return typeof text === "string" ? text.trim().slice(0, explanationInputLimit) : "";
}
function key(kind: ExplanationKind, text: string) {
  return JSON.stringify([kind, text]);
}

export function useExplanations(runId: string, project: string, enabled: boolean, candidates: Candidate[]): Explain {
  const answers = useRef(new Map<string, string | null>());
  const inFlight = useRef(new Set<string>());
  const [refresh, setRefresh] = useState(0);
  const items = new Map<string, ExplanationItem>();
  for (const candidate of candidates) {
    const text = inputText(candidate.text);
    if (text) items.set(key(candidate.kind, text), { kind: candidate.kind, text });
  }
  const signature = JSON.stringify([...items.values()]);

  useEffect(() => {
    if (!runId || !enabled || signature === "[]") return;
    let cancelled = false;
    async function load() {
      const pending = (JSON.parse(signature) as ExplanationItem[]).filter(({ kind, text }) => {
        const id = key(kind, text);
        return !answers.current.has(id) && !inFlight.current.has(id);
      });
      if (!pending.length) return;
      try {
        const { controlToken } = await api("session");
        for (let offset = 0; offset < pending.length && !cancelled; offset += explanationBatchSize) {
          const batch = pending.slice(offset, offset + explanationBatchSize).filter(({ kind, text }) => {
            const id = key(kind, text);
            return !answers.current.has(id) && !inFlight.current.has(id);
          });
          if (!batch.length) continue;
          const keys = batch.map(({ kind, text }) => key(kind, text));
          keys.forEach((id) => inFlight.current.add(id));
          try {
            const response = await fetch(apiPath(`runs/${encodeURIComponent(runId)}/explanations`, project), {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-ralph-token": controlToken },
              body: JSON.stringify({ items: batch }),
            });
            if (!response.ok) break;
            const { status, explanations } = await response.json();
            if (!Array.isArray(explanations) || explanations.length !== batch.length) break;
            let received = false;
            keys.forEach((id, index) => {
              const text = explanations[index];
              if (typeof text === "string" || status === "ready") {
                answers.current.set(id, typeof text === "string" ? text : null);
                received = true;
              }
            });
            while (answers.current.size > 5_000) {
              answers.current.delete(answers.current.keys().next().value!);
            }
            if (received) setRefresh((count) => count + 1);
            if (status !== "ready") break;
          } finally {
            keys.forEach((id) => inFlight.current.delete(id));
          }
        }
      } catch {
        // The live graph keeps rendering while an optional explanation is unavailable.
      }
    }
    const timer = setTimeout(() => void load(), 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, project, runId, signature]);

  return useCallback(
    (kind, text) => enabled ? answers.current.get(key(kind, inputText(text))) ?? undefined : undefined,
    [enabled, refresh],
  );
}
