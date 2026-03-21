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
  goalId?: string;
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

/** Schedule types matching OpenClaw's CronScheduleSchema. */
export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number };

/** Delivery configuration for cron jobs. */
export type CronDelivery = {
  mode: "none" | "announce" | "webhook";
  to?: string;
  channel?: "last" | string;
  accountId?: string;
  bestEffort?: boolean;
};

/** Failure alert configuration for cron jobs. */
export type CronFailureAlert = false | {
  after?: number;
  channel?: "last" | string;
  to?: string;
  cooldownMs?: number;
  mode?: "announce" | "webhook";
  accountId?: string;
};

/** Cron job input matching OpenClaw's CronJobCreate shape. */
export type CronRegistrarInput = {
  name: string;
  agentId: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: "main" | "isolated";
  wakeMode: "next-heartbeat" | "now";
  payload: {
    kind: "agentTurn";
    message: string;
    model?: string;
    fallbacks?: string[];
    thinking?: string;
    timeoutSeconds?: number;
    lightContext?: boolean;
  };
  description?: string;
  deleteAfterRun?: boolean;
  delivery?: CronDelivery;
  failureAlert?: CronFailureAlert;
};

export type ClawforceConfig = {
  enabled: boolean;
  projectsDir: string;
  sweepIntervalMs: number;
  defaultMaxRetries: number;
  verificationRequired: boolean;
  cronRegistrar?: CronRegistrar;
};

// --- Dispatch throttle types ---

/** Per-project dispatch concurrency and rate-limiting configuration. */
export type DispatchConfig = {
  /** Max concurrent dispatches per project (default: 3). */
  maxConcurrentDispatches?: number;
  /** Max dispatches per hour per project. */
  maxDispatchesPerHour?: number;
  /** Per-agent concurrency and rate limits. */
  agentLimits?: Record<string, {
    maxConcurrent?: number;
    maxPerHour?: number;
  }>;
};

/** Strategy for automatic task assignment. */
export type AssignmentStrategy = "workload_balanced" | "round_robin" | "skill_matched";

/** Configuration for the auto-assignment engine. */
export type AssignmentConfig = {
  /** Enable auto-assignment (default: false — opt-in). */
  enabled: boolean;
  /** Assignment strategy (default: "workload_balanced"). */
  strategy: AssignmentStrategy;
  /** Auto-dispatch tasks when assigned (default: true when assignment enabled). */
  autoDispatchOnAssign?: boolean;
};

// --- Agent Enforcement Framework types ---

/** Coordination configuration for agents that manage other agents. */
export type CoordinationConfig = {
  enabled: boolean;
  schedule?: string;
};

/** A context source to inject at session start. */
export type ContextSource = {
  source: "instructions" | "custom" | "project_md" | "task_board" | "assigned_task" | "knowledge" | "file" | "skill" | "memory" | "memory_instructions" | "memory_review_context" | "escalations" | "workflows" | "activity" | "sweep_status" | "proposals" | "agent_status" | "cost_summary" | "policy_status" | "health_status" | "team_status" | "team_performance" | "soul" | "tools_reference" | "pending_messages" | "goal_hierarchy" | "channel_messages" | "planning_delta" | "velocity" | "preferences" | "trust_scores" | "resources" | "initiative_status" | "cost_forecast" | "available_capacity" | "knowledge_candidates" | "budget_guidance" | "onboarding_welcome" | "weekly_digest" | "intervention_suggestions" | "custom_stream" | "direction" | "policies" | "standards" | "architecture";
  /** Raw markdown content (for source: "custom"). */
  content?: string;
  /** File path (for source: "file"). */
  path?: string;
  /** Knowledge filter (for source: "knowledge"). */
  filter?: {
    category?: string[];
    tags?: string[];
  };
  /** Stream parameters (for parameterized sources). */
  params?: Record<string, unknown>;
  /** Custom stream name (for source: "custom_stream"). */
  streamName?: string;
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

export type SchedulingConfig = {
  adaptiveWake?: boolean;
  planning?: boolean;
  wakeBounds?: [string, string];
  /**
   * Maximum number of turns per coordination cycle.
   * When the turn count exceeds this value, a "wrap up" instruction is injected
   * so the agent concludes gracefully. The next cron wake starts fresh.
   * Default: undefined (no limit — backward compatible).
   */
  maxTurnsPerCycle?: number;
};

/** Per-agent configuration. */
export type AgentConfig = {
  /** Preset to inherit defaults from (e.g. "manager", "employee"). */
  extends?: string;
  /** Job title (e.g. "VP of Engineering"). */
  title?: string;
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
  /** Name of the skill_pack to apply to this agent. */
  skill_pack?: string;
  /** Coordination config for agents that manage other agents. */
  coordination?: CoordinationConfig;
  /** Scoped sessions. Each key is a job name with its own briefing/expectations/cron. */
  jobs?: Record<string, JobDefinition>;
  /** Scheduling configuration (adaptive wake, planning, wake bounds). */
  scheduling?: SchedulingConfig;
  /** Maximum number of skills an agent can hold. */
  skillCap?: number;
  /** Memory governance configuration. */
  memory?: MemoryGovernanceConfig;
};

/** A scoped session definition for an agent. */
export type JobDefinition = {
  /** Preset to inherit job defaults from. */
  extends?: string;
  /** Cron schedule. Accepts shorthand ("5m"), cron expr ("0 9 * * MON-FRI"), or ISO datetime ("at:2025-12-31T23:59:00Z"). */
  cron?: string;
  /** Timezone for cron expressions (e.g. "America/New_York"). Ignored for interval/at schedules. */
  cronTimezone?: string;
  /** Session target: "isolated" (default) or "main". */
  sessionTarget?: "main" | "isolated";
  /** Wake mode: "now" (default) or "next-heartbeat". */
  wakeMode?: "next-heartbeat" | "now";
  /** Delivery configuration for cron results. */
  delivery?: CronDelivery;
  /** Failure alert configuration. */
  failureAlert?: CronFailureAlert;
  /** Model override for this job's cron payload. */
  model?: string;
  /** Timeout in seconds for this job's cron session. */
  timeoutSeconds?: number;
  /** Use light context for this job's cron session. */
  lightContext?: boolean;
  /** Mark as one-shot: auto-delete after single run. Default true for "at" schedules. */
  deleteAfterRun?: boolean;
  /** Context sources (replaces base briefing when specified). */
  briefing?: ContextSource[];
  /** Sources to exclude from base briefing (used when briefing is not specified). */
  exclude_briefing?: string[];
  /** Compliance requirements (replaces base expectations when specified). */
  expectations?: Expectation[];
  /** Failure behavior (replaces base when specified). */
  performance_policy?: PerformancePolicy;
  /** Compaction config (replaces base when specified). */
  compaction?: boolean | CompactionConfig;
  /** Nudge text for the cron payload (replaces default nudge). */
  nudge?: string;
};

/** Top-level approval policy configuration. */
export type ApprovalPolicy = {
  /** Natural language policy text — served to manager at decision time. */
  policy: string;
};

/** A reusable config bundle for agents. */
export type SkillPack = {
  briefing?: ContextSource[];
  expectations?: Expectation[];
  performance_policy?: PerformancePolicy;
};

/** Full project config with workforce management. */
export type WorkforceConfig = {
  name: string;
  /** Unique project/domain identifier. */
  id?: string;
  /** Project root directory path. */
  dir?: string;
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
  /** Custom skill topics: domain markdown files accessible via skill system. */
  skills?: Record<string, {
    title: string;
    description: string;
    path: string;
    presets?: string[];
  }>;
  /** Reusable config bundles that agents can reference. */
  skill_packs?: Record<string, SkillPack>;
  /** Dispatch throttle configuration. */
  dispatch?: DispatchConfig;
  /** Auto-assignment engine configuration. */
  assignment?: AssignmentConfig;
  /** Tool gates: per-tool risk classification for MCP/external tools. */
  toolGates?: ToolGatesConfig;
  /** Bulk action thresholds: escalate tier when action count exceeds limit in window. */
  bulkThresholds?: Record<string, BulkThreshold>;
  /** User-defined event-to-action mappings. */
  event_handlers?: Record<string, EventHandlerConfig>;
  /** Review gate configuration: verifier selection, timeouts, self-review. */
  review?: ReviewConfig;
  /** Channel definitions for agent group communication. */
  channels?: ChannelConfig[];
  /** Safety limits: configurable guardrails with conservative defaults. */
  safety?: SafetyConfig;
  /** Goal definitions with optional allocation percentages. */
  goals?: Record<string, GoalConfigEntry>;
  /** Knowledge lifecycle configuration (promotion thresholds, etc.). */
  knowledge?: KnowledgeConfig;
  /** Manager/orchestrator cron configuration. */
  manager?: {
    enabled: boolean;
    agentId: string;
    cronSchedule?: string;
    projectDir?: string;
  };
  /** Legacy alias for manager. */
  orchestrator?: {
    enabled: boolean;
    agentId: string;
    cronSchedule?: string;
    projectDir?: string;
  };
};

// --- Goal config types ---

export type GoalConfigEntry = {
  description?: string;
  allocation?: number;
  department?: string;
  team?: string;
  acceptance_criteria?: string;
  owner_agent_id?: string;
};

// --- Safety config types ---

export type SafetyConfig = {
  /** Max depth of agent-spawning-agent chains. Default: 3. */
  maxSpawnDepth?: number;
  /** Budget multiplier before pausing dispatch. Default: 1.5 (150% of daily budget). */
  costCircuitBreaker?: number;
  /** Same task title failed N times across tasks → require human. Default: 3. */
  loopDetectionThreshold?: number;
  /** Max concurrent active meetings per project. Default: 2. */
  maxConcurrentMeetings?: number;
  /** Max messages per minute per channel. Default: 60. */
  maxMessageRate?: number;
};

/** @deprecated Use WorkforceConfig instead. */
export type EnforcementProjectConfig = WorkforceConfig;

// --- Review config types ---

/** Review gate configuration for task verification. */
export type ReviewConfig = {
  /** Explicit verifier agent ID. If omitted, falls back to regex pattern matching. */
  verifierAgent?: string;
  /** Hours before a REVIEW task with no verifier action triggers escalation. */
  autoEscalateAfterHours?: number;
  /** Whether task assignees can review their own work. Default: false. */
  selfReviewAllowed?: boolean;
  /** Maximum task priority that allows self-review. Tasks at higher priority still require cross-verification. Default: P3. */
  selfReviewMaxPriority?: TaskPriority;
};

// --- Channel types ---

export type ChannelType = "topic" | "meeting";
export const CHANNEL_TYPES: readonly ChannelType[] = ["topic", "meeting"] as const;

export type ChannelStatus = "active" | "concluded" | "archived";
export const CHANNEL_STATUSES: readonly ChannelStatus[] = ["active", "concluded", "archived"] as const;

/** A persistent group communication channel. */
export type Channel = {
  id: string;
  projectId: string;
  name: string;
  type: ChannelType;
  members: string[];
  status: ChannelStatus;
  createdBy: string;
  createdAt: number;
  concludedAt?: number;
  metadata?: Record<string, unknown>;
};

/** Meeting orchestration state stored in channel metadata. */
export type MeetingConfig = {
  participants: string[];
  currentTurn: number;
  prompt?: string;
};

/** Channel definition from workforce YAML config. */
export type ChannelConfig = {
  name: string;
  type?: ChannelType;
  /** Explicit agent IDs to add as members. */
  members?: string[];
  /** Auto-join agents by department. */
  departments?: string[];
  /** Auto-join agents by team. */
  teams?: string[];
  /** Auto-join agents by preset. */
  presets?: string[];
  /** Telegram group ID for mirroring channel messages. */
  telegramGroupId?: string;
  /** Telegram thread/topic ID within the group. */
  telegramThreadId?: number;
};

// --- Event handler config types ---

/** Built-in action types for event handlers. */
export type EventActionType = "create_task" | "notify" | "escalate" | "enqueue_work" | "emit_event";

export const EVENT_ACTION_TYPES: readonly EventActionType[] = [
  "create_task", "notify", "escalate", "enqueue_work", "emit_event",
] as const;

/** Create a task when the event fires. */
export type CreateTaskAction = {
  action: "create_task";
  /** Title template with {{payload.field}} interpolation. */
  template: string;
  /** Description template. */
  description?: string;
  /** Task priority (default P2). */
  priority?: TaskPriority;
  /** "auto" for auto-assignment, or agent name. */
  assign_to?: string;
  /** Department for the created task. */
  department?: string;
  /** Team for the created task. */
  team?: string;
};

/** Send a notification message. */
export type NotifyAction = {
  action: "notify";
  /** Message template with {{payload.field}} interpolation. */
  message: string;
  /** Target agent name (defaults to first manager). */
  to?: string;
  /** Message priority. */
  priority?: "low" | "normal" | "high" | "urgent";
};

/** Escalate to a manager or named agent. */
export type EscalateAction = {
  action: "escalate";
  /** Target: "manager" or agent name. */
  to: string;
  /** Message template. */
  message?: string;
};

/** Enqueue a task for dispatch. */
export type EnqueueWorkAction = {
  action: "enqueue_work";
  /** Task ID (template string or defaults to payload.taskId). */
  task_id?: string;
  /** Queue priority 0-3. */
  priority?: number;
};

/** Emit a follow-on event. */
export type EmitEventAction = {
  action: "emit_event";
  /** Event type to emit. */
  event_type: string;
  /** Payload template (each value supports {{payload.field}}). */
  event_payload?: Record<string, string>;
  /** Dedup key template. */
  dedup_key?: string;
};

/** Union of all event action configs. */
export type EventActionConfig =
  | CreateTaskAction
  | NotifyAction
  | EscalateAction
  | EnqueueWorkAction
  | EmitEventAction;

/** Array of actions triggered by a single event type. */
export type EventHandlerConfig = EventActionConfig[];

// --- Event-driven dispatch types ---

export type EventType =
  | "ci_failed"
  | "pr_opened"
  | "deploy_finished"
  | "task_completed"
  | "task_failed"
  | "task_assigned"
  | "task_created"
  | "sweep_finding"
  | "dispatch_succeeded"
  | "dispatch_failed"
  | "task_review_ready"
  | "dispatch_dead_letter"
  | "proposal_approved"
  | "proposal_created"
  | "proposal_rejected"
  | "message_sent"
  | "protocol_started"
  | "protocol_responded"
  | "protocol_completed"
  | "protocol_expired"
  | "protocol_escalated"
  | "goal_created"
  | "goal_achieved"
  | "goal_abandoned"
  | "custom";

export const EVENT_TYPES: readonly EventType[] = [
  "ci_failed", "pr_opened", "deploy_finished", "task_completed",
  "task_failed", "task_assigned", "task_created", "sweep_finding",
  "dispatch_succeeded", "dispatch_failed", "task_review_ready",
  "dispatch_dead_letter", "proposal_approved", "proposal_created", "proposal_rejected", "message_sent",
  "protocol_started", "protocol_responded", "protocol_completed", "protocol_expired", "protocol_escalated",
  "goal_created", "goal_achieved", "goal_abandoned",
  "custom",
] as const;

export type EventSource = "tool" | "internal" | "cron" | "webhook";

export type EventStatus = "pending" | "processing" | "handled" | "failed" | "ignored";

export const EVENT_STATUSES: readonly EventStatus[] = [
  "pending", "processing", "handled", "failed", "ignored",
] as const;

export type ClawforceEvent = {
  id: string;
  projectId: string;
  type: string;
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
  provider?: string;
  source: string;
  createdAt: number;
};

/** @deprecated Use BudgetConfigV2 instead. */
export type BudgetConfig = {
  hourlyLimitCents?: number;
  dailyLimitCents?: number;
  monthlyLimitCents?: number;
  sessionLimitCents?: number;
  taskLimitCents?: number;
};

export type BudgetWindowConfig = {
  cents?: number;
  tokens?: number;
  requests?: number;
};

export type BudgetConfigV2 = {
  hourly?: BudgetWindowConfig;
  daily?: BudgetWindowConfig;
  monthly?: BudgetWindowConfig;
  session?: BudgetWindowConfig;
  task?: BudgetWindowConfig;
};

export type BudgetCheckResult = {
  ok: boolean;
  remaining?: number;
  reason?: string;
};

/**
 * Constraint modifiers on an action scope entry.
 * Applied after policy check passes, before execution.
 */
export type ActionConstraints = {
  own_tasks_only?: boolean;
  department_only?: boolean;
};

/**
 * An action scope entry with optional constraints.
 */
export type ActionConstraint = {
  actions: string[] | "*";
  constraints?: ActionConstraints;
};

/**
 * Action scope: maps tool names to allowed actions.
 * `"*"` means all actions allowed; `string[]` restricts to listed actions.
 * `ActionConstraint` allows actions with runtime constraints.
 */
export type ActionScope = Record<string, string[] | "*" | ActionConstraint>;

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
  /** What to do when no metric data exists in the window. Defaults to "pass". */
  noDataPolicy?: "pass" | "fail" | "warn";
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
  aggregation?: "sum" | "avg" | "count" | "min" | "max";
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

export type RiskGateAction = "none" | "delay" | "confirm" | "approval" | "human_approval";

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

// --- Tool gate types ---

export type ToolGateEntry = {
  category: string;
  tier: RiskTier;
  /** Override the default gate action for this tier. */
  gate?: RiskGateAction;
};

export type BulkThreshold = {
  /** Time window in milliseconds. */
  windowMs: number;
  /** Maximum calls allowed in window before escalation. */
  maxCount: number;
  /** Tier to escalate to when threshold exceeded. */
  escalateTo: RiskTier;
};

export type ToolGatesConfig = Record<string, ToolGateEntry>;

// --- Messaging types ---

export type MessageType = "direct" | "request" | "delegation" | "escalation" | "notification" | "meeting" | "feedback";

export const MESSAGE_TYPES: readonly MessageType[] = [
  "direct", "request", "delegation", "escalation", "notification", "meeting", "feedback",
] as const;

export type MessagePriority = "low" | "normal" | "high" | "urgent";

export const MESSAGE_PRIORITIES: readonly MessagePriority[] = [
  "low", "normal", "high", "urgent",
] as const;

export type MessageStatus = "queued" | "delivered" | "read" | "failed";

export const MESSAGE_STATUSES: readonly MessageStatus[] = [
  "queued", "delivered", "read", "failed",
] as const;

export type Message = {
  id: string;
  fromAgent: string;
  toAgent: string;
  projectId: string;
  channelId: string | null;
  type: MessageType;
  priority: MessagePriority;
  content: string;
  status: MessageStatus;
  parentMessageId: string | null;
  createdAt: number;
  deliveredAt: number | null;
  readAt: number | null;
  protocolStatus: ProtocolStatus | null;
  responseDeadline: number | null;
  metadata: Record<string, unknown> | null;
};

// --- Protocol types ---

export type ProtocolStatus =
  | "awaiting_response" | "resolved"
  | "pending_acceptance" | "in_progress" | "completed" | "rejected"
  | "awaiting_review" | "reviewed" | "approved" | "revision_requested"
  | "expired" | "escalated" | "cancelled";

export const PROTOCOL_STATUSES: readonly ProtocolStatus[] = [
  "awaiting_response", "resolved",
  "pending_acceptance", "in_progress", "completed", "rejected",
  "awaiting_review", "reviewed", "approved", "revision_requested",
  "expired", "escalated", "cancelled",
] as const;

// --- Goal types ---

export type GoalStatus = "active" | "achieved" | "abandoned";

export const GOAL_STATUSES: readonly GoalStatus[] = ["active", "achieved", "abandoned"] as const;

export type Goal = {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  status: GoalStatus;
  parentGoalId?: string;
  ownerAgentId?: string;
  department?: string;
  team?: string;
  createdBy: string;
  createdAt: number;
  achievedAt?: number;
  metadata?: Record<string, unknown>;
  allocation?: number;
  priority?: TaskPriority;
};

export type PlannedItem = {
  initiativeId?: string;
  agentId: string;
  model?: string;
  taskTitle: string;
  estimatedCostCents: number;
  estimatedTokens?: number;
  confidence: "high" | "medium" | "low";
  priority?: TaskPriority;
};

export type ActualResult = {
  plannedIndex: number;
  taskId?: string;
  actualCostCents?: number;
  status: "dispatched" | "skipped" | "failed";
  skipReason?: string;
};

export type DispatchPlanStatus = "planned" | "executing" | "completed" | "abandoned";

export type DispatchPlan = {
  id: string;
  projectId: string;
  agentId: string;
  status: DispatchPlanStatus;
  plannedItems: PlannedItem[];
  actualResults?: ActualResult[];
  estimatedCostCents: number;
  estimatedTokens?: number;
  actualCostCents?: number;
  createdAt: number;
  completedAt?: number;
};

// --- Knowledge lifecycle types ---

export type PromotionTarget = "soul" | "skill" | "project_doc" | "rule";

export type PromotionCandidate = {
  id: string;
  projectId: string;
  contentHash: string;
  contentSnippet: string;
  retrievalCount: number;
  sessionCount: number;
  suggestedTarget: PromotionTarget;
  targetAgentId?: string;
  status: "pending" | "approved" | "dismissed";
  createdAt: number;
  reviewedAt?: number;
};

export type KnowledgeFlag = {
  id: string;
  projectId: string;
  agentId: string;
  sourceType: PromotionTarget;
  sourceRef: string;
  flaggedContent: string;
  correction: string;
  severity: "low" | "medium" | "high";
  status: "pending" | "resolved" | "dismissed";
  createdAt: number;
  resolvedAt?: number;
};

export type KnowledgeConfig = {
  promotionThreshold?: {
    minRetrievals?: number;
    minSessions?: number;
  };
};

// --- Memory Governance types ---

export type MemoryGovernanceConfig = {
  instructions?: boolean | string;  // true = role default, string = custom, false = disable
  expectations?: boolean;           // true = role default expectations, false = none
  review?: {
    enabled?: boolean;
    cron?: string;
    model?: string;
    aggressiveness?: "low" | "medium" | "high";
    scope?: "self" | "reports" | "all";
  };
};

// --- Budget forecast types ---

export type DailyBudgetSnapshot = {
  cents: { limit: number; spent: number; reserved: number; remaining: number; utilization: number };
  tokens: { limit: number; spent: number; reserved: number; remaining: number; utilization: number };
  requests: { limit: number; spent: number; reserved: number; remaining: number; utilization: number };
  sessionsRemaining: number;
  exhaustionEta: Date | null;
  initiatives: Array<{
    id: string;
    name: string;
    allocation: number;
    spent: { cents: number; tokens: number };
    utilization: number;
  }>;
};

export type WeeklyTrend = {
  dailyAverage: { cents: number; tokens: number; requests: number };
  direction: { cents: "up" | "down" | "stable"; tokens: "up" | "down" | "stable" };
  changePercent: { cents: number; tokens: number };
  perInitiative: Array<{
    id: string;
    name: string;
    dailyAverage: { cents: number; tokens: number };
    allocation: number;
    overUnder: number;
  }>;
};

export type MonthlyProjection = {
  projectedTotal: { cents: number; tokens: number };
  monthlyLimit: { cents: number | null; tokens: number | null };
  exhaustionDay: number | null;
  perInitiative: Array<{
    id: string;
    projectedTotal: number;
    allocation: number;
    onTrack: boolean;
  }>;
};

// --- Domain Config & Rules ---

export type RuleTrigger = {
  event: string;
  match?: Record<string, unknown>;
};

export type RuleAction = {
  agent: string;
  prompt_template: string;
};

export type RuleDefinition = {
  name: string;
  trigger: RuleTrigger;
  action: RuleAction;
  enabled?: boolean;
};

// --- Operational Profile types ---

export type OperationalProfile = "low" | "medium" | "high" | "ultra";

export const OPERATIONAL_PROFILES: readonly OperationalProfile[] = ["low", "medium", "high", "ultra"] as const;

export type OperationalProfileConfig = {
  profile: OperationalProfile;
  coordination: {
    sessionTarget: "isolated" | "main";
    sessionPersistHours?: number;
    cronSchedule: string;
    adaptiveWake: boolean;
    wakeBounds?: [string, string];
  };
  memory: {
    reviewSchedule: string;
    reviewAggressiveness: "low" | "medium" | "high";
    ghostRecallIntensity: "low" | "medium" | "high";
    expectations: boolean;
  };
  meetings: {
    standupSchedule?: string;
    reflectionSchedule: string;
  };
  models: {
    managerRecommended: string;
    employeeRecommended: string;
  };
  sessionReset?: {
    enabled: boolean;
    schedule?: string;
  };
};

export type CostLineItem = {
  label: string;
  cents: number;
};

export type CostBucket = {
  name: string;
  totalCents: number;
  items: CostLineItem[];
};

export type ProfileCostEstimate = {
  profile: OperationalProfile;
  dailyCents: number;
  monthlyCents: number;
  buckets: CostBucket[];
  fitsInBudget: boolean;
  headroomCents: number;
  headroomPercent: number;
};

export type ProfileRecommendation = {
  recommended: OperationalProfile;
  reason: string;
  allProfiles: Array<{
    profile: OperationalProfile;
    estimatedCents: number;
    fitsInBudget: boolean;
    headroomPercent: number;
  }>;
};
