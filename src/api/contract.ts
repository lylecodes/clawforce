/**
 * Clawforce -- Control API Contract
 *
 * Typed response shapes for all dashboard API endpoints.
 * The dashboard imports these types. Breaking changes require version bumps.
 *
 * Re-exports core types where possible to avoid duplication.
 */

import type { Task, ClawforceEvent } from "../types.js";
import type { DomainConfig, GlobalAgentDef } from "../config/schema.js";
import type { Proposal } from "../approval/resolve.js";
import type { DashboardExtensionContribution } from "../dashboard/extensions.js";

// Re-export referenced types for consumer convenience
export type { Task, ClawforceEvent, DomainConfig, Proposal };
export type { DashboardExtensionContribution };

// --- Config contract types ---

/**
 * A structured briefing source entry as served by the config query.
 * Preserves the full source object so the SPA can round-trip edits.
 */
export type BriefingSource =
  | { source: "direction" }
  | { source: "standards" }
  | { source: "policies" }
  | { source: "architecture" }
  | { source: "file"; path: string }
  | { source: "custom_stream"; streamName: string }
  | { source: string; [key: string]: unknown };

/**
 * A structured agent expectation as served by the config query.
 * Preserves the full expectation object so the SPA can round-trip edits.
 */
export type AgentExpectation =
  | string
  | { tool: string; action?: string | string[]; min_calls?: number; [key: string]: unknown };

/**
 * An agent entry in the queryConfig() response.
 * Rich fields (briefing, expectations) are preserved as structured objects.
 */
export type ConfigAgent = {
  id: string;
  extends?: string;
  title?: string;
  persona?: string;
  reports_to?: string | null;
  department?: string;
  team?: string;
  channel?: string;
  briefing: BriefingSource[];
  expectations: AgentExpectation[];
  performance_policy?: GlobalAgentDef["performance_policy"] | Record<string, unknown>;
};

/** A budget window config (hourly, daily, or monthly). */
export type BudgetWindowConfig = {
  cents?: number;
  tokens?: number;
  requests?: number;
};

/** The budget section as served by queryConfig(). */
export type ConfigBudgetSection = {
  hourly?: BudgetWindowConfig;
  daily?: BudgetWindowConfig;
  monthly?: BudgetWindowConfig;
  operational_profile?: string;
  initiatives?: Record<string, number>;
};

/** A tool gate entry in the queryConfig() response. */
export type ConfigToolGate = {
  tool: string;
  category?: string;
  risk_tier: string;
};

/** A flattened job entry in the queryConfig() response. */
export type ConfigJob = {
  /** Composite key: "<agentId>:<jobName>" */
  id: string;
  agent: string;
  cron: string;
  enabled: boolean;
  description?: string;
};

/** The safety section as served by queryConfig(). */
export type ConfigSafetySection = {
  circuit_breaker_multiplier?: number;
  spawn_depth_limit?: number;
  loop_detection_threshold?: number;
};

/** An initiative entry in the queryConfig() response. */
export type ConfigInitiative = {
  allocation_pct: number;
  goal?: string;
};

/** The full shape returned by queryConfig(). */
export type ConfigQueryResult = {
  agents: ConfigAgent[];
  budget: ConfigBudgetSection;
  tool_gates: ConfigToolGate[];
  initiatives: Record<string, ConfigInitiative>;
  jobs: ConfigJob[];
  safety: ConfigSafetySection;
  profile: { operational_profile?: string };
  rules: unknown[];
  defaults: Record<string, unknown>;
  role_defaults: Record<string, unknown>;
  team_templates: Record<string, unknown>;
  dashboard_assistant: { enabled: boolean; agentId?: string; model?: string };
  event_handlers: Record<string, unknown>;
  workflows: string[];
  knowledge: Record<string, unknown>;
  memory: Record<string, unknown>;
};

/** Response for config validate action — includes field-level errors and warnings. */
export type ConfigValidateResponse = {
  valid: boolean;
  section: string;
  errors: string[];
  warnings: string[];
};

/** Response for config preview action — describes impact of a proposed change. */
export type ConfigPreviewResponse = {
  costDelta: string;
  costDirection: "neutral" | "increase" | "decrease";
  consequence: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
  riskExplanation: string;
};

// --- Agent types ---

export type OrgAgent = {
  id: string;
  extends?: string;
  title?: string;
  persona?: string;
  reports_to?: string;
  department?: string;
  team?: string;
  status?: string;
};

export type AgentSummary = {
  id: string;
  extends?: string;
  title?: string;
  persona?: string;
  department?: string;
  team?: string;
  status?: string;
  channel?: string;
};

// --- Budget types ---

export type BudgetWindowStatus = {
  window: string;
  limit?: number;
  spent?: number;
  remaining?: number;
  unit?: string;
};

// --- Read surfaces ---

export type AgentListResponse = {
  agents: AgentSummary[];
};

export type OrgChartResponse = {
  agents: OrgAgent[];
  departments: string[];
};

export type TaskListResponse = {
  tasks: Task[];
  total: number;
  hasMore: boolean;
};

export type ApprovalListResponse = {
  proposals: Proposal[];
  count: number;
};

export type BudgetStatusResponse = {
  windows?: BudgetWindowStatus[];
  alerts?: unknown[];
};

export type EventListResponse = {
  events: ClawforceEvent[];
  count: number;
};

export type HealthResponse = {
  tier: string;
  alertsFired: number;
  emergencyStop?: boolean;
  domainEnabled?: boolean;
};

export type DomainConfigResponse = {
  config: DomainConfig;
};

// --- Action surfaces ---

export type ApproveResponse = {
  ok: boolean;
};

export type TransitionResponse = {
  ok: boolean;
  error?: string;
};

export type CreateTaskResponse = {
  ok: boolean;
  taskId?: string;
};

export type ConfigSaveResponse = {
  ok: boolean;
  /** Set to the section name on success. */
  section?: string;
  /** Human-readable error message when ok is false. */
  error?: string;
  /** Non-fatal warnings emitted during save (e.g. unknown agent references). */
  warnings?: string[];
};

export type EnableDisableResponse = {
  ok: boolean;
};

export type KillResponse = {
  ok: boolean;
  killed: number;
};

// --- Action Status ---

export type { ActionStatus, ActionRecord } from "../dashboard/action-status.js";

export type ActionStatusQuery = {
  status?: "accepted" | "in_progress" | "completed" | "failed";
  limit?: number;
  offset?: number;
};

// --- Capability discovery ---

export type CapabilityResponse = {
  version: string;
  features: {
    tasks: boolean;
    approvals: boolean;
    budget: boolean;
    trust: boolean;
    memory: boolean;
    comms: boolean;
  };
  endpoints: string[];
  /** Extension summary — reflects dashboard extensions currently registered. */
  extensions?: {
    /** Total number of registered dashboard extensions. */
    count: number;
    /** IDs of extensions currently loaded. */
    ids: string[];
  };
};

export type DashboardExtensionListResponse = {
  extensions: DashboardExtensionContribution[];
  count: number;
};

export type DashboardRuntimeResponse = {
  mode: "openclaw-plugin" | "standalone";
  authMode: "openclaw-plugin" | "bearer-token" | "localhost-only";
  standaloneCompatibilityServer?: boolean;
  standaloneUrl?: string;
  notes: string[];
};

// --- Attention ---

export type { AttentionUrgency, AttentionItem, AttentionSummary } from "../attention/types.js";

// --- Lock types ---

/** A lock entry as returned by the dashboard API. */
export type LockEntry = {
  id: string;
  projectId: string;
  surface: string;
  lockedBy: string;
  lockedAt: number;
  updatedAt?: number;
  reason?: string;
};

/** Response for lock/unlock actions. */
export type LockResponse = {
  ok: boolean;
  lock?: LockEntry;
  error?: string;
};

/** Response for queryLocks(). */
export type LocksQueryResponse = {
  locks: LockEntry[];
  count: number;
};

// --- History types ---

/**
 * Provenance of a change: who initiated it.
 * - "human"  — operator action via dashboard or CLI
 * - "agent"  — autonomous agent action
 * - "system" — automated system action (sweep, cron, migration)
 */
export type ChangeProvenance = "human" | "agent" | "system";

/**
 * A single change record in the canonical change history.
 * Provides before/after diffs, provenance, and revert state
 * so operators can understand what changed and safely undo it.
 */
export type ChangeRecord = {
  id: string;
  projectId: string;
  /** Structural type: "config" | "budget" | "agent" | "org" | "doc" | "rule" | "job" | "lock" */
  resourceType: string;
  /** e.g. section name, agent ID, doc path */
  resourceId: string;
  /** "create" | "update" | "delete" | "revert" | "domain_kill" */
  action: string;
  provenance: ChangeProvenance;
  actor: string;
  /** JSON snapshot of state before the change (null for creates) */
  before: string | null;
  /** JSON snapshot of state after the change (null for deletes) */
  after: string | null;
  /** Whether this change can be safely reverted */
  reversible: boolean;
  /** ID of the change record that reverted this one, if any */
  revertedBy?: string;
  createdAt: number;
};

/** Result of a revert operation. */
export type RevertResult =
  | { ok: true; changeId: string; revertChangeId: string }
  | { ok: false; reason: string };

/** Response for queryRecentChanges() and queryResourceHistory(). */
export type ChangeHistoryResponse = {
  records: ChangeRecord[];
  count: number;
};

// --- Notification contract types ---

export type {
  NotificationCategory,
  NotificationSeverity,
  NotificationActionability,
  NotificationDeliveryStatus,
  NotificationRecord,
  NotificationPreferences,
} from "../notifications/types.js";

/** Response for GET /notifications */
export type NotificationListResponse = {
  notifications: import("../notifications/types.js").NotificationRecord[];
  count: number;
  unreadCount: number;
};

/** Response for GET /notifications/unread-count */
export type NotificationUnreadCountResponse = {
  unreadCount: number;
};
