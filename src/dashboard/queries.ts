/**
 * Clawforce — Dashboard query layer
 *
 * Thin wrappers around existing data functions with pagination and response shaping.
 * Reuses existing core functions — no direct DB access.
 */

import { getActiveProjectIds } from "../lifecycle.js";
import { getAgentConfig, getRegisteredAgentIds, getExtendedProjectConfig } from "../project.js";
import { listTasks, getTask, getTaskEvidence, getTaskTransitions } from "../tasks/ops.js";
import { queryAuditLog } from "../audit.js";
import { queryMetrics, aggregateMetrics } from "../metrics.js";
import { getCostSummary } from "../cost.js";
import { evaluateSlos } from "../monitoring/slo.js";
import { evaluateAlertRules } from "../monitoring/alerts.js";
import { computeHealthTier } from "../monitoring/health-tier.js";
import { listEvents } from "../events/store.js";
import { searchMessages } from "../messaging/store.js";
import { getActiveProtocols } from "../messaging/protocols.js";
import type { MessageType, MessageStatus, ProtocolStatus, GoalStatus } from "../types.js";
import { listGoals, getGoal, getChildGoals, getGoalTasks } from "../goals/ops.js";
import { computeGoalProgress } from "../goals/cascade.js";
import { getDirectReports, getDepartmentAgents } from "../org.js";
import { listDisabledAgents } from "../enforcement/disabled-store.js";
import { getActiveSessions } from "../enforcement/tracker.js";
import type { TaskState, TaskPriority, EventStatus } from "../types.js";
import { listPendingProposals } from "../approval/resolve.js";
import { getBudgetStatus } from "../budget-windows.js";
import { computeDailySnapshot, computeWeeklyTrend, computeMonthlyProjection } from "../budget/forecast.js";
import { getAllCategoryStats, getActiveTrustOverrides } from "../trust/tracker.js";
import { listChannels, getChannel } from "../channels/store.js";
import { buildChannelTranscript } from "../channels/messages.js";
import { getMeetingStatus } from "../channels/meeting.js";
import { getDb } from "../db.js";

export type PaginationParams = {
  limit?: number;
  offset?: number;
};

/** List all active projects. */
export function queryProjects() {
  const projectIds = getActiveProjectIds();
  return projectIds.map((id) => {
    const agentIds = getRegisteredAgentIds().filter((aid) => {
      const entry = getAgentConfig(aid);
      return entry?.projectId === id;
    });
    return { id, agentCount: agentIds.length };
  });
}

/** List agents for a project with their status. */
export function queryAgents(projectId: string) {
  const allAgentIds = getRegisteredAgentIds();
  const activeSessions = getActiveSessions();
  const disabled = listDisabledAgents(projectId);
  const disabledSet = new Set(disabled.map((d) => d.agentId));

  return allAgentIds
    .map((aid) => {
      const entry = getAgentConfig(aid);
      if (!entry || entry.projectId !== projectId) return null;
      const session = activeSessions.find((s) => s.agentId === aid && s.projectId === projectId);
      return {
        id: aid,
        extends: entry.config.extends,
        title: entry.config.title,
        department: entry.config.department,
        team: entry.config.team,
        status: disabledSet.has(aid) ? "disabled" : session ? "active" : "idle",
        currentSessionKey: session?.sessionKey,
      };
    })
    .filter(Boolean);
}

/** Get detailed info for a single agent. */
export function queryAgentDetail(projectId: string, agentId: string) {
  const entry = getAgentConfig(agentId);
  if (!entry || entry.projectId !== projectId) return null;

  const activeSessions = getActiveSessions();
  const session = activeSessions.find((s) => s.agentId === agentId && s.projectId === projectId);
  const disabled = listDisabledAgents(projectId).find((d) => d.agentId === agentId);
  const directReports = getDirectReports(projectId, agentId);

  return {
    id: agentId,
    extends: entry.config.extends,
    title: entry.config.title,
    department: entry.config.department,
    team: entry.config.team,
    persona: entry.config.persona,
    status: disabled ? "disabled" : session ? "active" : "idle",
    disabledReason: disabled?.reason,
    directReports,
    currentSession: session ? {
      key: session.sessionKey,
      startedAt: session.metrics.startedAt,
      toolCalls: session.metrics.toolCalls.length,
    } : null,
    expectations: entry.config.expectations,
    performancePolicy: entry.config.performance_policy,
  };
}

/** List tasks with filters. */
export function queryTasks(
  projectId: string,
  filters?: {
    state?: TaskState | TaskState[];
    assignedTo?: string;
    priority?: TaskPriority;
    department?: string;
    team?: string;
  },
  pagination?: PaginationParams,
) {
  const limit = pagination?.limit ?? 50;
  const states = filters?.state
    ? (Array.isArray(filters.state) ? filters.state : [filters.state])
    : undefined;

  const tasks = listTasks(projectId, {
    states,
    assignedTo: filters?.assignedTo,
    priority: filters?.priority,
    department: filters?.department,
    team: filters?.team,
    limit: limit + 1, // fetch one extra to determine hasMore
  });

  const hasMore = tasks.length > limit;
  return {
    tasks: tasks.slice(0, limit),
    hasMore,
    count: tasks.length > limit ? limit : tasks.length,
  };
}

/** Get task detail with evidence and transitions. */
export function queryTaskDetail(projectId: string, taskId: string) {
  const task = getTask(projectId, taskId);
  if (!task) return null;

  const evidence = getTaskEvidence(projectId, taskId);
  const transitions = getTaskTransitions(projectId, taskId);

  return { task, evidence, transitions };
}

/** List audit entries. */
export function querySessions(projectId: string, pagination?: PaginationParams) {
  const limit = pagination?.limit ?? 50;

  const entries = queryAuditLog({
    projectId,
    limit: limit + 1,
  });

  const hasMore = entries.length > limit;
  return {
    sessions: entries.slice(0, limit),
    hasMore,
  };
}

/** List events with filters. */
export function queryEvents(
  projectId: string,
  filters?: { status?: EventStatus; type?: string },
  pagination?: PaginationParams,
) {
  const limit = pagination?.limit ?? 50;
  const events = listEvents(projectId, {
    status: filters?.status,
    type: filters?.type,
    limit,
  });

  return { events, count: events.length };
}

/** Query metrics with aggregation. */
export function queryMetricsDashboard(
  projectId: string,
  params?: { type?: string; key?: string; window?: number },
) {
  if (params?.key) {
    const results = aggregateMetrics({
      projectId,
      type: params.type as any,
      key: params.key,
      since: params.window ? Date.now() - params.window : undefined,
    });
    return { aggregates: results };
  }

  const metrics = queryMetrics({
    projectId,
    type: params?.type as any,
    since: params?.window ? Date.now() - params.window : undefined,
    limit: 100,
  });
  return { metrics, count: metrics.length };
}

/** Get cost summary. */
export function queryCosts(
  projectId: string,
  params?: { agentId?: string; taskId?: string; since?: number; until?: number },
) {
  return getCostSummary({
    projectId,
    agentId: params?.agentId,
    taskId: params?.taskId,
    since: params?.since,
    until: params?.until,
  });
}

/** Get active policies and recent violations. */
export function queryPolicies(projectId: string) {
  const extConfig = getExtendedProjectConfig(projectId);
  return {
    policies: extConfig?.policies ?? [],
  };
}

/** Evaluate SLOs. */
export function querySlos(projectId: string) {
  const extConfig = getExtendedProjectConfig(projectId);
  if (!extConfig?.monitoring?.slos) return { slos: [] };

  const slos = extConfig.monitoring.slos as Record<string, any>;
  const results = evaluateSlos(projectId, slos);
  return { slos: results };
}

/** Evaluate alert rules. */
export function queryAlerts(projectId: string) {
  const extConfig = getExtendedProjectConfig(projectId);
  if (!extConfig?.monitoring?.alertRules) return { alerts: [] };

  const rules = extConfig.monitoring.alertRules as Record<string, any>;
  const results = evaluateAlertRules(projectId, rules);
  return { alerts: results };
}

/** Get org chart for a project. */
export function queryOrgChart(projectId: string) {
  const allAgentIds = getRegisteredAgentIds();
  const agents = allAgentIds
    .map((aid) => {
      const entry = getAgentConfig(aid);
      if (!entry || entry.projectId !== projectId) return null;
      return {
        id: aid,
        extends: entry.config.extends,
        title: entry.config.title,
        department: entry.config.department,
        team: entry.config.team,
        reportsTo: entry.config.reports_to,
        directReports: getDirectReports(projectId, aid),
      };
    })
    .filter(Boolean);

  // Extract unique departments
  const departments = [...new Set(agents.map((a) => a!.department).filter(Boolean))];

  return { agents, departments };
}

/** Get project health tier (based on SLO/alert/anomaly counts). */
export function queryHealth(projectId: string) {
  const extConfig = getExtendedProjectConfig(projectId);

  let sloChecked = 0;
  let sloBreach = 0;
  let alertsFired = 0;

  // Evaluate SLOs
  if (extConfig?.monitoring?.slos) {
    try {
      const sloResults = evaluateSlos(projectId, extConfig.monitoring.slos as Record<string, any>);
      sloChecked = sloResults.length;
      sloBreach = sloResults.filter((s: any) => s.status === "breach").length;
    } catch { /* ignore */ }
  }

  // Evaluate alerts
  if (extConfig?.monitoring?.alertRules) {
    try {
      const alertResults = evaluateAlertRules(projectId, extConfig.monitoring.alertRules as Record<string, any>);
      alertsFired = alertResults.filter((a: any) => a.fired).length;
    } catch { /* ignore */ }
  }

  const tier = computeHealthTier({
    sloChecked,
    sloBreach,
    alertsFired,
    anomaliesDetected: 0,
  });

  return { tier, sloChecked, sloBreach, alertsFired };
}

/** Query active and recent protocols for a project. */
export function queryProtocols(
  projectId: string,
  filters?: {
    agentId?: string;
    type?: MessageType;
    protocolStatus?: ProtocolStatus;
    limit?: number;
  },
) {
  if (filters?.agentId) {
    const protocols = getActiveProtocols(projectId, filters.agentId);
    let result = protocols;
    if (filters.type) result = result.filter((p) => p.type === filters.type);
    if (filters.protocolStatus) result = result.filter((p) => p.protocolStatus === filters.protocolStatus);
    const limit = filters.limit ?? 50;
    return { protocols: result.slice(0, limit), count: result.length };
  }

  // Without agent filter, search messages with protocol_status set
  const { messages } = searchMessages(projectId, {
    type: filters?.type,
    limit: filters?.limit ?? 50,
  });
  const protocols = messages.filter((m) => m.protocolStatus != null);
  return { protocols, count: protocols.length };
}

/** Query goals for a project with optional filters. */
export function queryGoals(
  projectId: string,
  filters?: {
    status?: GoalStatus;
    ownerAgentId?: string;
    parentGoalId?: string | null;
    limit?: number;
  },
  pagination?: PaginationParams,
) {
  const limit = pagination?.limit ?? filters?.limit ?? 50;
  const goals = listGoals(projectId, {
    status: filters?.status,
    ownerAgentId: filters?.ownerAgentId,
    parentGoalId: filters?.parentGoalId,
    limit: limit + 1,
  });
  const hasMore = goals.length > limit;
  return { goals: goals.slice(0, limit), hasMore, count: goals.length };
}

/** Query goal detail with children, tasks, and progress. */
export function queryGoalDetail(projectId: string, goalId: string) {
  const goal = getGoal(projectId, goalId);
  if (!goal) return null;

  const childGoals = getChildGoals(projectId, goalId);
  const tasks = getGoalTasks(projectId, goalId);
  const progress = computeGoalProgress(projectId, goalId);

  return { goal, childGoals, tasks, progress };
}

/** Query messages for a project with optional filters. */
export function queryMessages(
  projectId: string,
  filters?: {
    agentId?: string;
    type?: MessageType;
    status?: MessageStatus;
    since?: number;
    limit?: number;
  },
) {
  return searchMessages(projectId, filters);
}

// ─── Extended queries for dashboard ────────────────────────────────────────────

/** Dashboard summary: 4 metric cards (budget utilization, active agents, tasks in flight, pending approvals). */
export function queryDashboardSummary(projectId: string) {
  // Budget utilization
  let budgetUtilization = { spent: 0, limit: 0, pct: 0 };
  try {
    const budgetStatus = getBudgetStatus(projectId);
    // BudgetStatus has hourly/daily/monthly WindowStatus fields
    const windows = [budgetStatus.hourly, budgetStatus.daily, budgetStatus.monthly].filter(Boolean);
    const spent = windows.reduce((acc, w) => acc + (w?.spentCents ?? 0), 0);
    const limit = windows.reduce((acc, w) => acc + (w?.limitCents ?? 0), 0);
    budgetUtilization = {
      spent,
      limit,
      pct: limit > 0 ? Math.round((spent / limit) * 100) : 0,
    };
  } catch { /* no budget configured */ }

  // Active agents
  const allAgentIds = getRegisteredAgentIds();
  const activeSessions = getActiveSessions();
  const projectAgentIds = allAgentIds.filter((aid) => {
    const entry = getAgentConfig(aid);
    return entry?.projectId === projectId;
  });
  const activeAgents = projectAgentIds.filter((aid) =>
    activeSessions.some((s) => s.agentId === aid && s.projectId === projectId),
  ).length;

  // Tasks in flight (ASSIGNED + IN_PROGRESS)
  let tasksInFlight = 0;
  try {
    const { tasks } = queryTasks(projectId, {
      state: ["ASSIGNED", "IN_PROGRESS"] as TaskState[],
    });
    tasksInFlight = tasks.length;
  } catch { /* ignore */ }

  // Pending approvals
  let pendingApprovals = 0;
  try {
    pendingApprovals = listPendingProposals(projectId).length;
  } catch { /* ignore */ }

  return {
    budgetUtilization,
    activeAgents,
    totalAgents: projectAgentIds.length,
    tasksInFlight,
    pendingApprovals,
  };
}

/** Query approval proposals with optional status filter. */
export function queryApprovals(
  projectId: string,
  filters?: { status?: "pending" | "approved" | "rejected"; limit?: number },
) {
  const limit = filters?.limit ?? 50;

  if (!filters?.status || filters.status === "pending") {
    const proposals = listPendingProposals(projectId);
    return { proposals: proposals.slice(0, limit), count: proposals.length };
  }

  // For resolved proposals, query the database directly
  const db = getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM proposals WHERE project_id = ? AND status = ? ORDER BY resolved_at DESC LIMIT ?",
  ).all(projectId, filters.status, limit) as Record<string, unknown>[];
  return { proposals: rows, count: rows.length };
}

/** Query budget status with window breakdowns. */
export function queryBudgetStatus(projectId: string) {
  try {
    return getBudgetStatus(projectId);
  } catch {
    return { windows: [], alerts: [] };
  }
}

/** Query budget forecast (daily snapshot, weekly trend, monthly projection). */
export function queryBudgetForecast(projectId: string) {
  const db = getDb(projectId);
  try {
    const daily = computeDailySnapshot(projectId, db);
    const weekly = computeWeeklyTrend(projectId, db);
    const monthly = computeMonthlyProjection(projectId, db);
    return { daily, weekly, monthly };
  } catch {
    return { daily: null, weekly: null, monthly: null };
  }
}

/** Query trust scores per agent grouped by category. */
export function queryTrustScores(projectId: string) {
  try {
    const stats = getAllCategoryStats(projectId);
    const overrides = getActiveTrustOverrides(projectId);

    // Group stats by agent-like categories (the trust system tracks categories, not agents directly)
    return {
      agents: stats,
      overrides,
    };
  } catch {
    return { agents: [], overrides: [] };
  }
}

/** Read current config for a project. */
export function queryConfig(projectId: string) {
  const extConfig = getExtendedProjectConfig(projectId);
  if (!extConfig) return null;

  return {
    toolGates: extConfig.toolGates ?? {},
    riskTiers: extConfig.riskTiers ?? {},
    dispatch: extConfig.dispatch ?? {},
    safety: extConfig.safety ?? {},
    monitoring: extConfig.monitoring ?? {},
    policies: extConfig.policies ?? [],
    channels: extConfig.channels ?? [],
    review: extConfig.review ?? {},
  };
}

/** Query meetings (channels with type='meeting'). */
export function queryMeetings(
  projectId: string,
  filters?: { status?: string; limit?: number },
) {
  const meetings = listChannels(projectId, {
    type: "meeting" as any,
    status: filters?.status as any,
    limit: filters?.limit ?? 50,
  });
  return { meetings, count: meetings.length };
}

/** Query meeting detail with transcript. */
export function queryMeetingDetail(projectId: string, meetingId: string) {
  const channel = getChannel(projectId, meetingId);
  if (!channel) return null;

  try {
    const status = getMeetingStatus(projectId, meetingId);
    if (status) {
      return {
        channel,
        currentTurn: status.currentTurn,
        participants: status.participants,
        transcript: status.transcript,
      };
    }
  } catch {
    // If meeting status fails (not a meeting channel, etc.), return basic channel info
    const transcript = buildChannelTranscript(projectId, meetingId);
    return { channel, transcript };
  }
}
