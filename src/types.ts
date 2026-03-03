/**
 * Clawforce — Core types
 *
 * Task lifecycle, transitions, evidence, and workflow types
 * for the autonomous project management layer.
 */

export type TaskState =
  | "OPEN"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "REVIEW"
  | "DONE"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED";

export const TASK_STATES: readonly TaskState[] = ["OPEN", "ASSIGNED", "IN_PROGRESS", "REVIEW", "DONE", "FAILED", "BLOCKED", "CANCELLED"] as const;

export type TaskPriority = "P0" | "P1" | "P2" | "P3";

export const TASK_PRIORITIES: readonly TaskPriority[] = ["P0", "P1", "P2", "P3"] as const;

export type EvidenceType = "output" | "diff" | "test_result" | "screenshot" | "log" | "custom";

export const EVIDENCE_TYPES: readonly EvidenceType[] = ["output", "diff", "test_result", "screenshot", "log", "custom"] as const;

export type Evidence = {
  id: string;
  taskId: string;
  type: EvidenceType;
  content: string;
  contentHash: string;
  attachedBy: string;
  attachedAt: number;
  metadata?: Record<string, unknown>;
};

export type Task = {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  state: TaskState;
  priority: TaskPriority;
  assignedTo?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  deadline?: number;
  retryCount: number;
  maxRetries: number;
  tags?: string[];
  workflowId?: string;
  workflowPhase?: number;
  parentTaskId?: string;
  department?: string;
  team?: string;
  metadata?: Record<string, unknown>;
};

export type Transition = {
  id: string;
  taskId: string;
  fromState: TaskState;
  toState: TaskState;
  actor: string;
  actorSignature?: string;
  reason?: string;
  evidenceId?: string;
  createdAt: number;
};

export type Workflow = {
  id: string;
  projectId: string;
  name: string;
  phases: WorkflowPhase[];
  currentPhase: number;
  state: "active" | "completed" | "failed";
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type WorkflowPhase = {
  name: string;
  description?: string;
  taskIds: string[];
  gateCondition?: "all_done" | "any_done" | "all_resolved" | "any_resolved";
};

export type TransitionResult =
  | { ok: true; task: Task; transition: Transition }
  | { ok: false; reason: string };

export type TaskResult =
  | { ok: true; task: Task }
  | { ok: false; reason: string };

/**
 * Callback that registers a cron job with the gateway's cron service.
 * Provided by the gateway at init time since clawforce has no direct gateway access.
 */
export type CronRegistrar = (job: CronRegistrarInput) => Promise<void>;

/** Minimal cron job shape for the registrar (mirrors CronJobCreate essentials). */
export type CronRegistrarInput = {
  name: string;
  agentId: string;
  enabled: boolean;
  schedule: { kind: "every"; everyMs: number };
  sessionTarget: "isolated";
  wakeMode: "now";
  payload: { kind: "agentTurn"; message: string };
};

export type ClawforceConfig = {
  enabled: boolean;
  projectsDir: string;
  sweepIntervalMs: number;
  defaultMaxRetries: number;
  verificationRequired: boolean;
  cronRegistrar?: CronRegistrar;
};

// --- Agent Enforcement Framework types ---

/** Role determines default behavior and management patterns. */
export type AgentRole = "manager" | "employee" | "scheduled";

/** A context source to inject at session start. */
export type ContextSource = {
  source: "instructions" | "custom" | "project_md" | "task_board" | "assigned_task" | "knowledge" | "file" | "skill" | "memory" | "escalations" | "workflows" | "activity" | "sweep_status" | "proposals" | "agent_status" | "cost_summary" | "policy_status" | "health_status" | "team_status" | "team_performance";
  /** Raw markdown content (for source: "custom"). */
  content?: string;
  /** File path (for source: "file"). */
  path?: string;
  /** Knowledge filter (for source: "knowledge"). */
  filter?: {
    category?: string[];
    tags?: string[];
  };
};

/** A deliverable the agent is responsible for completing. */
export type Expectation = {
  tool: string;
  action: string | string[];
  min_calls: number;
};

/** @deprecated Use Expectation instead. */
export type RequiredOutput = Expectation;

/** What happens when an employee doesn't meet expectations. */
export type PerformancePolicy = {
  action: "retry" | "alert" | "terminate_and_alert";
  max_retries?: number;
  /** Escalation action after max_retries exhausted. */
  then?: "alert" | "terminate_and_alert";
};

/** @deprecated Use PerformancePolicy instead. */
export type FailureAction = PerformancePolicy;

/** Compaction configuration for an agent. */
export type CompactionConfig = {
  enabled: boolean;
  /** Explicit file targets (relative to project dir). If omitted, derived from briefing. */
  files?: string[];
};

/** Permissions granted to an agent. */
export type AgentPermissions = {
  /** Can this agent create new agents? */
  can_hire?: boolean;
  /** Can this agent disable/remove agents? */
  can_fire?: boolean;
  /** Maximum daily spend in cents. */
  budget_limit_cents?: number;
};

/** Per-agent configuration. */
export type AgentConfig = {
  role: AgentRole;
  /** Job title (e.g. "VP of Engineering"). */
  title?: string;
  /** AI model to use (e.g. "claude-opus-4-6"). */
  model?: string;
  /** Model provider (e.g. "anthropic"). */
  provider?: string;
  /** System prompt personality for this agent. */
  persona?: string;
  /** Tools this agent is allowed to use. */
  tools?: string[];
  /** Agent permissions. */
  permissions?: AgentPermissions;
  /** Communication channel (e.g. "telegram", "slack"). */
  channel?: string;
  /** Department this agent belongs to (e.g. "engineering", "sales"). */
  department?: string;
  /** Team within the department (e.g. "frontend", "lead-gen"). */
  team?: string;
  briefing: ContextSource[];
  /** Sources to exclude from the role's default profile baseline. */
  exclude_briefing?: string[];
  expectations: Expectation[];
  performance_policy: PerformancePolicy;
  /**
   * Where performance issues escalate when retries are exhausted.
   * - "parent" (default): rely on subagent auto-announce to parent session.
   * - "<agentName>": inject failure message into that agent's session.
   */
  reports_to?: string;
  /**
   * Session compaction configuration.
   * When enabled, the agent is instructed to update its context files with learnings.
   * - true/false: enable/disable
   * - CompactionConfig: fine-grained control
   * - undefined: use role profile default
   */
  compaction?: boolean | CompactionConfig;
};

/** Top-level approval policy configuration. */
export type ApprovalPolicy = {
  /** Natural language policy text — served to manager at decision time. */
  policy: string;
};

/** Full project config with workforce management. */
export type WorkforceConfig = {
  name: string;
  approval?: ApprovalPolicy;
  agents: Record<string, AgentConfig>;
  budgets?: {
    project?: BudgetConfig;
    agents?: Record<string, BudgetConfig>;
  };
  policies?: Array<{
    name: string;
    type: string;
    target?: string;
    config: Record<string, unknown>;
  }>;
  monitoring?: {
    slos?: Record<string, Record<string, unknown>>;
    anomalyDetection?: Record<string, Record<string, unknown>>;
    alertRules?: Record<string, Record<string, unknown>>;
  };
  riskTiers?: RiskTierConfig;
};

/** @deprecated Use WorkforceConfig instead. */
export type EnforcementProjectConfig = WorkforceConfig;

// --- Event-driven dispatch types ---

export type EventType =
  | "ci_failed"
  | "pr_opened"
  | "deploy_finished"
  | "task_completed"
  | "task_failed"
  | "sweep_finding"
  | "dispatch_succeeded"
  | "dispatch_failed"
  | "task_review_ready"
  | "dispatch_dead_letter"
  | "custom";

export const EVENT_TYPES: readonly EventType[] = [
  "ci_failed", "pr_opened", "deploy_finished", "task_completed",
  "task_failed", "sweep_finding", "dispatch_succeeded", "dispatch_failed",
  "task_review_ready", "dispatch_dead_letter", "custom",
] as const;

export type EventSource = "tool" | "internal" | "cron";

export type EventStatus = "pending" | "processing" | "handled" | "failed" | "ignored";

export type ClawforceEvent = {
  id: string;
  projectId: string;
  type: EventType;
  source: EventSource;
  payload: Record<string, unknown>;
  dedupKey?: string;
  status: EventStatus;
  error?: string;
  handledBy?: string;
  createdAt: number;
  processedAt?: number;
};

export type DispatchQueueStatus = "queued" | "leased" | "dispatched" | "completed" | "failed" | "cancelled";

export type DispatchQueueItem = {
  id: string;
  projectId: string;
  taskId: string;
  priority: number;
  payload?: Record<string, unknown>;
  status: DispatchQueueStatus;
  leasedBy?: string;
  leasedAt?: number;
  leaseExpiresAt?: number;
  dispatchAttempts: number;
  maxDispatchAttempts: number;
  lastError?: string;
  createdAt: number;
  completedAt?: number;
};

export type TaskLease = {
  holder: string;
  acquiredAt: number;
  expiresAt: number;
};

// --- Cost tracking types ---

export type CostRecord = {
  id: string;
  projectId: string;
  agentId: string;
  sessionKey?: string;
  taskId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costCents: number;
  model?: string;
  source: string;
  createdAt: number;
};

export type BudgetConfig = {
  dailyLimitCents?: number;
  sessionLimitCents?: number;
  taskLimitCents?: number;
};

export type BudgetCheckResult = {
  ok: boolean;
  remaining?: number;
  reason?: string;
};

// --- Policy enforcement types ---

export type PolicyType = "action_scope" | "transition_gate" | "spend_limit" | "approval_required";

export type PolicyDefinition = {
  id: string;
  projectId: string;
  name: string;
  type: PolicyType;
  targetAgent?: string;
  config: Record<string, unknown>;
  enabled: boolean;
  priority: number;
  createdAt: number;
  updatedAt: number;
};

export type PolicyCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string; policyId: string };

export type PolicyViolation = {
  id: string;
  projectId: string;
  policyId: string;
  agentId: string;
  sessionKey?: string;
  actionAttempted: string;
  violationDetail: string;
  outcome: string;
  createdAt: number;
};

// --- Monitoring types ---

export type SloDefinition = {
  name: string;
  metricType: string;
  metricKey: string;
  aggregation: "avg" | "sum" | "count" | "min" | "max";
  condition: "lt" | "gt" | "lte" | "gte";
  threshold: number;
  windowMs: number;
  denominatorKey?: string;
  severity: "warning" | "critical";
  onBreach?: {
    action: "create_task";
    taskTitle: string;
    taskPriority?: string;
  };
};

export type AlertRuleDefinition = {
  name: string;
  metricType: string;
  metricKey: string;
  condition: "gt" | "lt" | "gte" | "lte" | "eq";
  threshold: number;
  windowMs: number;
  action: "create_task" | "emit_event" | "escalate";
  actionParams?: Record<string, unknown>;
  cooldownMs: number;
};

export type AnomalyConfig = {
  name: string;
  metricType: string;
  metricKey: string;
  lookbackWindows: number;
  windowMs: number;
  stddevThreshold: number;
};

// --- Risk tier types ---

export type RiskTier = "low" | "medium" | "high" | "critical";

export type RiskGateAction = "none" | "delay" | "approval" | "human_approval";

export type RiskClassification = {
  tier: RiskTier;
  reasons: string[];
};

export type RiskGateResult =
  | { action: "allow" }
  | { action: "delay"; delayMs: number }
  | { action: "require_approval"; proposalTitle: string }
  | { action: "block"; reason: string };

export type RiskPattern = {
  match: Record<string, unknown>;
  tier: RiskTier;
};

export type RiskTierConfig = {
  enabled: boolean;
  defaultTier: RiskTier;
  policies: Record<RiskTier, { gate: RiskGateAction; delayMs?: number }>;
  patterns: RiskPattern[];
};
