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
}

export interface TrustScore {
  overall: number;
  categories: Record<string, number>;
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
  /** Unix timestamp (ms) */
  deadline?: number;
  /** Unix timestamp (ms) */
  createdAt: number;
}

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
  /** Path to the SQLite database file (defaults to ~/.openclaw/<domain>/db.sqlite) */
  dbPath?: string;
  /** Path to the config directory (defaults to ~/.openclaw/<domain>/) */
  configPath?: string;
}
