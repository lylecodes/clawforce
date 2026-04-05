/**
 * Clawforce — Dashboard query layer
 *
 * Thin wrappers around existing data functions with pagination and response shaping.
 * Reuses existing core functions — no direct DB access.
 */

import { getActiveProjectIds } from "../lifecycle.js";
import { getAgentConfig, getRegisteredAgentIds, getExtendedProjectConfig } from "../project.js";
import { listTasks, getTask, getTaskEvidence, getTaskTransitions } from "../tasks/ops.js";
import { listSessionArchives, getSessionArchive, countSessionArchives } from "../telemetry/session-archive.js";
import { queryMetrics, aggregateMetrics } from "../metrics.js";
import { getCostSummary } from "../cost.js";
import { evaluateSlos } from "../monitoring/slo.js";
import { evaluateAlertRules } from "../monitoring/alerts.js";
import { computeHealthTier } from "../monitoring/health-tier.js";
import { listEvents, countEvents } from "../events/store.js";
import { searchMessages } from "../messaging/store.js";
import { getActiveProtocols } from "../messaging/protocols.js";
import type { MessageType, MessageStatus, ProtocolStatus, GoalStatus, TaskOrigin } from "../types.js";
import { listGoals, getGoal, getChildGoals, getGoalTasks } from "../goals/ops.js";
import { computeGoalProgress } from "../goals/cascade.js";
import { getDirectReports, getDepartmentAgents } from "../org.js";
import { listDisabledAgents } from "../enforcement/disabled-store.js";
import { getActiveSessions } from "../enforcement/tracker.js";
import type { TaskState, TaskPriority, TaskKind, EventStatus } from "../types.js";
import { listPendingProposals } from "../approval/resolve.js";
import { getBudgetStatus } from "../budget-windows.js";
import { computeDailySnapshot, computeWeeklyTrend, computeMonthlyProjection } from "../budget/forecast.js";
import { getAllCategoryStats, getActiveTrustOverrides } from "../trust/tracker.js";
import { getTrustTimeline } from "../telemetry/trust-history.js";
import { listChannels, getChannel, getChannelMessages } from "../channels/store.js";
import { buildChannelTranscript } from "../channels/messages.js";
import { getMeetingStatus } from "../channels/meeting.js";
import { getDb } from "../db.js";
import { writeAuditEntry } from "../audit.js";
import { getAllOperationalMetrics } from "../metrics/operational.js";
import type { OperationalMetrics } from "../metrics/operational.js";
import fs from "node:fs";
import path from "node:path";

export type PaginationParams = {
  limit?: number;
  offset?: number;
};

export class ContextFileError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ContextFileError";
    this.status = status;
  }
}

function resolveContextFilePath(projectDir: string, relativePath: string): string {
  if (!relativePath || typeof relativePath !== "string") {
    throw new ContextFileError("Invalid path", 400);
  }

  if (path.isAbsolute(relativePath)) {
    throw new ContextFileError("Path must be relative", 403);
  }

  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.includes("..")) {
    throw new ContextFileError("Path traversal is not allowed", 403);
  }

  const resolvedPath = path.resolve(projectDir, relativePath);
  const normalizedProjectDir = path.resolve(projectDir);
  if (!resolvedPath.startsWith(normalizedProjectDir + path.sep) && resolvedPath !== normalizedProjectDir) {
    throw new ContextFileError("Path traversal is not allowed", 403);
  }

  return resolvedPath;
}

export function readContextFile(projectDir: string, relativePath: string) {
  const filePath = resolveContextFilePath(projectDir, relativePath);

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new ContextFileError("File not found", 404);
  }

  const stat = fs.statSync(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  return {
    content,
    path: relativePath,
    lastModified: stat.mtimeMs,
  };
}

export function writeContextFile(projectDir: string, relativePath: string, content: string) {
  const filePath = resolveContextFilePath(projectDir, relativePath);
  fs.writeFileSync(filePath, content, "utf8");
  return { ok: true as const };
}

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
    expectations: (entry.config.expectations ?? []).map((exp) =>
      typeof exp === "string"
        ? exp
        : `${exp.tool}${Array.isArray(exp.action) ? `: ${exp.action.join(", ")}` : exp.action ? `: ${exp.action}` : ""} (min: ${exp.min_calls})`,
    ),
    performancePolicy: entry.config.performance_policy,
    tasksCompleted,
    totalCostCents,
    enforcementRetries: queryEnforcementRetries(projectId, { agentId }).retries,
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
    kind?: TaskKind;
    excludeKinds?: TaskKind[];
    origin?: TaskOrigin;
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
    kind: filters?.kind,
    excludeKinds: filters?.excludeKinds,
    origin: filters?.origin,
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

/** List archived sessions with pagination, total count, and optional agent filter. */
export function querySessions(
  projectId: string,
  filters?: { agentId?: string },
  pagination?: PaginationParams,
) {
  const limit = pagination?.limit ?? 50;
  const offset = pagination?.offset ?? 0;

  const filterOpts = { agentId: filters?.agentId };

  const entries = listSessionArchives(projectId, {
    ...filterOpts,
    limit: limit + 1,
    offset,
  });

  const hasMore = entries.length > limit;
  const sessions = entries.slice(0, limit);
  const total = countSessionArchives(projectId, filterOpts);

  return {
    sessions,
    total,
    hasMore,
    count: total,
  };
}

/** Get a single session archive by session key (includes full transcript). */
export function querySessionDetail(projectId: string, sessionKey: string) {
  const session = getSessionArchive(projectId, sessionKey);
  if (!session) return null;
  return { session };
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
    offset,
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
  const daysRaw = params?.days ? parseInt(params.days, 10) : 7;
  const daysNum = isNaN(daysRaw) ? 7 : daysRaw;
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
      // Compute task-completion-rate directly from the tasks table (exclude exercise tasks)
      try {
        const doneRow = db.prepare(
          "SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND state = 'DONE' AND (kind IS NULL OR kind != 'exercise')",
        ).get(projectId) as { cnt: number } | undefined;
        const totalRow = db.prepare(
          "SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND state != 'CANCELLED' AND (kind IS NULL OR kind != 'exercise')",
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

  // First pass: collect valid agent IDs for this project so we can validate
  // reportsTo references. Without this, unresolved chains (e.g. referencing a
  // deleted manager or using "parent") cause the frontend tree-building to
  // produce an empty root set → blank page.
  const projectAgentIds = new Set<string>();
  for (const aid of allAgentIds) {
    const entry = getAgentConfig(aid);
    if (entry && entry.projectId === projectId) {
      projectAgentIds.add(aid);
    }
  }

  // Second pass: build the agent list with validated reportsTo
  const agents = allAgentIds
    .map((aid) => {
      const entry = getAgentConfig(aid);
      if (!entry || entry.projectId !== projectId) return null;

      // Resolve reportsTo: keep it only if it references a real agent in this
      // project. The special value "parent" means "use subagent auto-announce"
      // which has no org-chart parent — treat as a root node.
      const rawReportsTo = entry.config.reports_to;
      const reportsTo =
        rawReportsTo && rawReportsTo !== "parent" && projectAgentIds.has(rawReportsTo)
          ? rawReportsTo
          : undefined;

      return {
        id: aid,
        extends: entry.config.extends,
        title: entry.config.title,
        department: entry.config.department,
        team: entry.config.team,
        reportsTo,
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

  // Evaluate SLOs — use querySlos which handles both config-based and DB-based SLOs
  try {
    const sloData = querySlos(projectId);
    const sloResults = sloData.slos ?? [];
    sloChecked = sloResults.filter((s: any) => !s.noData).length;
    sloBreach = sloResults.filter((s: any) => s.passed === false && !s.noData).length;
  } catch { /* ignore */ }

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

/** Query goals for a project with optional filters. Enriches each goal with per-goal task counts. */
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

  // Enrich each goal with per-goal task state counts so initiative cards show correct numbers
  let enriched: Array<typeof sliced[number] & { taskCounts?: Record<string, number> }>;
  try {
    const db = getDb(projectId);
    enriched = sliced.map((goal) => {
      const taskRows = db.prepare(
        "SELECT state, COUNT(*) as cnt FROM tasks WHERE goal_id = ? AND project_id = ? GROUP BY state",
      ).all(goal.id, projectId) as Array<{ state: string; cnt: number }>;
      const taskCounts: Record<string, number> = {};
      for (const r of taskRows) {
        taskCounts[r.state] = r.cnt;
      }
      return { ...goal, taskCounts };
    });
  } catch {
    enriched = sliced;
  }

  return { goals: enriched, hasMore, count: enriched.length };
}

/** Query goal detail with children, tasks, and progress. */
export function queryGoalDetail(projectId: string, goalId: string) {
  const goal = getGoal(projectId, goalId);
  if (!goal) return null;

  const childGoals = getChildGoals(projectId, goalId);
  const tasks = getGoalTasks(projectId, goalId);
  const progress = computeGoalProgress(projectId, goalId);

  return { ...goal, childGoals, tasks, progress };
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
    lastTimestamp: t.lastMessageAt,
    unreadCount: t.messages.filter((m: any) => !m.readAt).length,
    title: t.messages[0]?.channelId || t.id,
    lastMessage: t.messages[t.messages.length - 1]?.content?.substring(0, 100),
    channelId: t.channelId,
  }));

  // Sort threads by most recent message first
  threads.sort((a, b) => b.lastMessageAt - a.lastMessageAt);

  return { threads, count: threads.length };
}

// ─── Extended queries for dashboard ────────────────────────────────────────────

/** Dashboard summary: 4 metric cards (budget utilization, active agents, tasks in flight, pending approvals). */
export function queryDashboardSummary(projectId: string) {
  // Budget utilization — report the worst-case pressure across all windows and dimensions
  let budgetUtilization = { spent: 0, limit: 0, pct: 0, dimension: "cents" as string };
  try {
    const budgetStatus = getBudgetStatus(projectId);
    // Find the window with the highest cents utilization percentage
    const windows = [budgetStatus.hourly, budgetStatus.daily, budgetStatus.monthly].filter(Boolean);
    let worstPct = 0;
    let worstSpent = 0;
    let worstLimit = 0;
    let worstDimension = "cents";

    for (const w of windows) {
      if (w && w.limitCents > 0) {
        const pct = Math.round((w.spentCents / w.limitCents) * 100);
        if (pct > worstPct) {
          worstPct = pct;
          worstSpent = w.spentCents;
          worstLimit = w.limitCents;
          worstDimension = "cents";
        }
      }
    }

    // Also check token utilization from the budgets table directly
    try {
      const db = getDb(projectId);
      const budgetRow = db.prepare(
        "SELECT hourly_limit_tokens, hourly_spent_tokens, daily_limit_tokens, daily_spent_tokens, monthly_limit_tokens, monthly_spent_tokens FROM budgets WHERE project_id = ? AND agent_id IS NULL",
      ).get(projectId) as Record<string, number | null> | undefined;

      if (budgetRow) {
        const tokenWindows = [
          { limit: budgetRow.hourly_limit_tokens, spent: budgetRow.hourly_spent_tokens },
          { limit: budgetRow.daily_limit_tokens, spent: budgetRow.daily_spent_tokens },
          { limit: budgetRow.monthly_limit_tokens, spent: budgetRow.monthly_spent_tokens },
        ];
        for (const tw of tokenWindows) {
          if (tw.limit != null && tw.limit > 0) {
            const pct = Math.round(((tw.spent ?? 0) / tw.limit) * 100);
            if (pct > worstPct) {
              worstPct = pct;
              worstSpent = tw.spent ?? 0;
              worstLimit = tw.limit;
              worstDimension = "tokens";
            }
          }
        }
      }
    } catch { /* budgets table may not have token columns */ }

    budgetUtilization = {
      spent: worstSpent,
      limit: worstLimit,
      pct: worstPct,
      dimension: worstDimension,
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

  // Tasks in flight (ASSIGNED + IN_PROGRESS + REVIEW), excluding exercise tasks
  let tasksInFlight = 0;
  try {
    const { tasks } = queryTasks(projectId, {
      state: ["ASSIGNED", "IN_PROGRESS", "REVIEW"] as TaskState[],
      excludeKinds: ["exercise"],
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
    origin: (row.origin as string) ?? "risk_gate",
    reasoning: (row.reasoning as string) ?? undefined,
    relatedGoalId: (row.related_goal_id as string) ?? undefined,
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

/** Update the project-level daily budget limit (cents). */
export function updateBudgetLimit(projectId: string, newLimitCents: number, actor = "dashboard:api") {
  const db = getDb(projectId);
  const now = Date.now();

  const existing = db.prepare(
    "SELECT id, daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(projectId) as { id: string; daily_limit_cents: number | null } | undefined;

  const previousLimit = existing?.daily_limit_cents ?? null;

  if (existing?.id) {
    db.prepare(
      "UPDATE budgets SET daily_limit_cents = ?, updated_at = ? WHERE id = ?",
    ).run(newLimitCents, now, existing.id);
  } else {
    db.prepare(
      `INSERT INTO budgets (
        id, project_id, agent_id,
        daily_limit_cents, daily_spent_cents, daily_reset_at,
        created_at, updated_at
      ) VALUES (?, ?, NULL, ?, 0, ?, ?, ?)`,
    ).run(`budget-project-${now}`, projectId, newLimitCents, now + 86_400_000, now, now);
  }

  writeAuditEntry({
    projectId,
    actor,
    action: "budget.update_limit",
    targetType: "budget",
    targetId: "project",
    detail: JSON.stringify({ previousLimit, newLimit: newLimitCents }),
  }, db);

  return {
    ok: true as const,
    previousLimit,
    newLimit: newLimitCents,
  };
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

/** Query trust score history for the analytics timeline chart. */
export function queryTrustHistory(projectId: string, params?: Record<string, string>) {
  try {
    const sinceMs = params?.since ? parseInt(params.since, 10) : undefined;
    const agentId = params?.agent;
    const snapshots = getTrustTimeline(projectId, agentId, sinceMs);

    const points = snapshots.map((s) => ({
      agentId: s.agentId ?? "project",
      overall: s.score,
      recordedAt: s.createdAt,
    }));

    return { points };
  } catch {
    return { points: [] };
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
        briefing: (entry.config.briefing ?? []).map((b) =>
          typeof b === "string" ? b : b.source,
        ),
        expectations: (entry.config.expectations ?? []).map((exp) =>
          typeof exp === "string"
            ? exp
            : `${exp.tool}${Array.isArray(exp.action) ? `: ${exp.action.join(", ")}` : exp.action ? `: ${exp.action}` : ""} (min: ${exp.min_calls})`,
        ),
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
    risk_tier: ((gate as Record<string, unknown>)?.tier ?? (gate as Record<string, unknown>)?.risk_tier ?? "low") as string,
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

// ─── New table queries (MP-1) ──────────────────────────────────────────────────

/** Query audit_log entries with optional filters. */
export function queryAuditLog(
  projectId: string,
  filters?: { actor?: string; action?: string; targetType?: string },
  pagination?: PaginationParams,
) {
  const limit = pagination?.limit ?? 50;
  const offset = pagination?.offset ?? 0;
  const db = getDb(projectId);

  try {
    const conditions = ["project_id = ?"];
    const params: (string | number)[] = [projectId];

    if (filters?.actor) {
      conditions.push("actor = ?");
      params.push(filters.actor);
    }
    if (filters?.action) {
      conditions.push("action = ?");
      params.push(filters.action);
    }
    if (filters?.targetType) {
      conditions.push("target_type = ?");
      params.push(filters.targetType);
    }

    const where = conditions.join(" AND ");
    const countRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM audit_log WHERE ${where}`,
    ).get(...params) as { cnt: number } | undefined;
    const total = countRow?.cnt ?? 0;

    const rows = db.prepare(
      `SELECT id, actor, action, target_type, target_id, detail, created_at FROM audit_log WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as Array<{
      id: string;
      actor: string;
      action: string;
      target_type: string;
      target_id: string;
      detail: string | null;
      created_at: number;
    }>;

    const entries = rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      detail: r.detail ?? undefined,
      createdAt: r.created_at,
    }));

    return { entries, total, count: entries.length, limit, offset };
  } catch {
    return { entries: [], total: 0, count: 0, limit, offset };
  }
}

/** Query audit_runs entries with optional filters. */
export function queryAuditRuns(
  projectId: string,
  filters?: { agentId?: string; status?: string },
  pagination?: PaginationParams,
) {
  const limit = pagination?.limit ?? 50;
  const offset = pagination?.offset ?? 0;
  const db = getDb(projectId);

  try {
    const conditions = ["project_id = ?"];
    const arParams: (string | number)[] = [projectId];

    if (filters?.agentId) {
      conditions.push("agent_id = ?");
      arParams.push(filters.agentId);
    }
    if (filters?.status) {
      conditions.push("status = ?");
      arParams.push(filters.status);
    }

    const where = conditions.join(" AND ");
    const countRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM audit_runs WHERE ${where}`,
    ).get(...arParams) as { cnt: number } | undefined;
    const total = countRow?.cnt ?? 0;

    const rows = db.prepare(
      `SELECT id, agent_id, session_key, status, summary, details, started_at, ended_at, duration_ms FROM audit_runs WHERE ${where} ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ? OFFSET ?`,
    ).all(...arParams, limit, offset) as Array<{
      id: string;
      agent_id: string;
      session_key: string | null;
      status: string;
      summary: string | null;
      details: string | null;
      started_at: number | null;
      ended_at: number | null;
      duration_ms: number | null;
    }>;

    const runs = rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      sessionKey: r.session_key ?? undefined,
      status: r.status,
      summary: r.summary ?? undefined,
      details: r.details ?? undefined,
      startedAt: r.started_at ?? undefined,
      endedAt: r.ended_at ?? undefined,
      durationMs: r.duration_ms ?? undefined,
    }));

    return { runs, total, count: runs.length, limit, offset };
  } catch {
    return { runs: [], total: 0, count: 0, limit, offset };
  }
}

/** Query enforcement_retries entries. */
export function queryEnforcementRetries(
  projectId: string,
  filters?: { agentId?: string },
  pagination?: PaginationParams,
) {
  const limit = pagination?.limit ?? 50;
  const offset = pagination?.offset ?? 0;
  const db = getDb(projectId);

  try {
    const conditions = ["project_id = ?"];
    const erParams: (string | number)[] = [projectId];

    if (filters?.agentId) {
      conditions.push("agent_id = ?");
      erParams.push(filters.agentId);
    }

    const where = conditions.join(" AND ");
    const countRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM enforcement_retries WHERE ${where}`,
    ).get(...erParams) as { cnt: number } | undefined;
    const total = countRow?.cnt ?? 0;

    const rows = db.prepare(
      `SELECT id, agent_id, session_key, attempted_at, outcome FROM enforcement_retries WHERE ${where} ORDER BY attempted_at DESC LIMIT ? OFFSET ?`,
    ).all(...erParams, limit, offset) as Array<{
      id: string;
      agent_id: string;
      session_key: string;
      attempted_at: number;
      outcome: string;
    }>;

    const retries = rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      sessionKey: r.session_key,
      attemptedAt: r.attempted_at,
      outcome: r.outcome,
    }));

    return { retries, total, count: retries.length, limit, offset };
  } catch {
    return { retries: [], total: 0, count: 0, limit, offset };
  }
}

/** Query onboarding_state key-value entries. */
export function queryOnboardingState(projectId: string) {
  const db = getDb(projectId);

  try {
    const rows = db.prepare(
      "SELECT key, value, updated_at FROM onboarding_state WHERE project_id = ? ORDER BY updated_at DESC",
    ).all(projectId) as Array<{
      key: string;
      value: string;
      updated_at: number;
    }>;

    const entries = rows.map((r) => ({
      key: r.key,
      value: r.value,
      updatedAt: r.updated_at,
    }));

    return { entries, count: entries.length };
  } catch {
    return { entries: [], count: 0 };
  }
}

/** Query tracked_sessions (active enforcement sessions). */
export function queryTrackedSessions(
  projectId: string,
  pagination?: PaginationParams,
) {
  const limit = pagination?.limit ?? 50;
  const offset = pagination?.offset ?? 0;
  const db = getDb(projectId);

  try {
    const countRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM tracked_sessions WHERE project_id = ?",
    ).get(projectId) as { cnt: number } | undefined;
    const total = countRow?.cnt ?? 0;

    const rows = db.prepare(
      "SELECT session_key, agent_id, started_at, requirements, satisfied, tool_call_count, last_persisted_at FROM tracked_sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?",
    ).all(projectId, limit, offset) as Array<{
      session_key: string;
      agent_id: string;
      started_at: number;
      requirements: string;
      satisfied: string;
      tool_call_count: number;
      last_persisted_at: number;
    }>;

    const sessions = rows.map((r) => ({
      sessionKey: r.session_key,
      agentId: r.agent_id,
      startedAt: r.started_at,
      requirements: r.requirements,
      satisfied: r.satisfied,
      toolCallCount: r.tool_call_count,
      lastPersistedAt: r.last_persisted_at,
    }));

    return { sessions, total, count: sessions.length, limit, offset };
  } catch {
    return { sessions: [], total: 0, count: 0, limit, offset };
  }
}

/** Query worker_assignments (current agent-to-task mappings). */
export function queryWorkerAssignments(projectId: string) {
  const db = getDb(projectId);

  try {
    const rows = db.prepare(
      "SELECT agent_id, task_id, assigned_at FROM worker_assignments WHERE project_id = ? ORDER BY assigned_at DESC",
    ).all(projectId) as Array<{
      agent_id: string;
      task_id: string;
      assigned_at: number;
    }>;

    const assignments = rows.map((r) => ({
      agentId: r.agent_id,
      taskId: r.task_id,
      assignedAt: r.assigned_at,
    }));

    return { assignments, count: assignments.length };
  } catch {
    return { assignments: [], count: 0 };
  }
}

/** Query dispatch_queue status for the Command Center queue card. */
export function queryQueueStatus(projectId: string) {
  const db = getDb(projectId);

  try {
    // Count by status
    const statusRows = db.prepare(
      "SELECT status, COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? GROUP BY status",
    ).all(projectId) as Array<{ status: string; cnt: number }>;

    const counts: Record<string, number> = {};
    for (const r of statusRows) counts[r.status] = r.cnt;

    const queued = counts["queued"] ?? 0;
    const leased = (counts["leased"] ?? 0) + (counts["dispatched"] ?? 0);
    const completed = counts["completed"] ?? 0;
    const failed = counts["failed"] ?? 0;
    const cancelled = counts["cancelled"] ?? 0;

    // Concurrency: active = leased+dispatched, max from config
    const activeRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? AND status IN ('leased', 'dispatched')",
    ).get(projectId) as { cnt: number } | undefined;
    const active = activeRow?.cnt ?? 0;

    // Get max concurrency from project config (null = unlimited)
    let maxConcurrency: number | null = null;
    try {
      const extConfig = getExtendedProjectConfig(projectId);
      maxConcurrency = extConfig?.dispatch?.maxConcurrentDispatches ?? null;
    } catch {
      // Config not available — leave as null (unlimited)
    }

    // Recent items (last 20, all statuses, newest first)
    const recentRows = db.prepare(
      `SELECT id, task_id, status, last_error, created_at
       FROM dispatch_queue WHERE project_id = ?
       ORDER BY created_at DESC LIMIT 20`,
    ).all(projectId) as Array<{
      id: string;
      task_id: string;
      status: string;
      last_error: string | null;
      created_at: number;
    }>;

    const recentItems = recentRows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      status: r.status,
      lastError: r.last_error ?? undefined,
      createdAt: r.created_at,
    }));

    return {
      queued,
      leased,
      completed,
      failed,
      cancelled,
      concurrency: { active, max: maxConcurrency },
      recentItems,
      missingEndpoint: false,
    };
  } catch {
    return {
      queued: 0,
      leased: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      concurrency: { active: 0, max: null },
      recentItems: [],
      missingEndpoint: false,
    };
  }
}

/** Query knowledge base entries. */
export function queryKnowledge(projectId: string, pagination?: PaginationParams) {
  const limit = pagination?.limit ?? 100;
  const offset = pagination?.offset ?? 0;
  const db = getDb(projectId);

  try {
    const countRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM knowledge WHERE project_id = ?",
    ).get(projectId) as { cnt: number } | undefined;
    const total = countRow?.cnt ?? 0;

    const rows = db.prepare(
      "SELECT id, category, title, content, tags, source_agent, source_session, source_task, created_at FROM knowledge WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    ).all(projectId, limit, offset) as Array<{
      id: string;
      category: string;
      title: string;
      content: string;
      tags: string | null;
      source_agent: string | null;
      source_session: string | null;
      source_task: string | null;
      created_at: number;
    }>;

    const knowledge = rows.map((r) => {
      let tags: string[] = [];
      if (r.tags) {
        try { tags = JSON.parse(r.tags); } catch { tags = r.tags.split(",").map((t: string) => t.trim()).filter(Boolean); }
      }
      return {
        id: r.id,
        category: r.category,
        title: r.title,
        content: r.content,
        tags,
        source: r.source_agent ?? r.source_session ?? r.source_task ?? undefined,
        createdAt: r.created_at,
      };
    });

    return { knowledge, count: knowledge.length, total };
  } catch {
    return { knowledge: [], count: 0, total: 0 };
  }
}

/** Query knowledge flags. */
export function queryKnowledgeFlags(projectId: string, pagination?: PaginationParams) {
  const limit = pagination?.limit ?? 100;
  const offset = pagination?.offset ?? 0;
  const db = getDb(projectId);

  try {
    const countRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM knowledge_flags WHERE project_id = ?",
    ).get(projectId) as { cnt: number } | undefined;
    const total = countRow?.cnt ?? 0;

    const rows = db.prepare(
      "SELECT id, agent_id, source_type, source_ref, flagged_content, correction, severity, status, created_at, resolved_at FROM knowledge_flags WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    ).all(projectId, limit, offset) as Array<{
      id: string;
      agent_id: string;
      source_type: string;
      source_ref: string;
      flagged_content: string;
      correction: string;
      severity: string;
      status: string;
      created_at: number;
      resolved_at: number | null;
    }>;

    const flags = rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      severity: r.severity,
      category: r.source_type,
      tags: [] as string[],
      flaggedContent: r.flagged_content,
      correction: r.correction,
      status: r.status,
      source: r.source_ref,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at ?? undefined,
    }));

    return { flags, count: flags.length, total };
  } catch {
    return { flags: [], count: 0, total: 0 };
  }
}

/** Query promotion candidates. */
export function queryPromotionCandidates(projectId: string, pagination?: PaginationParams) {
  const limit = pagination?.limit ?? 100;
  const offset = pagination?.offset ?? 0;
  const db = getDb(projectId);

  try {
    const countRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM promotion_candidates WHERE project_id = ?",
    ).get(projectId) as { cnt: number } | undefined;
    const total = countRow?.cnt ?? 0;

    const rows = db.prepare(
      "SELECT id, content_snippet, retrieval_count, session_count, suggested_target, target_agent_id, status, created_at, reviewed_at FROM promotion_candidates WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    ).all(projectId, limit, offset) as Array<{
      id: string;
      content_snippet: string;
      retrieval_count: number;
      session_count: number;
      suggested_target: string;
      target_agent_id: string | null;
      status: string;
      created_at: number;
      reviewed_at: number | null;
    }>;

    const candidates = rows.map((r) => ({
      id: r.id,
      content: r.content_snippet,
      tags: [] as string[],
      source: r.suggested_target,
      status: r.status,
      retrievalCount: r.retrieval_count,
      sessionCount: r.session_count,
      targetAgentId: r.target_agent_id ?? undefined,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at ?? undefined,
    }));

    return { candidates, count: candidates.length, total };
  } catch {
    return { candidates: [], count: 0, total: 0 };
  }
}

// --- Intervention Suggestions ---

export type InterventionSuggestion = {
  id: string;
  agentId: string;
  issueType: "idle" | "failure";
  description: string;
  assignedTaskCount: number;
  /** Milliseconds since last completion or failure window start. */
  timeIdleMs: number;
  dismissKey: string;
};

export type InterventionListResponse = {
  suggestions: InterventionSuggestion[];
  count: number;
};

/** Query intervention suggestions — idle agents and agents with repeated failures. */
export function queryInterventions(projectId: string): InterventionListResponse {
  const db = getDb(projectId);
  const suggestions: InterventionSuggestion[] = [];

  try {
    // Load dismissed interventions
    const dismissedRow = db.prepare(
      `SELECT value FROM onboarding_state WHERE project_id = ? AND key = 'dismissed_interventions'`,
    ).get(projectId) as { value: string } | undefined;
    const dismissed = new Set<string>(
      dismissedRow ? JSON.parse(dismissedRow.value) : [],
    );

    // Get all agent IDs for this project
    const allAgentIds = getRegisteredAgentIds();
    const agentIds = allAgentIds.filter((aid) => {
      const entry = getAgentConfig(aid);
      return entry?.projectId === projectId;
    });

    const now = Date.now();
    const fortyEightHoursAgo = now - 48 * 3600 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;

    for (const agentId of agentIds) {
      // Pattern 1: Idle agent — no task completions in 48h but has assigned tasks
      const idleKey = `idle:${agentId}`;
      if (!dismissed.has(idleKey)) {
        const recent = db.prepare(`
          SELECT COUNT(*) as count FROM tasks
          WHERE project_id = ? AND assigned_to = ? AND state = 'DONE'
            AND updated_at >= ?
        `).get(projectId, agentId, fortyEightHoursAgo) as { count: number };

        const assigned = db.prepare(`
          SELECT COUNT(*) as count FROM tasks
          WHERE project_id = ? AND assigned_to = ? AND state IN ('ASSIGNED', 'IN_PROGRESS')
        `).get(projectId, agentId) as { count: number };

        if (recent.count === 0 && assigned.count > 0) {
          // Find last completion time for idle duration
          const lastDone = db.prepare(`
            SELECT MAX(updated_at) as last_done FROM tasks
            WHERE project_id = ? AND assigned_to = ? AND state = 'DONE'
          `).get(projectId, agentId) as { last_done: number | null };

          suggestions.push({
            id: idleKey,
            agentId,
            issueType: "idle",
            description: `Has ${assigned.count} assigned task(s) but no completions in 48h`,
            assignedTaskCount: assigned.count,
            timeIdleMs: lastDone?.last_done ? now - lastDone.last_done : now - fortyEightHoursAgo,
            dismissKey: idleKey,
          });
        }
      }

      // Pattern 2: Repeated failure — 3+ failures in 7 days
      const failKey = `failure:${agentId}`;
      if (!dismissed.has(failKey)) {
        const failures = db.prepare(`
          SELECT COUNT(*) as count FROM audit_runs
          WHERE project_id = ? AND agent_id = ? AND status = 'failed'
            AND ended_at >= ?
        `).get(projectId, agentId, sevenDaysAgo) as { count: number };

        if (failures.count >= 3) {
          const assignedCount = db.prepare(`
            SELECT COUNT(*) as count FROM tasks
            WHERE project_id = ? AND assigned_to = ? AND state IN ('ASSIGNED', 'IN_PROGRESS')
          `).get(projectId, agentId) as { count: number };

          suggestions.push({
            id: failKey,
            agentId,
            issueType: "failure",
            description: `${failures.count} task failures in the past 7 days`,
            assignedTaskCount: assignedCount.count,
            timeIdleMs: 7 * 24 * 3600 * 1000,
            dismissKey: failKey,
          });
        }
      }
    }

    return { suggestions, count: suggestions.length };
  } catch {
    return { suggestions: [], count: 0 };
  }
}

// --- Missing backend endpoints (unblocks dashboard 404s) ---

/** Query tool call details with optional filters. */
export function queryToolCalls(
  projectId: string,
  filters?: { agentId?: string; sessionKey?: string; limit?: number },
) {
  const db = getDb(projectId);
  const limit = filters?.limit ?? 100;

  let sql = "SELECT * FROM tool_call_details WHERE project_id = ?";
  const params: (string | number)[] = [projectId];

  if (filters?.agentId) {
    sql += " AND agent_id = ?";
    params.push(filters.agentId);
  }
  if (filters?.sessionKey) {
    sql += " AND session_key = ?";
    params.push(filters.sessionKey);
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit + 1);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  const hasMore = rows.length > limit;

  return {
    toolCalls: rows.slice(0, limit).map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      sessionKey: r.session_key,
      toolName: r.tool_name,
      action: r.action,
      inputPreview: typeof r.input === "string" ? r.input.slice(0, 200) : null,
      outputPreview: typeof r.output === "string" ? r.output.slice(0, 200) : null,
      durationMs: r.duration_ms,
      createdAt: r.created_at,
    })),
    count: rows.length > limit ? limit : rows.length,
    hasMore,
  };
}

/** Query config version history. */
export function queryConfigVersions(projectId: string, limit = 50) {
  const db = getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM config_versions WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
  ).all(projectId, limit) as Record<string, unknown>[];

  return {
    versions: rows.map((r) => ({
      id: r.id,
      hash: r.hash,
      source: r.source,
      agentId: r.agent_id,
      diff: r.diff,
      createdAt: r.created_at,
    })),
    count: rows.length,
  };
}

/** Query manager reviews with optional task filter. */
export function queryManagerReviews(projectId: string, taskId?: string, limit = 50) {
  const db = getDb(projectId);
  let sql = "SELECT * FROM manager_reviews WHERE project_id = ?";
  const params: (string | number)[] = [projectId];

  if (taskId) {
    sql += " AND task_id = ?";
    params.push(taskId);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  return {
    reviews: rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      reviewerAgentId: r.reviewer_agent_id,
      sessionKey: r.session_key,
      verdict: r.verdict,
      reasoning: r.reasoning,
      createdAt: r.created_at,
    })),
    count: rows.length,
  };
}

/** Query trust decisions. */
export function queryTrustDecisions(projectId: string, agentId?: string, limit = 50) {
  const db = getDb(projectId);
  let sql = "SELECT * FROM trust_decisions WHERE project_id = ?";
  const params: (string | number)[] = [projectId];

  if (agentId) {
    sql += " AND agent_id = ?";
    params.push(agentId);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  return {
    decisions: rows.map((r) => ({
      id: r.id,
      category: r.category,
      decision: r.decision,
      agentId: r.agent_id,
      toolName: r.tool_name,
      riskTier: r.risk_tier,
      severity: r.severity,
      createdAt: r.created_at,
    })),
    count: rows.length,
  };
}

/** Query policy violations. */
export function queryPolicyViolations(projectId: string, limit = 50) {
  const db = getDb(projectId);
  try {
    const rows = db.prepare(
      "SELECT * FROM policy_violations WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(projectId, limit) as Record<string, unknown>[];

    return {
      violations: rows.map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        policyName: r.policy_name,
        action: r.action,
        detail: r.detail,
        createdAt: r.created_at,
      })),
      count: rows.length,
    };
  } catch {
    return { violations: [], count: 0 };
  }
}

// ─── Work Streams ─────────────────────────────────────────────────────────────

export type WorkStreamTask = {
  id: string;
  title: string;
  state: string;
  priority: string;
  kind?: string;
  origin?: string;
  originId?: string;
  goalId?: string;
  createdAt: number;
  updatedAt: number;
};

export type WorkStream = {
  leadId: string;
  leadTitle?: string;
  department?: string;
  team?: string;
  activeGoals: Array<{ id: string; title: string; status: string; progress?: number }>;
  executing: WorkStreamTask[];
  queued: WorkStreamTask[];
  proposed: Array<{ id: string; title: string; origin: string; reasoning?: string; createdAt: number }>;
  completed: WorkStreamTask[];
  totalCostCents: number;
  tasksByOrigin: { user_request: number; lead_proposal: number; reactive: number; unknown: number };
};

export type WorkStreamResponse = {
  workStreams: WorkStream[];
  count: number;
};

/** Query work streams — per-lead grouped data showing active goals, tasks by state, cost. */
export function queryWorkStreams(projectId: string, leadId?: string): WorkStreamResponse {
  const allAgentIds = getRegisteredAgentIds();

  // Find leads — agents with coordination.enabled or extends containing "lead"
  const leadIds = allAgentIds.filter((aid) => {
    const entry = getAgentConfig(aid);
    if (!entry || entry.projectId !== projectId) return false;
    if (leadId && aid !== leadId) return false;
    // A lead has coordination enabled, or their role extends "lead"
    return entry.config.coordination?.enabled || entry.config.extends?.includes("lead");
  });

  const db = getDb(projectId);
  const workStreams: WorkStream[] = [];

  for (const lid of leadIds) {
    const entry = getAgentConfig(lid)!;
    const dept = entry.config.department;
    const team = entry.config.team;

    // Get direct reports for this lead
    const reports = getDirectReports(projectId, lid);
    const managedAgentIds = [lid, ...reports];
    const placeholders = managedAgentIds.map(() => "?").join(", ");

    // Active goals owned by this lead
    let activeGoals: WorkStream["activeGoals"] = [];
    try {
      const goals = listGoals(projectId, { ownerAgentId: lid, status: "active" as GoalStatus, limit: 20 });
      activeGoals = goals.map((g) => {
        let progress: number | undefined;
        try { progress = computeGoalProgress(projectId, g.id)?.progressPct; } catch { /* ignore */ }
        return { id: g.id, title: g.title, status: g.status, progress };
      });
    } catch { /* ignore */ }

    // Tasks by state for all managed agents
    let executing: WorkStreamTask[] = [];
    let queued: WorkStreamTask[] = [];
    let completed: WorkStreamTask[] = [];
    try {
      const taskRows = db.prepare(
        `SELECT id, title, state, priority, kind, origin, origin_id, goal_id, created_at, updated_at
         FROM tasks WHERE project_id = ? AND (assigned_to IN (${placeholders}) OR created_by IN (${placeholders}))
         AND state != 'CANCELLED'
         ORDER BY updated_at DESC LIMIT 200`,
      ).all(projectId, ...managedAgentIds, ...managedAgentIds) as Record<string, unknown>[];

      for (const r of taskRows) {
        const t: WorkStreamTask = {
          id: r.id as string,
          title: r.title as string,
          state: r.state as string,
          priority: r.priority as string,
          kind: (r.kind as string) ?? undefined,
          origin: (r.origin as string) ?? undefined,
          originId: (r.origin_id as string) ?? undefined,
          goalId: (r.goal_id as string) ?? undefined,
          createdAt: r.created_at as number,
          updatedAt: r.updated_at as number,
        };
        switch (r.state) {
          case "ASSIGNED":
          case "IN_PROGRESS":
          case "REVIEW":
            executing.push(t);
            break;
          case "OPEN":
          case "BLOCKED":
            queued.push(t);
            break;
          case "DONE":
            completed.push(t);
            break;
        }
      }
    } catch { /* ignore */ }

    // Pending proposals from this lead
    let proposed: WorkStream["proposed"] = [];
    try {
      const rows = db.prepare(
        "SELECT id, title, origin, reasoning, created_at FROM proposals WHERE project_id = ? AND proposed_by = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 20",
      ).all(projectId, lid) as Record<string, unknown>[];
      proposed = rows.map((r) => ({
        id: r.id as string,
        title: r.title as string,
        origin: (r.origin as string) ?? "risk_gate",
        reasoning: (r.reasoning as string) ?? undefined,
        createdAt: r.created_at as number,
      }));
    } catch { /* ignore */ }

    // Cost for this work stream
    let totalCostCents = 0;
    try {
      const costRow = db.prepare(
        `SELECT COALESCE(SUM(cost_cents), 0) as total FROM cost_records WHERE project_id = ? AND agent_id IN (${placeholders})`,
      ).get(projectId, ...managedAgentIds) as { total: number } | undefined;
      totalCostCents = costRow?.total ?? 0;
    } catch { /* ignore */ }

    // Count tasks by origin
    const tasksByOrigin = { user_request: 0, lead_proposal: 0, reactive: 0, unknown: 0 };
    for (const t of [...executing, ...queued, ...completed]) {
      const o = t.origin as keyof typeof tasksByOrigin;
      if (o && o in tasksByOrigin) {
        tasksByOrigin[o]++;
      } else {
        tasksByOrigin.unknown++;
      }
    }

    workStreams.push({
      leadId: lid,
      leadTitle: entry.config.title,
      department: dept,
      team,
      activeGoals,
      executing,
      queued,
      proposed,
      completed: completed.slice(0, 20), // limit completed to recent
      totalCostCents,
      tasksByOrigin,
    });
  }

  return { workStreams, count: workStreams.length };
}

// ─── User Inbox (messaging between dashboard user and agents) ─────────────────

export type UserInboxMessage = {
  id: string;
  fromAgent: string;
  toAgent: string;
  content: string;
  createdAt: number;
  status: string;
  parentMessageId?: string;
  proposalId?: string;
};

export type UserInboxResponse = {
  messages: UserInboxMessage[];
  count: number;
};

/** Query messages to/from the "user" pseudo-agent for dashboard messaging. */
export function queryUserInbox(
  projectId: string,
  filters?: { agentId?: string; limit?: number; since?: number },
): UserInboxResponse {
  const db = getDb(projectId);
  const limit = filters?.limit ?? 50;

  try {
    let sql = `SELECT id, from_agent, to_agent, content, created_at, status, parent_message_id, metadata
               FROM messages
               WHERE project_id = ? AND (from_agent = 'user' OR to_agent = 'user')`;
    const params: (string | number)[] = [projectId];

    if (filters?.agentId) {
      sql += " AND (from_agent = ? OR to_agent = ?)";
      params.push(filters.agentId, filters.agentId);
    }
    if (filters?.since) {
      sql += " AND created_at > ?";
      params.push(filters.since);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

    const messages: UserInboxMessage[] = rows.map((r) => {
      let proposalId: string | undefined;
      if (r.metadata) {
        try {
          const meta = JSON.parse(r.metadata as string);
          proposalId = meta.proposalId;
        } catch { /* ignore */ }
      }
      return {
        id: r.id as string,
        fromAgent: r.from_agent as string,
        toAgent: r.to_agent as string,
        content: r.content as string,
        createdAt: r.created_at as number,
        status: r.status as string,
        parentMessageId: (r.parent_message_id as string) ?? undefined,
        proposalId,
      };
    });

    return { messages, count: messages.length };
  } catch {
    return { messages: [], count: 0 };
  }
}

/** Query operational metrics (saturation, throughput, wait time, cycle time, etc.). */
export function queryOperationalMetrics(
  projectId: string,
  params?: { windowHours?: number },
): OperationalMetrics {
  const windowHours = params?.windowHours ?? 24;
  return getAllOperationalMetrics(projectId, windowHours);
}
