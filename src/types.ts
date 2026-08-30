export const TASK_TYPES = [
  "planning_architecture",
  "frontend_visual",
  "backend_core",
  "tdd_debugging",
  "static_review",
  "delivery_evidence",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];
export type ExecutionProfile = "balanced" | "quality" | "fast" | "budget";
export type AgentRole =
  | "contractPlanner"
  | "critic"
  | "metaPrompter"
  | "worker"
  | "adjudicator";

export interface TaskContract {
  id: string;
  taskType: TaskType;
  goal: string;
  include: string[];
  exclude: string[];
  requirements: string[];
  acceptanceCriteria: string[];
  verifierCommands: string[];
  requiredArtifacts: string[];
  attachments: string[];
  constraints: string[];
  executionProfile: ExecutionProfile;
  projectRoot: string;
  modelOverride?: string;
  routeSnapshot?: ProjectConfig["routes"];
  approvedCatalogVersion?: number;
  approvedHash?: string;
  approvedAt?: string;
}

export interface ProviderDetection {
  installed: boolean;
  executable?: string;
  version?: string;
  detail?: string;
}

export interface AuthStatus {
  status: "authenticated" | "unauthenticated" | "unknown" | "unavailable";
  method?: "builtin" | "api_key" | "process";
  accountLabel?: string;
  detail?: string;
}

export interface ModelDescriptor {
  connectionId: string;
  provider: string;
  modelId: string;
  displayName: string;
  mode: "builtin" | "api" | "process";
  reasoningEffort?: string;
}

export interface AgentRequest {
  runId: string;
  nodeId: string;
  role: AgentRole;
  model: ModelDescriptor;
  projectRoot: string;
  prompt: string;
  sessionId?: string;
  tools?: ToolDefinition[];
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
}

export interface AgentResult {
  text: string;
  exitCode: number;
  sessionId?: string;
  usage?: AgentUsage;
  rawModelId?: string;
  usageCumulative?: boolean;
  error?: ProviderError;
}

export type ProviderErrorKind =
  | "rate_limit"
  | "quota"
  | "timeout"
  | "server_error"
  | "overloaded"
  | "empty_response"
  | "schema_error"
  | "authentication"
  | "invalid_request"
  | "policy_denial"
  | "unavailable"
  | "unknown";

export interface ProviderError {
  kind: ProviderErrorKind;
  message: string;
  retryable: boolean;
  statusCode?: number;
  evidencePath?: string;
}

export interface SessionHandle {
  id: string;
  provider: string;
}

export interface CapacityWindow {
  label: string;
  remainingPercent: number;
  resetsAt?: string;
}

export type CapacitySnapshot =
  | {
      kind: "subscription";
      status: "exact" | "unavailable" | "auth_required" | "stale";
      windows?: CapacityWindow[];
      fetchedAt: string;
      source: string;
      detail?: string;
    }
  | {
      kind: "api_balance";
      status: "exact" | "unavailable" | "auth_required" | "stale";
      balances?: Array<{
        currency: string;
        total: string;
        granted?: string;
        toppedUp?: string;
      }>;
      fetchedAt: string;
      source: string;
      detail?: string;
    };

export interface ProviderAdapter {
  id: string;
  mode: "builtin" | "api" | "process";
  detect(): Promise<ProviderDetection>;
  authStatus(): Promise<AuthStatus>;
  listModels(): Promise<ModelDescriptor[]>;
  invoke(request: AgentRequest, signal: AbortSignal): Promise<AgentResult>;
  interrupt?(handle: SessionHandle): Promise<void>;
  capacity?(): Promise<CapacitySnapshot>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CatalogModel {
  provider: string;
  adapter: string;
  modelId: string;
  displayName: string;
  releasedAt: string;
  expiresAt: string;
  capabilities: {
    reasoning: number;
    coding: number;
    structuredOutput: boolean;
    vision: boolean;
    toolUse: boolean;
    longContext: boolean;
  };
  taskAffinity: Record<TaskType, number>;
  costTier: number;
  latencyTier: number;
  reliabilityBaseline: number;
  supportedEfforts: string[];
  recommendedEffort: string;
  evidence: Array<{ source: string; checkedAt: string }>;
}

export interface ModelCatalog {
  schemaVersion: 1;
  version: number;
  generatedAt: string;
  models: CatalogModel[];
}

export interface ConnectionConfig {
  id: string;
  adapter: string;
  provider: string;
  enabled: boolean;
  mode: "builtin" | "api" | "process";
  apiKeyEnv?: string;
  baseUrl?: string;
  command?: string[];
  models?: string[];
}

export interface RouteEntry {
  connectionId: string;
  provider: string;
  modelId: string;
  displayName: string;
  reasoningEffort: string;
  score: number;
  source: "automatic" | "override";
  degradedCapabilities?: string[];
}

export interface ProjectConfig {
  schemaVersion: 1;
  projectRoot: string;
  preset: ExecutionProfile;
  initializedAt: string;
  connections: ConnectionConfig[];
  routes: Record<TaskType | AgentRole, RouteEntry[]>;
  overrides: Partial<Record<TaskType | AgentRole, RouteEntry[]>>;
  verifierCommands: string[];
  catalogVersion: number;
}

export type RunVerdict = "running" | "pass" | "retry" | "needs_operator" | "failed" | "interrupted" | "interrupted_partial";

export interface RunState {
  id: string;
  projectRoot: string;
  contractId: string;
  taskType: TaskType;
  status: RunVerdict;
  iteration: number;
  maxIterations: number;
  currentNode?: string;
  startedAt: string;
  endedAt?: string;
  pid: number;
  catalogVersion: number;
  routes: ProjectConfig["routes"];
  score?: number;
  verdict?: RunVerdict;
  lastCheckpoint?: string;
  stopRequested?: boolean;
}

export interface RalphEvent {
  timestamp: string;
  runId: string;
  type: string;
  node?: string;
  status?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface CriterionAssessment {
  id: string;
  level: "absent" | "partial" | "verified" | "complete";
  evidence: string[];
  explanation?: string;
}

export interface CriticAssessment {
  criteria: CriterionAssessment[];
  hardGates: Array<{
    id: string;
    status: "pass" | "fail" | "unknown";
    evidence: string[];
  }>;
  findings: Array<{
    severity: "low" | "medium" | "high" | "critical";
    summary: string;
    evidence: string[];
  }>;
}

export interface EvaluationResult {
  score: number;
  verdict: "pass" | "retry" | "needs_operator";
  hardGateFailures: string[];
  hardGateUnknown: string[];
  criterionScores: Record<string, number>;
  reason: string;
}
