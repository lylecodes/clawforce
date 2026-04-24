/**
 * Clawforce -- Control API Contract
 *
 * Typed response shapes for all dashboard API endpoints.
 * The dashboard imports these types. Breaking changes require version bumps.
 *
 * Re-exports core types where possible to avoid duplication.
 */

import type {
  Entity,
  EntityIssue,
  EntityIssueSummary,
  EntityKindConfig,
  Task,
  ClawforceEvent,
  DomainExecutionEffect,
  DomainExecutionMode,
} from "../types.js";
import type { DomainConfig, GlobalAgentDef } from "../config/schema.js";
import type { Proposal } from "../approval/resolve.js";
import type { DashboardExtensionContribution } from "../dashboard/extensions.js";
import type { SetupExplanation, SetupReport } from "../setup/report.js";
import type { SetupPreflight } from "../setup/preflight.js";
import type { AttentionSummary } from "../attention/types.js";

// Re-export referenced types for consumer convenience
export type { Task, ClawforceEvent, DomainConfig, Proposal };
export type { DashboardExtensionContribution };
export type { SetupReport, SetupExplanation };
export type { SetupPreflight };

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

export type ConfigAgentRuntime = {
  bootstrapConfig?: {
    maxChars?: number;
    totalMaxChars?: number;
  };
  bootstrapExcludeFiles?: string[];
  allowedTools?: string[];
  workspacePaths?: string[];
};

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
  runtimeRef?: string;
  runtime?: ConfigAgentRuntime;
  allowedTools?: string[];
  workspacePaths?: string[];
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
  entities: Record<string, EntityKindConfig>;
  execution: Record<string, unknown>;
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

export type RuntimeReloadStatus = {
  domainId: string;
  status: "loaded" | "warning" | "error" | "disabled" | "missing";
  runtimeLoaded: boolean;
  configApplied: boolean;
  source: "initialize" | "reload";
  ownerBaseDir?: string;
  lastAttemptedAt: number;
  lastAppliedAt: number | null;
  errors: string[];
  warnings: string[];
};

export type SimulatedActionStats = {
  total: number;
  pending: number;
  simulated: number;
  blocked: number;
  approvedForLive: number;
  discarded: number;
  latestCreatedAt: number | null;
};

export type SetupOperatorActionOperation =
  | {
    type: "request_controller_handoff";
  }
  | {
    type: "recover_recurring_run";
    taskId: string;
  };

export type SetupOperatorAction = {
  id: string;
  label: string;
  description?: string;
  operation: SetupOperatorActionOperation;
  tone?: "primary" | "secondary";
};

export type SetupOperatorActionResponse = {
  ok: true;
  message: string;
  actionId: string;
  mode?: "handoff_requested" | "released" | "retried" | "replayed";
  requestedGeneration?: string;
  taskId?: string;
  queueItemId?: string;
  recoveredTaskId?: string;
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

export type EntityListResponse = {
  entities: Entity[];
  count: number;
  hasMore?: boolean;
};

export type EntityDetailResponse = {
  entity: Entity;
  children: Entity[];
  transitions: import("../types.js").EntityTransitionRecord[];
  issues: EntityIssue[];
  issueSummary: EntityIssueSummary;
  checkRuns: import("../types.js").EntityCheckRun[];
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

export type SetupTopologyAgent = {
  id: string;
  extends?: string;
  title?: string;
  department?: string;
  team?: string;
  reports_to?: string | null;
  jobCount: number;
  activeSessionCount: number;
  activeTaskCount: number;
  executor: "openclaw" | "codex" | "claude-code";
  enforcementGrade: "hard-scoped" | "partially-scoped" | "policy-only";
  executorSuitability: "preferred" | "acceptable" | "avoid";
  runtime?: ConfigAgentRuntime;
  allowedTools?: string[];
  workspacePaths?: string[];
  role: "manager" | "owner" | "specialist";
};

export type SetupContextRoute = {
  path: string;
  params?: Record<string, string>;
};

export type SetupContextReference = {
  id: string;
  label: string;
  kind: "config" | "agent" | "job" | "workflow" | "runtime";
  domainId?: string;
  filePath?: string;
  configSection?: string;
  configPath?: string;
  agentId?: string;
  jobId?: string;
  route?: SetupContextRoute;
};

export type SetupExperienceResponse = {
  domainId: string;
  report: SetupReport;
  explanation: SetupExplanation;
  preflight: SetupPreflight;
  topology: {
    managerAgentId: string | null;
    workflows: string[];
    entityKinds: string[];
    manager: SetupTopologyAgent | null;
    owners: SetupTopologyAgent[];
    sharedSpecialists: SetupTopologyAgent[];
  };
  context: {
    immediateActions: Record<string, SetupContextReference[]>;
    checks: Record<string, SetupContextReference[]>;
    preflight: Record<string, SetupContextReference[]>;
    agents: Record<string, SetupContextReference[]>;
    jobs: Record<string, SetupContextReference[]>;
  };
  actions: {
    immediateActions: Record<string, SetupOperatorAction[]>;
    jobs: Record<string, SetupOperatorAction[]>;
  };
  config: ConfigQueryResult;
  feed: AttentionSummary;
  decisionInbox: AttentionSummary;
  runtime: {
    dashboard: unknown;
    queue: unknown;
    trackedSessions: unknown;
    execution: {
      mode: DomainExecutionMode;
      defaultMutationPolicy?: DomainExecutionEffect;
      environments?: {
        primary?: string;
        verification?: string;
      };
      simulatedActions: SimulatedActionStats;
      lastReload: RuntimeReloadStatus | null;
    };
  };
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
  /** Reload errors captured while trying to apply the saved config to the runtime. */
  reloadErrors?: string[];
  /** Latest known runtime apply status for the active domain after the save. */
  runtimeReload?: RuntimeReloadStatus | null;
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
  messaging?: {
    operatorChat: boolean;
    directAgentMessaging: boolean;
    channels: boolean;
    assistantRouting: boolean;
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

export type DashboardAssistantStatusResponse = {
  enabled: boolean;
  configuredAgentId?: string;
  resolvedAgentId?: string;
  resolvedTitle?: string;
  resolutionSource?: "configured" | "lead";
  deliveryPolicy: "live-if-session-available-else-store" | "unavailable";
  directMentionsSupported: boolean;
  note: string;
};

export type MessageContextRefs = {
  proposalId?: string;
  taskId?: string;
  entityId?: string;
  issueId?: string;
};

export type OperatorCommsThread = {
  id: string;
  agentId: string;
  agentTitle?: string;
  messageCount: number;
  unreadCount: number;
  queuedForAgentCount: number;
  lastMessageAt: number;
  lastDirection: "outbound" | "inbound";
  lastMessage?: string;
  proposalIds: string[];
  taskIds: string[];
  entityIds: string[];
  issueIds: string[];
};

export type OperatorCommsResponse = {
  assistant: DashboardAssistantStatusResponse;
  feed: AttentionSummary;
  directThreads: OperatorCommsThread[];
  inboxCount: number;
  unreadCount: number;
  queuedForAgentsCount: number;
  decisionInbox: AttentionSummary;
  channelsConfigured: boolean;
};

// --- Attention ---

export type { AttentionUrgency, AttentionItem, AttentionSummary } from "../attention/types.js";

// --- Workspace v2 (Phase A) ---

export type {
  WorkspaceScope,
  WorkspaceScopeKind,
  ProjectWorkspace,
  ProjectOperatorSummary,
  WorkflowMiniTopology,
  WorkflowPreviewStage,
  WorkflowTopology,
  WorkflowDraftSession,
  WorkflowDraftSessionSummary,
  WorkflowDraftStage,
  WorkflowDraftStageOverlay,
  WorkflowDraftChangeSummary,
  WorkflowDraftSessionStatus,
  WorkflowDraftOverlayVisibility,
  WorkflowHelperSession,
  WorkflowHelperSessionMode,
  WorkflowHelperSessionStatus,
  WorkflowHelperConversationStep,
  WorkflowHelperMessage,
  WorkflowHelperGatheredAnswers,
  WorkflowHelperProposal,
  WorkflowHelperProposalStage,
  WorkflowStageSummary,
  WorkflowStageEdge,
  WorkflowStageInspector,
  WorkflowStageInspectorTask,
  ScopedWorkspaceFeed,
  ScopedFeedItem,
  StageLiveState,
  WorkflowLiveState,
} from "../workspace/types.js";

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
