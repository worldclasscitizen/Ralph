import { descendants } from "../graph/compiler.js";
import { reviseGraph } from "../graph/revisions.js";
import type {
  GraphRevision,
  GraphRunState,
  NodeSpec,
} from "../graph/schema.js";
import type { ExecutionPlan } from "../interaction/approval.js";
import { classifyRisk } from "../policy.js";
import type { RunStore } from "../storage/run-store.js";
import { RalphError } from "../util.js";
import type { RunCommand } from "./commands.js";

export function directionConstraint(node: NodeSpec): string {
  return `User direction for ${node.nodeId}, within the approved goal, scope and completion criteria: ${node.direction}`;
}

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

export async function applyDirection(
  store: RunStore,
  plan: ExecutionPlan,
  state: GraphRunState,
  active: ReadonlySet<string>,
  command: RunCommand,
): Promise<{ graph: GraphRevision; held?: ReadonlySet<string> }> {
  const previous = plan.graph;
  const reject = async (error: string) => {
    await store.append(
      {
        type: "command.applied",
        payload: { commandId: command.commandId, result: { error } },
      },
      previous.revision,
    );
    return { graph: previous };
  };
  if (command.expectedRevision !== previous.revision)
    return reject(
      "The graph changed. Review the latest revision and try again.",
    );
  if (previous.nodes.some((n) => n.nodeId === "repair"))
    return reject(
      "Direction changes are unavailable on a graph with a repair worker.",
    );
  const target = previous.nodes.find(
    (n) => n.kind === "worker" && n.nodeId === command.nodeId,
  );
  if (!target) return reject("Select a worker in the current graph.");
  if (target.direction === command.instruction)
    return reject("This direction is already applied.");

  const updated = { ...target, direction: command.instruction };
  const directionRisk = classifyRisk({
    ...plan.contract,
    riskTier: undefined,
    goal: command.instruction!,
    include: [],
    requirements: [],
    constraints: [],
  });
  if (directionRisk > classifyRisk(plan.contract))
    return reject(
      "This direction may increase the approved risk. Review a new plan for it.",
    );

  const affected = new Set([
    target.nodeId,
    ...descendants(previous, target.nodeId),
  ]);
  if (
    previous.revision >= plan.budget.maxRevisions ||
    previous.nodes.some(
      (n) =>
        affected.has(n.nodeId) &&
        n.kind === "worker" &&
        (state.nodes[n.nodeId]?.iteration ?? 0) >= n.budget.maxIterations,
    )
  )
    return reject("There is no remaining revision or worker iteration budget.");

  if ([...affected].some((id) => id.startsWith("recover-")) &&
      (await store.readAfter()).some((event) =>
        event.type === "graph.revised" && event.payload.recovery?.patchBase &&
        affected.has(event.payload.recovery.workerId ?? ""),
      ))
    return reject("This direction changes the input of a recovery worker. Review a new plan.");
  if ([...active].some((id) => affected.has(id)))
    return { graph: previous, held: affected };

  let graph: GraphRevision;
  try {
    graph = reviseGraph(
      previous,
      {
        ...previous,
        reason: "steering",
        nodes: previous.nodes.map((n) =>
          n.nodeId === target.nodeId ? updated : n,
        ),
      },
      state.nodes,
      plan.envelope,
    );
    await checkGenerationBudget(store, graph, plan.budget.maxTotalNodes);
  } catch (e) {
    if (!(e instanceof RalphError)) throw e;
    return reject(e.message);
  }
  await store.append(
    {
      type: "graph.revised",
      payload: {
        graph,
        direction: {
          commandId: command.commandId,
          nodeId: target.nodeId,
          rerun: graph.nodes
            .filter((n) => affected.has(n.nodeId))
            .map((n) => n.nodeId),
          reused: graph.nodes
            .filter(
              (n) =>
                !affected.has(n.nodeId) &&
                state.nodes[n.nodeId]?.status === "completed",
            )
            .map((n) => n.nodeId),
        },
      },
    },
    graph.revision,
  );
  return { graph };
}
