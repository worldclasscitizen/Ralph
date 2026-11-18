import { descendants } from "./compiler.js";
import type {
  GraphRevision,
  GraphRunState,
  NodeSpec,
  NodeResult,
  NodeFailure,
} from "./schema.js";
import type { RunStore } from "../storage/run-store.js";
import { redact } from "../util.js";

export class NodeExecutionError extends Error {
  constructor(readonly stage: NodeFailure["stage"], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}


export function readyNodes(
  graph: GraphRevision,
  state: GraphRunState,
): NodeSpec[] {
  return graph.nodes
    .filter(
      (n) =>
        ["pending", "queued"].includes(state.nodes[n.nodeId]?.status ?? "") &&
        graph.edges
          .filter((e) => e.to === n.nodeId)
          .every((e) => state.nodes[e.from]?.status === "completed"),
    )
    .sort(
      (a, b) =>
        descendants(graph, b.nodeId).size - descendants(graph, a.nodeId).size,
    );
}
export async function schedule(
  graph: GraphRevision,
  store: RunStore,
  concurrency: number,
  execute: (
    node: NodeSpec,
    signal: AbortSignal,
    graph: GraphRevision,
  ) => Promise<NodeResult>,
  signal: AbortSignal,
  beforeDispatch?: (
    state: GraphRunState,
    active: ReadonlySet<string>,
  ) => Promise<{ graph: GraphRevision; held?: ReadonlySet<string> }>,
): Promise<GraphRunState> {
  const running = new Map<string, Promise<void>>();
  let settled = 0;
  let wake: (() => void) | undefined;
  let failure: { error: unknown } | undefined;
  const launch = (node: NodeSpec) => {
    const dispatchedGraph = graph;
    const revision = dispatchedGraph.revision;
    const task = (async () => {
      await store.append(
        {
          type: "node.status",
          payload: {
            nodeId: node.nodeId,
            generation: node.generation,
            status: "running",
          },
        },
        revision,
      );
      let result: NodeResult;
      try {
        result = await execute(node, signal, dispatchedGraph);
      } catch (e) {
        const cause = e instanceof NodeExecutionError ? e.cause : e;
        const code = (cause as NodeJS.ErrnoException | undefined)?.code;
        await store.append(
          {
            type: "node.status",
            payload: {
              nodeId: node.nodeId,
              generation: node.generation,
              status: signal.aborted ? "interrupted" : "blocked",
              error: redact(e instanceof Error ? e.message : String(e)).slice(-8000),
              ...(!signal.aborted && {
                failure: {
                  stage: e instanceof NodeExecutionError ? e.stage : "execution",
                  code: typeof code === "string" && code.length > 0 ? code.slice(0, 100) : "unknown",
                },
              }),
            },
          },
          revision,
        );
        return;
      }

      await store.append(
        {
          type: "node.status",
          payload: {
            nodeId: node.nodeId,
            generation: node.generation,
            status: result.outcome,
            result,
          },
        },
        revision,
      );
    })();
    running.set(node.nodeId, task);
    const finish = () => {
      running.delete(node.nodeId);
      settled++;
      wake?.();
    };
    void task.then(finish, (error) => {
      failure ??= { error };
      finish();
    });
  };
  try {
    while (true) {
      const before = settled;
      const active = beforeDispatch && new Set(running.keys());
      let state = await store.state();
      let held: ReadonlySet<string> | undefined;
      if (failure) throw failure.error;
      if (!signal.aborted && beforeDispatch && active) {
        const next = await beforeDispatch(state, active);
        held = next.held;
        if (next.graph.revision !== graph.revision) {
          graph = next.graph;
          state = await store.state();
        }
      }
      if (settled !== before) continue;
      if (!signal.aborted) {
        for (const node of readyNodes(graph, state)) {
          if (running.size >= concurrency) break;
          if (!running.has(node.nodeId) && !held?.has(node.nodeId))
            launch(node);
        }
      }
      if (!running.size) break;
      await new Promise<void>((resolve) => {
        const timer = beforeDispatch
          ? setTimeout(() => wake?.(), 750)
          : undefined;
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
    }
  } finally {
    await Promise.all(running.values());
  }
  const state = await store.state();
  if (!signal.aborted)
    for (const node of graph.nodes)
      if (
        ["pending", "queued"].includes(state.nodes[node.nodeId]?.status ?? "")
      )
        await store.append(
          {
            type: "node.status",
            payload: {
              nodeId: node.nodeId,
              generation: node.generation,
              status: "blocked",
              error: "A required dependency did not complete",
            },
          },
          graph.revision,
        );
  return store.state();
}
