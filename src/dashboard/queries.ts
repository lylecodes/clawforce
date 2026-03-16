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
import { listEvents, countEvents } from "../events/store.js";
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
import { listChannels, getChannel, getChannelMessages } from "../channels/store.js";
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

/** List agents for a project with their status, task counts, and costs. */
export function queryAgents(projectId: string) {
  const allAgentIds = getRegisteredAgentIds();
  const activeSessions = getActiveSessions();
  const disabled = listDisabledAgents(projectId);
  const disabledSet = new Set(disabled.map((d) => d.agentId));

  // Pre-fetch per-agent task counts and costs from DB
  let taskCounts: Record<string, number> = {};
  let costCents: Record<string, number> = {};
  try {
    const db = getDb(projectId);
    const taskRows = db.prepare(
      "SELECT assigned_to, COUNT(*) as cnt FROM tasks WHERE project_id = ? AND state = 'DONE' GROUP BY assigned_to",
    ).all(projectId) as Array<{ assigned_to: string; cnt: number }>;
    for (const r of taskRows) taskCounts[r.assigned_to] = r.cnt;

    const costRows = db.prepare(
      "SELECT agent_id, COALESCE(SUM(cost_cents), 0) as total FROM cost_records WHERE project_id = ? GROUP BY agent_id",
    ).all(projectId) as Array<{ agent_id: string; total: number }>;
    for (const r of costRows) costCents[r.agent_id] = r.total;
  } catch { /* DB may not exist */ }

  return allAgentIds
    .map((aid) => {
      const entry = getAgentConfig(aid);
      if (!entry || entry.projectId !== projectId) return null;
      const session = activeSessions.find((s) => s.agentId === aid && s.projectId === projectId);
      const tasks = taskCounts[aid] ?? 0;
      const cost = costCents[aid] ?? 0;
      return {
        id: aid,
        extends: entry.config.extends,
        title: entry.config.title,
        department: entry.config.department,
        team: entry.config.team,
        status: disabledSet.has(aid) ? "disabled" : session ? "active" : "idle",
        currentSessionKey: session?.sessionKey,
        tasksCompleted: tasks,
        totalCostCents: cost,
      };
    })
    .filter(Boolean);
}

/** Get detailed info for a single agent (includes tasksCompleted and totalCostCents like the list endpoint). */
export function queryAgentDetail(projectId: string, agentId: string) {
  const entry = getAgentConfig(agentId);
  if (!entry || entry.projectId !== projectId) return null;

  const activeSessions = getActiveSessions();
  const session = activeSessions.find((s) => s.agentId === agentId && s.projectId === projectId);
  const disabled = listDisabledAgents(projectId).find((d) => d.agentId === agentId);
  const directReports = getDirectReports(projectId, agentId);

  // Compute tasksCompleted and totalCostCents (same as queryAgents list)
  let tasksCompleted = 0;
  let totalCostCents = 0;
  try {
    const db = getDb(projectId);
    const taskRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND assigned_to = ? AND state = 'DONE'",
    ).get(projectId, agentId) as { cnt: number } | undefined;
    if (taskRow) tasksCompleted = taskRow.cnt;

    const costRow = db.prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as total FROM cost_records WHERE project_id = ? AND agent_id = ?",
    ).get(projectId, agentId) as { total: number } | undefined;
    if (costRow) totalCostCents = costRow.total;
  } catch { /* DB may not exist */ }

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
    tasksCompleted,
    totalCostCents,
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

/** List events with filters. Adds `timestamp` alias of `createdAt` for frontend compatibility. */
export function queryEvents(
  projectId: string,
  filters?: { status?: EventStatus; type?: string },
  pagination?: PaginationParams,
) {
  const limit = pagination?.limit ?? 50;
  const offset = pagination?.offset ?? 0;
  const rawEvents = listEvents(projectId, {
    status: filters?.status,
    type: filters?.type,
    limit,
  });
  const total = countEvents(projectId, filters);

  // Add timestamp alias for frontend EventEntry type
  const events = rawEvents.map((e) => ({ ...e, timestamp: e.createdAt }));

  return { events, total, count: events.length, limit, offset };
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

/** Get cost summary with daily breakdown for charts. */
export function queryCosts(
  projectId: string,
  params?: { agentId?: string; taskId?: string; since?: number; until?: number; days?: string },
) {
  // Compute time range from days param
  const daysNum = params?.days ? parseInt(params.days, 10) : 7;
  const since = params?.since ?? Date.now() - daysNum * 86_400_000;
  const until = params?.until ?? Date.now();

  const summary = getCostSummary({
    projectId,
    agentId: params?.agentId,
    taskId: params?.taskId,
    since,
    until,
  });

  // Build daily breakdown from cost_records
  const db = getDb(projectId);
  let daily: Array<{ date: string; totalCents: number; byInitiative: Record<string, number> }> = [];
  try {
    const rows = db.prepare(`
      SELECT date(created_at / 1000, 'unixepoch', 'localtime') as day,
             COALESCE(SUM(cost_cents), 0) as total
      FROM cost_records
      WHERE project_id = ? AND created_at >= ? AND created_at <= ?
      GROUP BY day ORDER BY day
    `).all(projectId, since, until) as Array<{ day: string; total: number }>;
    daily = rows.map((r) => ({
      date: r.day,
      totalCents: r.total,
      byInitiative: {},
    }));
  } catch { /* table may not exist in test DBs */ }

  return {
    daily,
    totalCents: summary.totalCostCents,
    currency: "USD",
    totalInputTokens: summary.totalInputTokens,
    totalOutputTokens: summary.totalOutputTokens,
    recordCount: summary.recordCount,
  };
}

/** Get active policies and recent violations. */
export function queryPolicies(projectId: string) {
  const extConfig = getExtendedProjectConfig(projectId);
  return {
    policies: extConfig?.policies ?? [],
  };
}

/** Evaluate SLOs. Normalizes raw config keys to SloDefinition fields. */
export function querySlos(projectId: string) {
  const extConfig = getExtendedProjectConfig(projectId);
  if (!extConfig?.monitoring?.slos) return { slos: [] };

  const raw = extConfig.monitoring.slos as Record<string, Record<string, unknown>>;
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(raw)) {
    normalized[name] = {
      name,
      metricType: String(cfg.metric_type ?? cfg.metricType ?? ""),
      metricKey: String(cfg.metric_key ?? cfg.metricKey ?? ""),
      aggregation: String(cfg.aggregation ?? "avg"),
      condition: String(cfg.condition ?? "lt"),
      threshold: Number(cfg.threshold ?? 0),
      windowMs: Number(cfg.window_ms ?? cfg.windowMs ?? 3600000),
      severity: String(cfg.severity ?? "warning"),
      denominatorKey: typeof cfg.denominator_key === "string" ? cfg.denominator_key : undefined,
      noDataPolicy: cfg.no_data_policy ?? cfg.noDataPolicy ?? "pass",
    };
  }
  const results = evaluateSlos(projectId, normalized as any);

  // Post-process: compute actual values for well-known SLOs that lack metric data
  const db = getDb(projectId);
  for (const result of results) {
    if (result.actual === null && result.metricKey === "completion_rate") {
      // Compute task-completion-rate directly from the tasks table
      try {
        const doneRow = db.prepare(
          "SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND state = 'DONE'",
        ).get(projectId) as { cnt: number } | undefined;
        const totalRow = db.prepare(
          "SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND state != 'CANCELLED'",
        ).get(projectId) as { cnt: number } | undefined;

        const done = doneRow?.cnt ?? 0;
        const total = totalRow?.cnt ?? 0;

        if (total > 0) {
          result.actual = done / total;
          // Re-evaluate the condition with the computed actual value
          const sloConfig = normalized[result.sloName];
          if (sloConfig) {
            const threshold = Number(sloConfig.threshold);
            const condition = String(sloConfig.condition);
            switch (condition) {
              case "lt": result.passed = result.actual < threshold; break;
              case "gt": result.passed = result.actual > threshold; break;
              case "lte": result.passed = result.actual <= threshold; break;
              case "gte": result.passed = result.actual >= threshold; break;
            }
          }
          result.noData = false;
        }
      } catch { /* tasks table may not exist */ }
    }
  }

  return { slos: results };
}

/** Evaluate alert rules. Normalizes raw config keys. */
export function queryAlerts(projectId: string) {
  const extConfig = getExtendedProjectConfig(projectId);
  if (!extConfig?.monitoring?.alertRules) return { alerts: [] };

  const raw = extConfig.monitoring.alertRules as Record<string, Record<string, unknown>>;
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(raw)) {
    // Normalize operator/condition: support both YAML field names and symbolic operators
    const rawCondition = String(cfg.condition ?? cfg.operator ?? "gt");
    const conditionMap: Record<string, string> = { ">": "gt", "<": "lt", ">=": "gte", "<=": "lte", "==": "eq", "=": "eq" };
    const condition = conditionMap[rawCondition] ?? rawCondition;

    normalized[name] = {
      name,
      metricType: String(cfg.metric_type ?? cfg.metricType ?? ""),
      metricKey: String(cfg.metric_key ?? cfg.metricKey ?? ""),
      aggregation: String(cfg.aggregation ?? "sum"),
      condition,
      threshold: Number(cfg.threshold ?? 0),
      windowMs: Number(cfg.window_ms ?? cfg.windowMs ?? 3600000),
      cooldownMs: Number(cfg.cooldown_ms ?? cfg.cooldownMs ?? 3600000),
    };
  }
  const results = evaluateAlertRules(projectId, normalized as any);
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
  const sliced = goals.slice(0, limit);
  return { goals: sliced, hasMore, count: sliced.length };
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

/** Query messages for a specific thread/channel, shaped for the dashboard ThreadMessagesResponse type. */
export function queryThreadMessages(
  projectId: string,
  threadId: string,
  filters?: { limit?: number; since?: number },
) {
  const messages = getChannelMessages(projectId, threadId, {
    limit: filters?.limit ?? 100,
    since: filters?.since,
  });
  return { messages, count: messages.length };
}

/** Query messages for a project with optional filters, grouped into threads. */
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
  const { messages } = searchMessages(projectId, filters);

  // Group messages by channelId (or parentMessageId, or create a synthetic thread per DM pair)
  const threadMap = new Map<string, {
    id: string;
    type: string;
    participants: Set<string>;
    messages: typeof messages;
    lastMessageAt: number;
    channelId?: string;
  }>();

  for (const msg of messages) {
    // Thread key: channelId if available, otherwise parentMessageId, otherwise synthesize from participants
    const threadKey = msg.channelId
      ?? msg.parentMessageId
      ?? [msg.fromAgent, msg.toAgent].sort().join("::");

    const existing = threadMap.get(threadKey);
    if (existing) {
      existing.participants.add(msg.fromAgent);
      existing.participants.add(msg.toAgent);
      existing.messages.push(msg);
      if (msg.createdAt > existing.lastMessageAt) {
        existing.lastMessageAt = msg.createdAt;
      }
    } else {
      threadMap.set(threadKey, {
        id: threadKey,
        type: msg.type ?? "direct",
        participants: new Set([msg.fromAgent, msg.toAgent]),
        messages: [msg],
        lastMessageAt: msg.createdAt,
        channelId: msg.channelId ?? undefined,
      });
    }
  }

  const threads = Array.from(threadMap.values()).map((t) => ({
    id: t.id,
    type: t.type,
    participants: [...t.participants],
    messages: t.messages,
    lastMessageAt: t.lastMessageAt,
    channelId: t.channelId,
  }));

  // Sort threads by most recent message first
  threads.sort((a, b) => b.lastMessageAt - a.lastMessageAt);

  return { threads, count: threads.length };
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

  // Tasks in flight (ASSIGNED + IN_PROGRESS + REVIEW)
  let tasksInFlight = 0;
  try {
    const { tasks } = queryTasks(projectId, {
      state: ["ASSIGNED", "IN_PROGRESS", "REVIEW"] as TaskState[],
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

/** Transform a raw proposal DB row (snake_case) to camelCase for the frontend. */
function mapProposalRow(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string) ?? undefined,
    agentId: row.proposed_by as string,
    status: row.status as string,
    createdAt: row.created_at as number,
    resolvedAt: (row.resolved_at as number) ?? undefined,
    feedback: (row.user_feedback as string) ?? undefined,
    riskTier: (row.risk_tier as string) ?? undefined,
    policySnapshot: (row.approval_policy_snapshot as string) ?? undefined,
    toolName: undefined as string | undefined,
    category: undefined as string | undefined,
    summary: (row.description as string) ?? (row.title as string),
  };
}

/** Query approval proposals with optional status filter. */
export function queryApprovals(
  projectId: string,
  filters?: { status?: "pending" | "approved" | "rejected"; limit?: number },
) {
  const limit = filters?.limit ?? 50;

  if (!filters?.status || filters.status === "pending") {
    const rawProposals = listPendingProposals(projectId);
    const proposals = rawProposals.slice(0, limit).map((p) => mapProposalRow(p as unknown as Record<string, unknown>));
    return { proposals, count: rawProposals.length };
  }

  // For resolved proposals, query the database directly
  const db = getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM proposals WHERE project_id = ? AND status = ? ORDER BY resolved_at DESC LIMIT ?",
  ).all(projectId, filters.status, limit) as Record<string, unknown>[];
  const proposals = rows.map(mapProposalRow);
  return { proposals, count: proposals.length };
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

/** Query trust scores per agent, aggregated from category-level trust decisions. */
export function queryTrustScores(projectId: string) {
  try {
    const overrides = getActiveTrustOverrides(projectId);

    // Query trust decisions grouped by agent and category from DB
    const db = getDb(projectId);
    let agentCategoryRows: Array<{ agent_id: string; category: string; approved: number; total: number }> = [];
    try {
      agentCategoryRows = db.prepare(`
        SELECT agent_id, category,
               SUM(CASE WHEN decision = 'approved' THEN 1 ELSE 0 END) as approved,
               COUNT(*) as total
        FROM trust_decisions
        WHERE project_id = ? AND agent_id IS NOT NULL
        GROUP BY agent_id, category
      `).all(projectId) as Array<{ agent_id: string; category: string; approved: number; total: number }>;
    } catch { /* trust_decisions table may be empty or not exist */ }

    if (agentCategoryRows.length > 0) {
      // Aggregate trust data by agent
      const agentMap = new Map<string, { categories: Record<string, number>; totalApproved: number; totalDecisions: number }>();
      for (const row of agentCategoryRows) {
        const entry = agentMap.get(row.agent_id) ?? { categories: {}, totalApproved: 0, totalDecisions: 0 };
        const rate = row.total > 0 ? row.approved / row.total : 0;
        entry.categories[row.category] = rate;
        entry.totalApproved += row.approved;
        entry.totalDecisions += row.total;
        agentMap.set(row.agent_id, entry);
      }

      const agents = Array.from(agentMap.entries()).map(([agentId, data]) => ({
        agentId,
        overall: data.totalDecisions > 0 ? data.totalApproved / data.totalDecisions : 1,
        categories: data.categories,
        trend: "stable" as const,
      }));

      return { agents, overrides };
    }

    // If no trust decisions exist, return agents from the domain config with default scores
    const allAgentIds = getRegisteredAgentIds();
    const agents = allAgentIds
      .map((aid) => {
        const entry = getAgentConfig(aid);
        if (!entry || entry.projectId !== projectId) return null;
        return {
          agentId: aid,
          overall: 1,
          categories: {} as Record<string, number>,
          trend: "stable" as const,
        };
      })
      .filter(Boolean) as Array<{ agentId: string; overall: number; categories: Record<string, number>; trend: "stable" }>;

    return { agents, overrides };
  } catch {
    return { agents: [], overrides: [] };
  }
}

/** Read current config for a project, shaped for the dashboard DomainConfig type. */
export function queryConfig(projectId: string) {
  const extConfig = getExtendedProjectConfig(projectId);

  // Build agents list from the agent registry
  const allAgentIds = getRegisteredAgentIds();
  const agents = allAgentIds
    .map((aid) => {
      const entry = getAgentConfig(aid);
      if (!entry || entry.projectId !== projectId) return null;
      return {
        id: aid,
        extends: entry.config.extends,
        title: entry.config.title,
        persona: entry.config.persona,
        reports_to: entry.config.reports_to,
        department: entry.config.department,
        team: entry.config.team,
        channel: entry.config.channel,
        briefing: entry.config.briefing,
        expectations: entry.config.expectations,
        performance_policy: entry.config.performance_policy,
      };
    })
    .filter(Boolean);

  // Build budget from budget-windows status, falling back to domain config
  let budget: Record<string, unknown> = {};
  try {
    const budgetStatus = getBudgetStatus(projectId);
    if (budgetStatus.hourly || budgetStatus.daily || budgetStatus.monthly) {
      budget = {
        daily: budgetStatus.daily ? { cents: budgetStatus.daily.limitCents } : undefined,
        hourly: budgetStatus.hourly ? { cents: budgetStatus.hourly.limitCents } : undefined,
        monthly: budgetStatus.monthly ? { cents: budgetStatus.monthly.limitCents } : undefined,
      };
    }
  } catch { /* no budget configured */ }

  // Build tool_gates array from extConfig.toolGates
  const toolGatesConfig = extConfig?.toolGates ?? {};
  const toolGates = Object.entries(toolGatesConfig).map(([tool, gate]) => ({
    tool,
    category: (gate as Record<string, unknown>)?.category as string | undefined,
    risk_tier: (gate as Record<string, unknown>)?.risk_tier as string ?? "low",
  }));

  // Build safety from extConfig
  const safety = extConfig?.safety ?? {};

  return {
    agents,
    budget,
    tool_gates: toolGates,
    initiatives: {},
    jobs: [],
    safety,
    profile: {},
    rules: [],
    event_handlers: extConfig?.eventHandlers ? Object.values(extConfig.eventHandlers) : [],
    memory: {},
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
