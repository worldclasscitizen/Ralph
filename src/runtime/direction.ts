import type { GraphRevision } from "../graph/schema.js";
import type { RunStore } from "../storage/run-store.js";
import { RalphError } from "../util.js";

export async function checkGenerationBudget(
  store: RunStore,
  graph: GraphRevision,
  limit: number,
): Promise<void> {
  const events = await store.readAfter();
  const generations = new Set(
    events.flatMap((e) =>
      e.type === "graph.revised"
        ? e.payload.graph.nodes.map((n) => `${n.nodeId}/${n.generation}`)
        : [],
    ),
  );
  for (const n of graph.nodes) generations.add(`${n.nodeId}/${n.generation}`);
  if (generations.size > limit)
    throw new RalphError("Total node budget exhausted", "budget_exhausted", 10);
}
