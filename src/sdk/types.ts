/**
 * Clawforce SDK — Public Type Definitions
 *
 * Uses abstract vocabulary throughout so these types work equally well for
 * corporate teams, research labs, game simulations, creative studios, or any
 * other team abstraction.
 *
 * Vocabulary mapping (internal → SDK):
 *   department → group
 *   team       → subgroup
 *   extends    → role
 *   manager    → coordinator
 */

// ---------------------------------------------------------------------------
// Task types
// ---------------------------------------------------------------------------

export type TaskState =
  | "OPEN"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "REVIEW"
  | "DONE"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED";

export type TaskPriority = "critical" | "high" | "medium" | "low";

export interface TaskParams {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assignedTo?: string;
  /** Abstract grouping (e.g. department, faction, lab division) */
  group?: string;
  /** Nested grouping within a group (e.g. team, squad, sub-lab) */
  subgroup?: string;
  goalId?: string;
  entityId?: string;
  entityType?: string;
  tags?: string[];
  /** Unix timestamp (ms) */
  deadline?: number;
  metadata?: Record<string, unknown>;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  state: TaskState;
  priority: string;
  assignedTo?: string;
  group?: string;
  subgroup?: string;
  goalId?: string;
  entityId?: string;
  entityType?: string;
  tags: string[];
  /** Unix timestamp (ms) */
  createdAt: number;
  /** Unix timestamp (ms) */
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface ClawforceEvent {
  id: string;
  type: string;
  source: string;
  payload: Record<string, unknown>;
  status: string;
  /** Unix timestamp (ms) */
  createdAt: number;
}

export type EventHandler = (event: ClawforceEvent) => void;

// ---------------------------------------------------------------------------
// Budget types
// ---------------------------------------------------------------------------

export interface BudgetCheckResult {
  ok: boolean;
  remaining?: { cents?: number; tokens?: number; requests?: number };
  reason?: string;
}

export interface BudgetConfig {
  daily?: { cents?: number; tokens?: number; requests?: number };
  hourly?: { cents?: number; tokens?: number; requests?: number };
  monthly?: { cents?: number; tokens?: number; requests?: number };
}

export interface CostParams {
  agentId: string;
  sessionKey?: string;
  taskId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
  provider?: string;
}

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

/**
 * Built-in capability strings plus an escape hatch for custom capabilities.
 * The `(string & {})` trick preserves autocomplete for the named literals while
 * still accepting arbitrary strings at runtime.
 */
export type AgentCapability =
  | "coordinate"
  | "create_tasks"
  | "execute_tasks"
  | "run_meetings"
  | "review_work"
  | "monitor"
  | "report_status"
  | "escalate"
  | (string & {}); // allow custom capabilities

export interface AgentConfig {
  /** Abstract for "extends" — the base role this agent derives from */
  role?: string;
  title?: string;
  /** Primary group membership */
  group?: string;
  /** Nested grouping within the primary group */
  subgroup?: string;
  /** Multi-group membership when an agent belongs to more than one group */
  groups?: string[];
  reportsTo?: string;
  capabilities?: AgentCapability[];
  [key: string]: unknown;
}

export interface AgentInfo {
  id: string;
  role?: string;
  title?: string;
  group?: string;
  subgroup?: string;
  groups?: string[];
  capabilities: AgentCapability[];
  status: "active" | "idle" | "disabled";
}

// ---------------------------------------------------------------------------
// Trust types
// ---------------------------------------------------------------------------

export interface TrustDecisionParams {
  agentId?: string;
  category: string;
  decision: "approved" | "rejected";
  proposalId?: string;
  toolName?: string;
  /** Severity of the decision (0-1). Higher = bigger impact on trust score. Default 1.0 */
  severity?: number;
}

/** Trust enforcement tier based on score thresholds */
export type TrustTier = "high" | "medium" | "low";

/** Configurable thresholds for trust enforcement tiers */
export interface TrustTierThresholds {
  /** Score above this = high trust (allow + notify). Default 0.8 */
  high: number;
  /** Score above this = medium trust (warn). Default 0.5 */
  medium: number;
  /** Score at or below medium = low trust (block + escalate) */
}

export interface TrustScore {
  overall: number;
  categories: Record<string, number>;
  /** Enforcement tier based on overall score */
  tier: TrustTier;
}

export interface TrustScoreOptions {
  /** Weight recent decisions more heavily. Decay factor per day (0-1). Default 0.95 (5% decay/day) */
  recencyDecay?: number;
  /** Custom tier thresholds */
  tiers?: TrustTierThresholds;
}

// ---------------------------------------------------------------------------
// Goal types
// ---------------------------------------------------------------------------

export interface GoalParams {
  title: string;
  description?: string;
  group?: string;
  owner?: string;
  priority?: string;
  /** Unix timestamp (ms) */
  deadline?: number;
  parentGoalId?: string;
  entityId?: string;
  entityType?: string;
  metadata?: Record<string, unknown>;
}

export interface Goal {
  id: string;
  title: string;
  description?: string;
  status: "active" | "achieved" | "abandoned";
  group?: string;
  owner?: string;
  priority: string;
  entityId?: string;
  entityType?: string;
  /** Unix timestamp (ms) */
  deadline?: number;
  /** Unix timestamp (ms) */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Entity types
// ---------------------------------------------------------------------------

export interface EntityKind {
  kind: string;
  title?: string;
  description?: string;
  states: string[];
  healthValues?: string[];
}

export type EntityIssueSeverity = "low" | "medium" | "high" | "critical";

export type EntityIssueStatus = "open" | "resolved" | "dismissed";

export interface EntityParams {
  kind: string;
  title: string;
  state?: string;
  health?: string;
  owner?: string;
  parentEntityId?: string;
  group?: string;
  subgroup?: string;
  metadata?: Record<string, unknown>;
  /** Unix timestamp (ms) */
  lastVerifiedAt?: number;
}

export interface Entity {
  id: string;
  kind: string;
  title: string;
  state: string;
  health?: string;
  owner?: string;
  parentEntityId?: string;
  group?: string;
  subgroup?: string;
  metadata?: Record<string, unknown>;
  /** Unix timestamp (ms) */
  createdAt: number;
  /** Unix timestamp (ms) */
  updatedAt: number;
  /** Unix timestamp (ms) */
  lastVerifiedAt?: number;
}

export interface EntityIssue {
  id: string;
  issueKey: string;
  entityId: string;
  entityKind: string;
  checkId?: string;
  issueType: string;
  source: string;
  severity: EntityIssueSeverity;
  status: EntityIssueStatus;
  title: string;
  description?: string;
  fieldName?: string;
  evidence?: Record<string, unknown>;
  recommendedAction?: string;
  playbook?: string;
  owner?: string;
  blocking: boolean;
  approvalRequired: boolean;
  proposalId?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt?: number;
}

export interface EntityIssueSummary {
  openCount: number;
  blockingOpenCount: number;
  approvalRequiredCount: number;
  pendingProposalCount: number;
  highestSeverity?: EntityIssueSeverity;
  suggestedHealth?: string;
  openIssueTypes: string[];
  openBySeverity: Partial<Record<EntityIssueSeverity, number>>;
}

export type EntityCheckRunStatus = "passed" | "issues" | "failed" | "simulated" | "blocked";

export interface EntityCheckRun {
  id: string;
  entityId: string;
  entityKind: string;
  checkId: string;
  status: EntityCheckRunStatus;
  command: string;
  parserType?: string;
  actor?: string;
  trigger?: string;
  sourceType?: string;
  sourceId?: string;
  exitCode: number;
  issueCount: number;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  createdAt: number;
}

export interface EntityCheckResult extends EntityCheckRun {
  issues: EntityIssue[];
}

export interface EntityTransition {
  id: string;
  entityId: string;
  fromState?: string;
  toState?: string;
  fromHealth?: string;
  toHealth?: string;
  actor: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface EntityDetail {
  entity: Entity;
  children: Entity[];
  transitions: EntityTransition[];
  issues: EntityIssue[];
  issueSummary: EntityIssueSummary;
  checkRuns: EntityCheckRun[];
}

export type EntityTransitionRequest =
  | { ok: true; entity: Entity }
  | {
      ok: false;
      approvalRequired: true;
      reason: string;
      proposal: {
        id: string;
        title: string;
        description?: string | null;
        status: string;
      };
      blockingIssues: EntityIssue[];
    };

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface MessageParams {
  from: string;
  to: string;
  content: string;
  type?: string;
  priority?: string;
  channelId?: string;
  parentMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  type: string;
  status: string;
  /** Unix timestamp (ms) */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Monitoring types
// ---------------------------------------------------------------------------

export interface SloResult {
  name: string;
  actual: number | null;
  threshold: number;
  passed: boolean;
  noData: boolean;
}

export interface HealthStatus {
  tier: "GREEN" | "YELLOW" | "RED";
  sloChecked: number;
  sloBreach: number;
  alertsFired: number;
}

// ---------------------------------------------------------------------------
// SDK init options
// ---------------------------------------------------------------------------

export interface ClawforceOptions {
  /** Domain identifier for the Clawforce instance */
  domain: string;
  /** Path to the SQLite database file (defaults to ~/.clawforce/data/<domain>.db) */
  dbPath?: string;
  /** Path to the config directory (defaults to ~/.clawforce/) */
  configPath?: string;
}
