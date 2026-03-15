/** Response types matching the backend query functions */

export type Project = {
  id: string;
  agentCount: number;
};

export type DashboardSummary = {
  budgetUtilization: {
    spent: number;
    limit: number;
    pct: number;
  };
  activeAgents: number;
  totalAgents: number;
  tasksInFlight: number;
  pendingApprovals: number;
};

export type Agent = {
  id: string;
  extends?: string;
  title?: string;
  department?: string;
  team?: string;
  status: "active" | "idle" | "disabled";
  currentSessionKey?: string;
};

export type AgentDetail = Agent & {
  persona?: string;
  disabledReason?: string;
  directReports: string[];
  currentSession: {
    key: string;
    startedAt: number;
    toolCalls: number;
  } | null;
  expectations?: string[];
  performancePolicy?: Record<string, unknown>;
};

export type TaskState =
  | "OPEN"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "REVIEW"
  | "BLOCKED"
  | "DONE"
  | "CANCELLED";

export type TaskPriority = "P0" | "P1" | "P2" | "P3";

export type Task = {
  id: string;
  title: string;
  description?: string;
  state: TaskState;
  priority: TaskPriority;
  assignedTo?: string;
  department?: string;
  team?: string;
  goalId?: string;
  createdAt: number;
  updatedAt: number;
};

export type TaskListResponse = {
  tasks: Task[];
  hasMore: boolean;
  count: number;
};

export type Proposal = {
  id: string;
  title: string;
  description?: string;
  agentId: string;
  category?: string;
  riskTier?: string;
  toolName?: string;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  resolvedAt?: number;
  feedback?: string;
};

export type ApprovalListResponse = {
  proposals: Proposal[];
  count: number;
};

export type EventEntry = {
  id: string;
  type: string;
  source: string;
  timestamp: number;
  payload: Record<string, unknown>;
  status?: string;
};

export type EventListResponse = {
  events: EventEntry[];
  count: number;
};

export type BudgetStatus = {
  hourly?: WindowStatus;
  daily?: WindowStatus;
  monthly?: WindowStatus;
};

export type WindowStatus = {
  spentCents: number;
  limitCents: number;
  remaining: number;
  pct: number;
};

export type BudgetForecast = {
  daily: unknown;
  weekly: unknown;
  monthly: unknown;
};

export type TrustScores = {
  agents: AgentTrustScore[];
  overrides: unknown[];
};

export type AgentTrustScore = {
  agentId: string;
  overall: number;
  categories: Record<string, number>;
  trend: "up" | "down" | "stable";
};

/** Daily cost entry from GET /:domain/costs */
export type DailyCost = {
  date: string;
  totalCents: number;
  byInitiative: Record<string, number>;
};

export type CostResponse = {
  daily: DailyCost[];
  totalCents: number;
  currency: string;
};

/** Agent performance data for Analytics */
export type AgentPerformance = {
  agentId: string;
  tasksCompleted: number;
  compliancePct: number;
  totalCostCents: number;
  costPerTask: number;
};

export type OrgAgent = {
  id: string;
  extends?: string;
  title?: string;
  department?: string;
  team?: string;
  reportsTo?: string;
  directReports: string[];
};

export type OrgChart = {
  agents: OrgAgent[];
  departments: string[];
};

export type SSEEventType =
  | "budget:update"
  | "task:update"
  | "agent:status"
  | "approval:new"
  | "approval:resolved"
  | "message:new"
  | "plan:update"
  | "escalation:new"
  | "meeting:started"
  | "meeting:turn"
  | "meeting:ended"
  | "config:changed";

// --- Comms Center types ---

export type MessageRole = "manager" | "employee" | "user";

export type Message = {
  id: string;
  threadId: string;
  from: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  attachments?: string[];
  linkedTaskId?: string;
  mentionedAgents?: string[];
};

export type Thread = {
  id: string;
  type: "message" | "escalation" | "meeting";
  participants: string[];
  title?: string;
  lastMessage?: string;
  lastTimestamp: number;
  unreadCount: number;
  isActive?: boolean; // for meetings: currently live
};

export type MessageListResponse = {
  threads: Thread[];
  count: number;
};

export type ThreadMessagesResponse = {
  messages: Message[];
  count: number;
};

export type Meeting = {
  id: string;
  topic?: string;
  participants: string[];
  status: "active" | "ended";
  startedAt: number;
  endedAt?: number;
};

export type MeetingListResponse = {
  meetings: Meeting[];
  count: number;
};

// --- Goal / Initiative types ---

export type Goal = {
  id: string;
  title: string;
  description?: string;
  status: string;
  department?: string;
  team?: string;
  allocation?: number;
  ownerAgentId?: string;
  createdAt: number;
};

export type GoalListResponse = {
  goals: Goal[];
  hasMore: boolean;
  count: number;
};

// --- Config Editor types ---

export type ConfigSection =
  | "agents"
  | "budget"
  | "tool_gates"
  | "initiatives"
  | "jobs"
  | "safety"
  | "profile"
  | "rules"
  | "event_handlers"
  | "memory";

export type AgentConfig = {
  id: string;
  extends?: string;
  title?: string;
  persona?: string;
  reports_to?: string;
  department?: string;
  team?: string;
  channel?: string;
  briefing?: string[];
  expectations?: string[];
  performance_policy?: {
    action?: string;
    max_retries?: number;
    then?: string;
  };
};

export type BudgetConfig = {
  operational_profile?: string;
  daily?: { cents?: number; tokens?: number; requests?: number };
  hourly?: { cents?: number; tokens?: number; requests?: number };
  monthly?: { cents?: number; tokens?: number; requests?: number };
  initiatives?: Record<string, number>;
};

export type ToolGate = {
  tool: string;
  category?: string;
  risk_tier: "low" | "medium" | "high" | "critical";
};

export type JobConfig = {
  id: string;
  agent: string;
  cron: string;
  enabled: boolean;
  description?: string;
};

export type SafetyConfig = {
  circuit_breaker_multiplier?: number;
  spawn_depth_limit?: number;
  loop_detection_threshold?: number;
};

export type DomainConfig = {
  agents: AgentConfig[];
  budget: BudgetConfig;
  tool_gates: ToolGate[];
  initiatives: Record<string, { allocation_pct: number; goal?: string }>;
  jobs: JobConfig[];
  safety: SafetyConfig;
  profile: Record<string, unknown>;
  rules: Record<string, unknown>[];
  event_handlers: Record<string, unknown>[];
  memory: Record<string, unknown>;
};

export type ConfigChangePreview = {
  costDelta: string;
  costDirection: "cheaper" | "more_expensive" | "neutral";
  consequence: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
  riskExplanation?: string;
  buckets?: {
    management: number;
    execution: number;
    intelligence: number;
  };
};

export type ConfigValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};
