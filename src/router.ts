import type {
  AgentRole,
  CatalogModel,
  ConnectionConfig,
  ExecutionProfile,
  ModelCatalog,
  ProjectConfig,
  RouteEntry,
  TaskType,
} from "./types.js";
import { TASK_TYPES } from "./types.js";

const ROLE_TASK: Record<AgentRole, TaskType> = {
  contractPlanner: "planning_architecture",
  critic: "static_review",
  metaPrompter: "planning_architecture",
  worker: "backend_core",
  adjudicator: "static_review",
};

const WEIGHTS: Record<ExecutionProfile, { fit: number; reliability: number; diversity: number; speed: number; cost: number }> = {
  balanced: { fit: 0.5, reliability: 0.25, diversity: 0.15, speed: 0.05, cost: 0.05 },
  quality: { fit: 0.7, reliability: 0.2, diversity: 0.1, speed: 0, cost: 0 },
  fast: { fit: 0.35, reliability: 0.15, diversity: 0, speed: 0.45, cost: 0.05 },
  budget: { fit: 0.35, reliability: 0.15, diversity: 0, speed: 0.05, cost: 0.45 },
};

function scoreModel(model: CatalogModel, task: TaskType, preset: ExecutionProfile): number {
  const weights = WEIGHTS[preset];
  const fit = model.taskAffinity[task] ?? (model.capabilities.coding + model.capabilities.reasoning) / 2;
  const speed = Math.max(0, 100 - model.latencyTier * 20);
  const cost = Math.max(0, 100 - model.costTier * 20);
  return Number(
    (fit * weights.fit + model.reliabilityBaseline * weights.reliability + speed * weights.speed + cost * weights.cost).toFixed(2),
  );
}

function supportsTask(model: CatalogModel, task: TaskType): boolean {
  if (task === "frontend_visual" || task === "delivery_evidence") return model.capabilities.vision;
  return true;
}

function connectionSupportsModel(connection: ConnectionConfig, model: CatalogModel): boolean {
  if (connection.adapter === model.adapter) return true;
  return (
    (connection.adapter === "openai-api" && model.adapter === "codex-builtin") ||
    (connection.adapter === "anthropic-api" && model.adapter === "claude-code-builtin") ||
    (connection.adapter === "gemini-api" && model.adapter === "gemini-cli-builtin")
  );
}

function routeFor(
  catalog: ModelCatalog,
  connections: ConnectionConfig[],
  task: TaskType,
  preset: ExecutionProfile,
): RouteEntry[] {
  const now = Date.now();
  const allCandidates = catalog.models
    .filter((model) => Date.parse(model.expiresAt) >= now)
    .flatMap((model) =>
      connections
        .filter((connection) => connection.enabled && connectionSupportsModel(connection, model))
        .filter((connection) => !connection.models || connection.models.includes(model.modelId))
        .map((connection) => ({
          connectionId: connection.id,
          provider: model.provider,
          modelId: model.modelId,
          displayName: model.displayName,
          reasoningEffort: model.recommendedEffort,
          score: scoreModel(model, task, preset),
          source: "automatic" as const,
          ...(supportsTask(model, task) ? {} : { degradedCapabilities: ["vision"] }),
        })),
    );
  const capable = allCandidates.filter((candidate) => !candidate.degradedCapabilities?.length);
  const candidates = capable.length ? capable : allCandidates;

  const chosen: RouteEntry[] = [];
  const usedProviders = new Set<string>();
  const remaining = [...candidates];
  while (chosen.length < 3 && remaining.length) {
    const diversityWeight = WEIGHTS[preset].diversity * 100;
    remaining.sort((a, b) => {
      const aScore = a.score + (chosen.length > 0 && !usedProviders.has(a.provider) ? diversityWeight : 0);
      const bScore = b.score + (chosen.length > 0 && !usedProviders.has(b.provider) ? diversityWeight : 0);
      return bScore - aScore || a.connectionId.localeCompare(b.connectionId) || a.modelId.localeCompare(b.modelId);
    });
    const candidate = remaining.shift()!;
    const effectiveScore = candidate.score + (chosen.length > 0 && !usedProviders.has(candidate.provider) ? diversityWeight : 0);
    chosen.push({ ...candidate, score: Number(effectiveScore.toFixed(2)) });
    usedProviders.add(candidate.provider);
  }
  return chosen;
}

export function buildRoutes(
  catalog: ModelCatalog,
  connections: ConnectionConfig[],
  preset: ExecutionProfile,
  overrides: ProjectConfig["overrides"] = {},
): ProjectConfig["routes"] {
  const routes = {} as ProjectConfig["routes"];
  for (const task of TASK_TYPES) routes[task] = overrides[task] ?? routeFor(catalog, connections, task, preset);
  for (const role of ["contractPlanner", "critic", "metaPrompter", "worker", "adjudicator"] as AgentRole[]) {
    routes[role] = overrides[role] ?? routeFor(catalog, connections, ROLE_TASK[role], preset);
  }
  return routes;
}

export function explainRoutes(config: ProjectConfig): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config.routes).map(([key, chain]) => [
      key,
      chain.map((entry, index) => ({
        order: index + 1,
        connection: entry.connectionId,
        model: entry.modelId,
        displayName: entry.displayName,
        effort: entry.reasoningEffort,
        score: entry.score,
        source: entry.source,
        ...(entry.degradedCapabilities?.length ? { degradedCapabilities: entry.degradedCapabilities } : {}),
      })),
    ]),
  );
}
