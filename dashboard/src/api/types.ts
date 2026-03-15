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
