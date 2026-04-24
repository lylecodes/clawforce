/**
 * Clawforce — Dashboard query layer
 *
 * Thin wrappers around existing data functions with pagination and response shaping.
 * Reuses existing core functions — no direct DB access.
 */

import path from "node:path";
import {
  getAgentRuntimeConfig,
  normalizeConfiguredAgentRuntime,
} from "../agent-runtime-config.js";
import { getActiveProjectIds } from "../lifecycle.js";
import { getAgentConfig, getRegisteredAgentIds, getExtendedProjectConfig, parseWorkforceConfigContent } from "../project.js";
import { listTasks, getTask, getTaskEvidence, getTaskTransitions } from "../tasks/ops.js";
import {
  getChildEntities,
  getEntity,
  getEntityIssue,
  getEntityTransitions,
  listEntities,
  listEntityIssues,
  summarizeEntityIssues,
} from "../entities/ops.js";
import { listEntityCheckRuns } from "../entities/checks.js";
import {
  listSessionArchives,
  getSessionArchive,
  countSessionArchives,
  extractSessionArchiveDiagnostics,
} from "../telemetry/session-archive.js";
import { queryMetrics, aggregateMetrics } from "../metrics.js";
import { getCostSummary } from "../cost.js";
import { listEvents, countEvents } from "../events/store.js";
import { searchMessages } from "../messaging/store.js";
import { getActiveProtocols } from "../messaging/protocols.js";
import type { AgentConfig, MessageType, MessageStatus, ProtocolStatus, GoalStatus, TaskOrigin } from "../types.js";
import { listGoals, getGoal, getChildGoals, getGoalTasks } from "../goals/ops.js";
import { computeGoalProgress } from "../goals/cascade.js";
import { getDirectReports, getDepartmentAgents } from "../org.js";
import { listDisabledAgents, isDomainDisabled } from "../enforcement/disabled-store.js";
import { getActiveSessions, getSessionHeartbeatStatus } from "../enforcement/tracker.js";
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
import type { DatabaseSync } from "../sqlite-driver.js";
import { getAllOperationalMetrics } from "../metrics/operational.js";
import type { OperationalMetrics } from "../metrics/operational.js";
import { listActionRecords } from "./action-status.js";
import type { ActionStatus } from "./action-status.js";
import {
  readDomainConfig as readDomainConfigViaService,
  readGlobalConfig as readGlobalConfigViaService,
} from "../config/api-service.js";
import type {
  ConfigQueryResult,
  OperatorCommsResponse,
  OperatorCommsThread,
  SetupContextReference,
  SetupExperienceResponse,
  SetupOperatorAction,
  SetupTopologyAgent,
} from "../api/contract.js";
import { listLocks } from "../locks/store.js";
import {
  queryDomainAlerts,
  queryDomainHealth,
  queryDomainSlos,
} from "../app/queries/domain-monitoring.js";
import { buildSetupExplanation, buildSetupReport } from "../setup/report.js";
import { buildSetupPreflight, type SetupPreflightScenario } from "../setup/preflight.js";
import { getClawforceHome } from "../paths.js";
import { assessAgentRuntimeScope } from "../dispatch/runtime-scope.js";
import { queryDashboardAssistantStatus } from "../app/queries/dashboard-assistant.js";
import { normalizeExecutionConfig } from "../execution/config.js";
import { getSimulatedActionStats } from "../execution/simulated-actions.js";
import { getDomainRuntimeReloadStatus } from "../config/init.js";
import { getConfigHistory } from "../telemetry/config-tracker.js";
export {
  ContextFileError,
  readContextFile,
  writeContextFile,
} from "../app/queries/context-files.js";

export type PaginationParams = {
  limit?: number;
  offset?: number;
};

function buildBudgetWindowConfig(
  budgetRow: Record<string, unknown>,
  window: "hourly" | "daily" | "monthly",
): { cents?: number; tokens?: number; requests?: number } | undefined {
  const cents = typeof budgetRow[`${window}_limit_cents`] === "number"
    ? budgetRow[`${window}_limit_cents`] as number
    : undefined;
  const tokens = typeof budgetRow[`${window}_limit_tokens`] === "number"
    ? budgetRow[`${window}_limit_tokens`] as number
    : undefined;
  const requests = typeof budgetRow[`${window}_limit_requests`] === "number"
    ? budgetRow[`${window}_limit_requests`] as number
    : undefined;

  if (cents === undefined && tokens === undefined && requests === undefined) {
    return undefined;
  }

  return {
    ...(cents !== undefined ? { cents } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(requests !== undefined ? { requests } : {}),
  };
}

function renderDashboardBriefingLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const source = typeof (value as Record<string, unknown>).source === "string"
    ? (value as Record<string, unknown>).source as string
    : "";
  if (!source) return "";
  if (source === "file" && typeof (value as Record<string, unknown>).path === "string") {
    const filePath = ((value as Record<string, unknown>).path as string).trim();
    if (filePath) return `file: ${filePath}`;
  }
  if (source === "custom_stream" && typeof (value as Record<string, unknown>).streamName === "string") {
    const streamName = ((value as Record<string, unknown>).streamName as string).trim();
    if (streamName) return `custom_stream: ${streamName}`;
  }
  return source;
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
    entityType?: string;
    entityId?: string;
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
    entityType: filters?.entityType,
    entityId: filters?.entityId,
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
export function queryTaskDetail(projectId: string, taskId: string, dbOverride?: DatabaseSync) {
  const task = getTask(projectId, taskId, dbOverride);
  if (!task) return null;

  const evidence = getTaskEvidence(projectId, taskId, dbOverride);
  const transitions = getTaskTransitions(projectId, taskId, dbOverride);
  const reviews = queryManagerReviews(projectId, taskId, 20, dbOverride).reviews;
  const activeSessions = queryTaskActiveSessions(projectId, taskId, dbOverride);
  const recentSessions = listSessionArchives(projectId, { taskId, limit: 5 }, dbOverride)
    .map((session) => ({
      ...session,
      diagnostics: extractSessionArchiveDiagnostics(session),
    }));
  const linkedIssue = task.origin === "reactive" && task.originId
    ? getEntityIssue(projectId, task.originId, dbOverride)
    : null;
  let entityIssueSummary = null;
  if (task.entityId) {
    try {
      entityIssueSummary = summarizeEntityIssues(projectId, task.entityId, dbOverride);
    } catch {
      entityIssueSummary = null;
    }
  }

  return {
    task,
    evidence,
    transitions,
    reviews,
    activeSessions,
    recentSessions,
    linkedIssue,
    entityIssueSummary,
  };
}

function queryTaskActiveSessions(projectId: string, taskId: string, dbOverride?: DatabaseSync) {
  const db = dbOverride ?? getDb(projectId);
  try {
    const rows = db.prepare(
      "SELECT session_key, agent_id, started_at, tool_call_count, last_persisted_at, dispatch_context FROM tracked_sessions WHERE project_id = ? ORDER BY started_at DESC",
    ).all(projectId) as Array<{
      session_key: string;
      agent_id: string;
      started_at: number;
      tool_call_count: number;
      last_persisted_at: number;
      dispatch_context?: string | null;
    }>;

    return rows.flatMap((row) => {
      if (!row.dispatch_context) return [];
      try {
        const dispatchContext = JSON.parse(row.dispatch_context) as { taskId?: string };
        if (dispatchContext.taskId !== taskId) return [];
        const heartbeat = getSessionHeartbeatStatus(row.last_persisted_at);
        if (heartbeat.state === "stale") return [];
        return [{
          sessionKey: row.session_key,
          agentId: row.agent_id,
          startedAt: row.started_at,
          toolCallCount: row.tool_call_count,
          lastPersistedAt: row.last_persisted_at,
          heartbeatState: heartbeat.state,
          heartbeatAgeMs: heartbeat.ageMs,
        }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/** List entities with optional filters. */
export function queryEntities(
  projectId: string,
  filters?: {
    kind?: string;
    state?: string;
    health?: string;
    ownerAgentId?: string;
    parentEntityId?: string | null;
    department?: string;
    team?: string;
  },
  pagination?: PaginationParams,
) {
  const limit = pagination?.limit ?? 50;
  const entities = listEntities(projectId, {
    kind: filters?.kind,
    state: filters?.state,
    health: filters?.health,
    ownerAgentId: filters?.ownerAgentId,
    parentEntityId: filters?.parentEntityId,
    department: filters?.department,
    team: filters?.team,
    limit: limit + 1,
  });
  const hasMore = entities.length > limit;
  return {
    entities: entities.slice(0, limit),
    hasMore,
    count: hasMore ? limit : entities.length,
  };
}

/** Get entity detail with child entities and transition history. */
export function queryEntityDetail(projectId: string, entityId: string) {
  const entity = getEntity(projectId, entityId);
  if (!entity) return null;

  const children = getChildEntities(projectId, entityId);
  const transitions = getEntityTransitions(projectId, entityId);
  const issues = listEntityIssues(projectId, { entityId, limit: 500 });
  const issueSummary = summarizeEntityIssues(projectId, entityId);
  const checkRuns = listEntityCheckRuns(projectId, entityId, 20);

  return { entity, children, transitions, issues, issueSummary, checkRuns };
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
  return queryDomainSlos(projectId);
}

/** Evaluate alert rules. Normalizes raw config keys. */
export function queryAlerts(projectId: string) {
  return queryDomainAlerts(projectId);
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
  return queryDomainHealth(projectId);
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
    entityType?: string;
    entityId?: string;
    limit?: number;
  },
  pagination?: PaginationParams,
) {
  const limit = pagination?.limit ?? filters?.limit ?? 50;
  const goals = listGoals(projectId, {
    status: filters?.status,
    ownerAgentId: filters?.ownerAgentId,
    parentGoalId: filters?.parentGoalId,
    entityType: filters?.entityType,
    entityId: filters?.entityId,
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
    entityType: (row.entity_type as string) ?? undefined,
    entityId: (row.entity_id as string) ?? undefined,
    executionStatus: (row.execution_status as string) ?? undefined,
    executionUpdatedAt: (row.execution_updated_at as number) ?? undefined,
    executionError: (row.execution_error as string) ?? undefined,
    executionTaskId: (row.execution_task_id as string) ?? undefined,
    executionRequiredGeneration: (row.execution_required_generation as string) ?? undefined,
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

/** Read current config for a project, shaped for the dashboard ConfigQueryResult type. */
export function queryConfig(projectId: string): ConfigQueryResult {
  const extConfig = getExtendedProjectConfig(projectId);
  const rawDomainConfig = readDomainConfigViaService(projectId);
  const rawGlobalConfig = readGlobalConfigViaService();
  const normalizedGlobalAgents = (() => {
    try {
      return parseWorkforceConfigContent(JSON.stringify({
        name: "dashboard-query",
        adapter: (rawGlobalConfig as Record<string, unknown>).adapter,
        codex: (rawGlobalConfig as Record<string, unknown>).codex,
        claude_code: (rawGlobalConfig as Record<string, unknown>).claude_code,
        agents: rawGlobalConfig.agents ?? {},
      })).agents;
    } catch {
      return {} as Record<string, AgentConfig>;
    }
  })();
  const configuredAgentIds = new Set<string>();
  const domainAgents = Array.isArray(rawDomainConfig?.agents)
    ? rawDomainConfig.agents.filter((agentId): agentId is string => typeof agentId === "string" && agentId.trim().length > 0)
    : [];
  for (const agentId of domainAgents) {
    configuredAgentIds.add(agentId);
  }
  const managerAgentId = rawDomainConfig?.manager?.enabled !== false
    && typeof rawDomainConfig?.manager?.agentId === "string"
    && rawDomainConfig.manager.agentId.trim().length > 0
    ? rawDomainConfig.manager.agentId.trim()
    : null;
  if (managerAgentId) {
    configuredAgentIds.add(managerAgentId);
  }
  const domainManagerOverrides = rawDomainConfig?.manager_overrides
    && typeof rawDomainConfig.manager_overrides === "object"
    && !Array.isArray(rawDomainConfig.manager_overrides)
    ? rawDomainConfig.manager_overrides as Record<string, Record<string, unknown>>
    : {};

  // Build agents list from disk first, supplementing with the live registry when available.
  const registeredAgentIds = getRegisteredAgentIds();
  const projectAgentIds = registeredAgentIds.filter((aid) => {
    const entry = getAgentConfig(aid, projectId) ?? getAgentConfig(aid);
    return entry?.projectId === projectId;
  });
  for (const agentId of projectAgentIds) {
    configuredAgentIds.add(agentId);
  }

  const agents = [...configuredAgentIds]
    .sort((left, right) => left.localeCompare(right))
    .map((aid) => {
      const entry = getAgentConfig(aid, projectId) ?? getAgentConfig(aid);
      const normalizedGlobalAgent = normalizedGlobalAgents[aid] ?? null;
      const rawGlobalAgent = rawGlobalConfig.agents?.[aid] as Record<string, unknown> | undefined;
      const overrideAgent = domainManagerOverrides[aid];
      const fallbackAgent = {
        ...(normalizedGlobalAgent ?? {}),
        ...(rawGlobalAgent ?? {}),
        ...(overrideAgent ?? {}),
      } as Record<string, unknown>;
      const fallbackRuntime = normalizeConfiguredAgentRuntime(fallbackAgent);
      const effectiveRuntime = getAgentRuntimeConfig(entry?.config) ?? fallbackRuntime;
      const fallbackRuntimeRef = typeof (fallbackAgent.runtimeRef ?? fallbackAgent.runtime_ref) === "string"
        ? String(fallbackAgent.runtimeRef ?? fallbackAgent.runtime_ref).trim()
        : undefined;

      return {
        id: aid,
        extends: entry?.config.extends ?? (typeof fallbackAgent.extends === "string" ? fallbackAgent.extends : undefined),
        title: entry?.config.title ?? (typeof fallbackAgent.title === "string" ? fallbackAgent.title : undefined),
        persona: entry?.config.persona ?? (typeof fallbackAgent.persona === "string" ? fallbackAgent.persona : undefined),
        reports_to: entry?.config.reports_to ?? (typeof fallbackAgent.reports_to === "string" ? fallbackAgent.reports_to : undefined),
        department: entry?.config.department ?? (typeof fallbackAgent.department === "string" ? fallbackAgent.department : undefined),
        team: entry?.config.team ?? (typeof fallbackAgent.team === "string" ? fallbackAgent.team : undefined),
        channel: entry?.config.channel ?? (typeof fallbackAgent.channel === "string" ? fallbackAgent.channel : undefined),
        runtimeRef: entry?.config.runtimeRef ?? fallbackRuntimeRef,
        runtime: effectiveRuntime,
        allowedTools: effectiveRuntime?.allowedTools,
        workspacePaths: effectiveRuntime?.workspacePaths,
        // Preserve full briefing source objects so the SPA can edit and re-save without data loss.
        briefing: (entry?.config.briefing ?? fallbackAgent.briefing ?? []) as unknown[],
        // Preserve full expectation objects so the SPA can edit and re-save without data loss.
        expectations: (entry?.config.expectations ?? fallbackAgent.expectations ?? []) as unknown[],
        performance_policy: (entry?.config.performance_policy ?? fallbackAgent.performance_policy) as Record<string, unknown> | undefined,
      };
    });

  // Build budget from persisted runtime limits, falling back to budget window status.
  let budget: Record<string, unknown> = {};
  try {
    const db = getDb(projectId);
    const budgetRow = db.prepare(
      `SELECT
         hourly_limit_cents, hourly_limit_tokens, hourly_limit_requests,
         daily_limit_cents, daily_limit_tokens, daily_limit_requests,
         monthly_limit_cents, monthly_limit_tokens, monthly_limit_requests
       FROM budgets
       WHERE project_id = ? AND agent_id IS NULL`,
    ).get(projectId) as Record<string, unknown> | undefined;

    if (budgetRow) {
      budget = {
        daily: buildBudgetWindowConfig(budgetRow, "daily"),
        hourly: buildBudgetWindowConfig(budgetRow, "hourly"),
        monthly: buildBudgetWindowConfig(budgetRow, "monthly"),
      };
    }
  } catch { /* DB may not exist */ }

  if (Object.keys(budget).length === 0) {
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
  }

  // Build tool_gates array from extConfig.toolGates
  const toolGatesConfig = extConfig?.toolGates ?? {};
  const toolGates = Object.entries(toolGatesConfig).map(([tool, gate]) => ({
    tool,
    category: (gate as Record<string, unknown>)?.category as string | undefined,
    risk_tier: ((gate as Record<string, unknown>)?.tier ?? (gate as Record<string, unknown>)?.risk_tier ?? "low") as string,
  }));

  const safetyConfig = (extConfig?.safety ?? rawDomainConfig?.safety ?? {}) as Record<string, unknown>;
  const safety = {
    circuit_breaker_multiplier: (safetyConfig.costCircuitBreaker ?? safetyConfig.circuit_breaker_multiplier) as number | undefined,
    spawn_depth_limit: (safetyConfig.maxSpawnDepth ?? safetyConfig.spawn_depth_limit) as number | undefined,
    loop_detection_threshold: (safetyConfig.loopDetectionThreshold ?? safetyConfig.loop_detection_threshold) as number | undefined,
  };

  const initiatives = Object.entries((rawDomainConfig?.goals ?? {}) as Record<string, unknown>)
    .reduce<Record<string, { allocation_pct: number; goal?: string }>>((acc, [goalId, goalDef]) => {
      if (!goalDef || typeof goalDef !== "object") return acc;
      const allocation = (goalDef as Record<string, unknown>).allocation;
      if (typeof allocation !== "number") return acc;
      acc[goalId] = {
        allocation_pct: allocation,
        goal: goalId,
      };
      return acc;
    }, {});

  if (typeof rawDomainConfig?.operational_profile === "string") {
    budget.operational_profile = rawDomainConfig.operational_profile;
  }
  if (Object.keys(initiatives).length > 0) {
    budget.initiatives = Object.fromEntries(
      Object.entries(initiatives).map(([goalId, value]) => [goalId, value.allocation_pct]),
    );
  }

  const profile = rawDomainConfig?.operational_profile
    ? { operational_profile: rawDomainConfig.operational_profile }
    : {};

  const rules = Array.isArray(rawDomainConfig?.rules)
    ? rawDomainConfig.rules
    : [];

  const dashboardAssistantRaw = (rawDomainConfig?.dashboard_assistant && typeof rawDomainConfig.dashboard_assistant === "object")
    ? rawDomainConfig.dashboard_assistant as Record<string, unknown>
    : null;
  const dashboardAssistant = {
    enabled: dashboardAssistantRaw?.enabled !== false,
    ...(typeof dashboardAssistantRaw?.agentId === "string" && dashboardAssistantRaw.agentId.trim()
      ? { agentId: dashboardAssistantRaw.agentId.trim() }
      : {}),
    ...(typeof dashboardAssistantRaw?.model === "string" && dashboardAssistantRaw.model.trim()
      ? { model: dashboardAssistantRaw.model.trim() }
      : {}),
  };

  const memory = ((extConfig?.memory ?? rawDomainConfig?.memory) && typeof (extConfig?.memory ?? rawDomainConfig?.memory) === "object")
    ? (extConfig?.memory ?? rawDomainConfig?.memory) as Record<string, unknown>
    : {};
  const entities = (rawDomainConfig?.entities && typeof rawDomainConfig.entities === "object")
    ? rawDomainConfig.entities as Record<string, import("../types.js").EntityKindConfig>
    : {};
  const execution = ((rawDomainConfig?.execution ?? extConfig?.execution)
      && typeof (rawDomainConfig?.execution ?? extConfig?.execution) === "object")
    ? (rawDomainConfig?.execution ?? extConfig?.execution) as Record<string, unknown>
    : {};
  const eventHandlers = (rawDomainConfig?.event_handlers && typeof rawDomainConfig.event_handlers === "object")
    ? rawDomainConfig.event_handlers as Record<string, unknown>
    : {};
  const knowledge = (rawDomainConfig?.knowledge && typeof rawDomainConfig.knowledge === "object")
    ? rawDomainConfig.knowledge as Record<string, unknown>
    : {};
  const workflows = Array.isArray(rawDomainConfig?.workflows)
    ? rawDomainConfig.workflows
    : [];
  const defaults = (rawDomainConfig?.defaults && typeof rawDomainConfig.defaults === "object")
    ? rawDomainConfig.defaults as Record<string, unknown>
    : {};
  const roleDefaults = (rawDomainConfig?.role_defaults && typeof rawDomainConfig.role_defaults === "object")
    ? rawDomainConfig.role_defaults as Record<string, unknown>
    : {};
  const teamTemplates = (rawDomainConfig?.team_templates && typeof rawDomainConfig.team_templates === "object")
    ? rawDomainConfig.team_templates as Record<string, unknown>
    : {};

  const jobs = [...configuredAgentIds].flatMap((aid) => {
    const entry = getAgentConfig(aid, projectId) ?? getAgentConfig(aid);
    const rawGlobalAgent = rawGlobalConfig.agents?.[aid] as Record<string, unknown> | undefined;
    const rawJobs = (rawGlobalAgent?.jobs && typeof rawGlobalAgent.jobs === "object")
      ? rawGlobalAgent.jobs as Record<string, unknown>
      : undefined;
    const overrideJobs = (domainManagerOverrides[aid]?.jobs && typeof domainManagerOverrides[aid]?.jobs === "object")
      ? domainManagerOverrides[aid]?.jobs as Record<string, unknown>
      : undefined;
    const normalizedJobs = entry?.config.jobs ?? {};

    const jobNames = new Set<string>([
      ...Object.keys(rawJobs ?? {}),
      ...Object.keys(overrideJobs ?? {}),
      ...Object.keys(normalizedJobs),
    ]);

    return [...jobNames].map((jobName) => {
      const rawJob = rawJobs?.[jobName];
      const overrideJob = overrideJobs?.[jobName];
      const normalizedJob = normalizedJobs[jobName];
      const rawJobObj = (rawJob && typeof rawJob === "object") ? rawJob as Record<string, unknown> : undefined;
      const overrideJobObj = (overrideJob && typeof overrideJob === "object") ? overrideJob as Record<string, unknown> : undefined;
      return {
        id: `${aid}:${jobName}`,
        agent: aid,
        cron: typeof overrideJobObj?.cron === "string"
          ? overrideJobObj.cron
          : typeof rawJobObj?.cron === "string"
          ? rawJobObj.cron
          : normalizedJob?.cron ?? "",
        enabled: overrideJobObj?.enabled !== false && rawJobObj?.enabled !== false,
        description: typeof overrideJobObj?.description === "string"
          ? overrideJobObj.description
          : typeof rawJobObj?.description === "string"
            ? rawJobObj.description
            : undefined,
      };
    });
  });

  return {
    agents: agents as import("../api/contract.js").ConfigAgent[],
    budget: budget as import("../api/contract.js").ConfigBudgetSection,
    tool_gates: toolGates,
    initiatives,
    jobs,
    safety,
    profile,
    rules,
    defaults,
    role_defaults: roleDefaults,
    team_templates: teamTemplates,
    dashboard_assistant: dashboardAssistant,
    event_handlers: eventHandlers,
    workflows: workflows as string[],
    knowledge,
    memory,
    entities,
    execution,
  };
}

function classifySetupTopologyRole(agent: ConfigQueryResult["agents"][number], managerAgentId: string | null): SetupTopologyAgent["role"] {
  if (agent.id === managerAgentId) return "manager";
  if (agent.id.endsWith("-owner")) return "owner";
  return "specialist";
}

function toSetupTopologyAgent(
  agent: ConfigQueryResult["agents"][number],
  managerAgentId: string | null,
  projectId: string,
  activity: {
    jobCount: number;
    activeSessionCount: number;
    activeTaskCount: number;
  },
): SetupTopologyAgent {
  const runtime = agent.runtime ?? (
    agent.allowedTools || agent.workspacePaths
      ? {
        allowedTools: agent.allowedTools,
        workspacePaths: agent.workspacePaths,
      }
      : undefined
  );
  const runtimeScope = assessAgentRuntimeScope(projectId, agent.id, {
    extends: agent.extends ?? "employee",
    title: agent.title,
    department: agent.department,
    team: agent.team,
    reports_to: agent.reports_to ?? undefined,
    runtime,
  } as AgentConfig);
  return {
    id: agent.id,
    extends: agent.extends,
    title: agent.title,
    department: agent.department,
    team: agent.team,
    reports_to: agent.reports_to ?? null,
    jobCount: activity.jobCount,
    activeSessionCount: activity.activeSessionCount,
    activeTaskCount: activity.activeTaskCount,
    executor: runtimeScope.executor,
    enforcementGrade: runtimeScope.enforcementGrade,
    executorSuitability: runtimeScope.executorSuitability,
    runtime,
    allowedTools: runtime?.allowedTools,
    workspacePaths: runtime?.workspacePaths,
    role: classifySetupTopologyRole(agent, managerAgentId),
  };
}

function buildSetupContextRoute(
  section: string,
  params?: Record<string, string>,
): SetupContextReference["route"] {
  return {
    path: "/config",
    params: {
      section,
      ...(params ?? {}),
    },
  };
}

function buildDomainConfigPath(root: string, file?: string | null): string | undefined {
  if (!file || !file.trim()) return undefined;
  return path.resolve(root, file);
}

function dedupeSetupContextReferences(references: SetupContextReference[]): SetupContextReference[] {
  const seen = new Set<string>();
  const deduped: SetupContextReference[] = [];
  for (const reference of references) {
    if (seen.has(reference.id)) continue;
    seen.add(reference.id);
    deduped.push(reference);
  }
  return deduped;
}

function buildAgentSetupReference(
  domainId: string,
  filePath: string | undefined,
  agentId: string,
  label = agentId,
): SetupContextReference {
  return {
    id: `agent:${domainId}:${agentId}`,
    label,
    kind: "agent",
    domainId,
    filePath,
    configSection: "agents",
    configPath: `agents[${agentId}]`,
    agentId,
    route: buildSetupContextRoute("agents", { agentId }),
  };
}

function buildJobSetupReference(
  domainId: string,
  filePath: string | undefined,
  agentId: string,
  jobId: string,
  label = `${agentId}.${jobId}`,
): SetupContextReference {
  const compositeJobId = `${agentId}:${jobId}`;
  return {
    id: `job:${domainId}:${compositeJobId}`,
    label,
    kind: "job",
    domainId,
    filePath,
    configSection: "jobs",
    configPath: `jobs[${compositeJobId}]`,
    agentId,
    jobId: compositeJobId,
    route: buildSetupContextRoute("jobs", { jobId: compositeJobId }),
  };
}

function buildWorkflowSetupReference(
  domainId: string,
  filePath: string | undefined,
  workflowId: string,
): SetupContextReference {
  return {
    id: `workflow:${domainId}:${workflowId}`,
    label: workflowId,
    kind: "workflow",
    domainId,
    filePath,
    configSection: "workflows",
    configPath: `workflows[${workflowId}]`,
    route: buildSetupContextRoute("workflows", { workflowId }),
  };
}

function buildConfigSetupReference(args: {
  id: string;
  label: string;
  domainId?: string;
  filePath?: string;
  configSection?: string;
  configPath?: string;
  route?: SetupContextReference["route"];
}): SetupContextReference {
  return {
    id: args.id,
    label: args.label,
    kind: "config",
    domainId: args.domainId,
    filePath: args.filePath,
    configSection: args.configSection,
    configPath: args.configPath,
    route: args.route,
  };
}

function buildRuntimeSetupReference(args: {
  id: string;
  label: string;
  domainId?: string;
  filePath?: string;
  configPath?: string;
}): SetupContextReference {
  return {
    id: args.id,
    label: args.label,
    kind: "runtime",
    domainId: args.domainId,
    filePath: args.filePath,
    configPath: args.configPath,
  };
}

function buildSetupCheckContextReferences(args: {
  root: string;
  projectId: string;
  checkId: string;
  managerAgentId: string | null;
  domainSummary?: SetupExperienceResponse["report"]["domains"][number];
}): SetupContextReference[] {
  const { root, projectId, checkId, managerAgentId, domainSummary } = args;
  const domainId = domainSummary?.id ?? projectId;
  const filePath = buildDomainConfigPath(root, domainSummary?.file ?? null);

  if (checkId === `domain:${domainId}:agents`) {
    return [buildConfigSetupReference({
      id: `config:${domainId}:agents`,
      label: "agents",
      domainId,
      filePath,
      configSection: "agents",
      configPath: "agents",
      route: buildSetupContextRoute("agents"),
    })];
  }

  if (checkId === `domain:${domainId}:manager`) {
    return dedupeSetupContextReferences([
      buildConfigSetupReference({
        id: `config:${domainId}:manager`,
        label: "manager.agentId",
        domainId,
        filePath,
        configPath: "manager.agentId",
      }),
      ...(managerAgentId ? [buildAgentSetupReference(domainId, filePath, managerAgentId, `manager -> ${managerAgentId}`)] : []),
    ]);
  }

  if (checkId === `domain:${domainId}:paths`) {
    return [buildConfigSetupReference({
      id: `config:${domainId}:paths`,
      label: "paths",
      domainId,
      filePath,
      configPath: "paths",
    })];
  }

  const workflowMatch = checkId.match(/^domain:([^:]+):workflow:(.+)$/);
  if (workflowMatch) {
    const [, workflowDomainId, workflowId] = workflowMatch;
    const workflowFilePath = workflowDomainId === domainId ? filePath : undefined;
    return [buildWorkflowSetupReference(workflowDomainId, workflowFilePath, workflowId)];
  }

  if (checkId === `domain:${domainId}:controller`) {
    return [buildRuntimeSetupReference({
      id: `runtime:${domainId}:controller`,
      label: "controller lease",
      domainId,
      filePath,
      configPath: "runtime.controller",
    })];
  }

  const recurringMatch = checkId.match(/^domain:([^:]+):recurring:([^:]+):([^:]+):(orphaned|stalled|blocked)$/);
  if (recurringMatch) {
    const [, recurringDomainId, agentId, jobId] = recurringMatch;
    const recurringFilePath = recurringDomainId === domainId ? filePath : undefined;
    return dedupeSetupContextReferences([
      buildJobSetupReference(recurringDomainId, recurringFilePath, agentId, jobId),
      buildAgentSetupReference(recurringDomainId, recurringFilePath, agentId),
    ]);
  }

  if (checkId === `domain:${domainId}:validation`) {
    return [buildConfigSetupReference({
      id: `config:${domainId}:validation`,
      label: domainSummary?.file ?? `${domainId}.yaml`,
      domainId,
      filePath,
    })];
  }

  return [];
}

function buildSetupPreflightContextReferences(args: {
  root: string;
  projectId: string;
  scenario: SetupPreflightScenario;
  domainSummary?: SetupExperienceResponse["report"]["domains"][number];
}): SetupContextReference[] {
  const { root, projectId, scenario, domainSummary } = args;
  const domainId = domainSummary?.id ?? projectId;
  const filePath = buildDomainConfigPath(root, domainSummary?.file ?? null);

  if (scenario.category === "workflow") {
    return dedupeSetupContextReferences([
      ...(scenario.workflowId
        ? [buildWorkflowSetupReference(domainId, filePath, scenario.workflowId)]
        : []),
      ...(scenario.agentId && scenario.jobId
        ? [buildJobSetupReference(domainId, filePath, scenario.agentId, scenario.jobId)]
        : []),
      ...(scenario.agentId
        ? [buildAgentSetupReference(domainId, filePath, scenario.agentId)]
        : []),
    ]);
  }

  if (scenario.category === "issue" && scenario.entityKind) {
    return dedupeSetupContextReferences([
      buildConfigSetupReference({
        id: `config:${domainId}:entities:${scenario.entityKind}:state-signals`,
        label: `${scenario.entityKind}.issues.stateSignals`,
        domainId,
        filePath,
        configSection: "entities",
        configPath: `entities.${scenario.entityKind}.issues.stateSignals`,
      }),
      ...(scenario.issueType
        ? [buildConfigSetupReference({
          id: `config:${domainId}:entities:${scenario.entityKind}:issue-type:${scenario.issueType}`,
          label: `${scenario.entityKind}.issues.types.${scenario.issueType}`,
          domainId,
          filePath,
          configSection: "entities",
          configPath: `entities.${scenario.entityKind}.issues.types.${scenario.issueType}`,
        })]
        : []),
    ]);
  }

  if (scenario.category === "approval" && scenario.entityKind) {
    return [buildConfigSetupReference({
      id: `config:${domainId}:entities:${scenario.entityKind}:transitions`,
      label: `${scenario.entityKind}.transitions`,
      domainId,
      filePath,
      configSection: "entities",
      configPath: `entities.${scenario.entityKind}.transitions`,
    })];
  }

  if (scenario.category === "execution") {
    return [buildConfigSetupReference({
      id: `config:${domainId}:execution`,
      label: "execution",
      domainId,
      filePath,
      configSection: "execution",
      configPath: "execution",
      route: buildSetupContextRoute("execution"),
    })];
  }

  if (scenario.category === "mutation") {
    return dedupeSetupContextReferences([
      buildConfigSetupReference({
        id: `config:${domainId}:review:workflow-steward`,
        label: "review.workflowSteward",
        domainId,
        filePath,
        configSection: "review",
        configPath: "review.workflowSteward",
      }),
      ...(scenario.agentId
        ? [buildAgentSetupReference(domainId, filePath, scenario.agentId, `workflow steward -> ${scenario.agentId}`)]
        : []),
    ]);
  }

  return [];
}

function classifySetupRecoveryState(
  job: SetupExperienceResponse["report"]["domains"][number]["jobs"][number],
): "stalled" | "blocked" | "orphaned" | null {
  if (!job.activeTaskId) return null;
  if (job.activeTaskState === "BLOCKED") return "blocked";
  if ((job.activeQueueStatus === "leased" || job.activeQueueStatus === "dispatched") && job.activeSessionState === "stale") {
    return "stalled";
  }
  if (job.activeSessionState === "live" || job.activeSessionState === "quiet" || job.activeQueueStatus === "queued") {
    return null;
  }
  return "orphaned";
}

function buildSetupImmediateOperatorActions(args: {
  projectId: string;
  checkId: string;
  domainSummary?: SetupExperienceResponse["report"]["domains"][number];
}): SetupOperatorAction[] {
  const { projectId, checkId, domainSummary } = args;
  const domainId = domainSummary?.id ?? projectId;
  if (checkId === `domain:${domainId}:controller` || checkId === `domain:${domainId}:controller-config`) {
    return [{
      id: `setup-action:${domainId}:controller:handoff`,
      label: "Request controller handoff",
      description: "Mark this domain for takeover by the current controller generation so setup and recurring work can move again.",
      operation: { type: "request_controller_handoff" },
      tone: "primary",
    }];
  }

  const recurringMatch = checkId.match(/^domain:([^:]+):recurring:([^:]+):([^:]+):(orphaned|stalled|blocked)$/);
  if (!recurringMatch) return [];

  const [, recurringDomainId, agentId, jobId, state] = recurringMatch;
  const job = domainSummary?.jobs.find((entry) => entry.agentId === agentId && entry.jobId === jobId);
  if (!job?.activeTaskId) return [];

  const label = state === "stalled"
    ? "Recover stalled run"
    : state === "blocked"
      ? "Replay blocked run"
      : "Recover stranded run";
  const description = state === "stalled"
    ? "Release or replay the stale recurring dispatch, then request controller handoff so the next live controller can continue it."
    : state === "blocked"
      ? "Create a fresh recurring run and request controller handoff so the workflow can continue from a clean task."
      : "Recover the stranded recurring run and request controller handoff so the workflow can make progress again.";

  return [{
    id: `setup-action:${recurringDomainId}:${agentId}:${jobId}:recover`,
    label,
    description,
    operation: { type: "recover_recurring_run", taskId: job.activeTaskId },
    tone: "primary",
  }];
}

function buildSetupJobOperatorActions(
  domainId: string,
  job: SetupExperienceResponse["report"]["domains"][number]["jobs"][number],
): SetupOperatorAction[] {
  const recoveryState = classifySetupRecoveryState(job);
  if (!recoveryState || !job.activeTaskId) return [];

  const label = recoveryState === "stalled"
    ? "Recover stalled run"
    : recoveryState === "blocked"
      ? "Replay blocked run"
      : "Recover stranded run";
  const description = recoveryState === "stalled"
    ? "Release or replay this recurring dispatch and request controller handoff."
    : recoveryState === "blocked"
      ? "Replay this blocked recurring run with a fresh task and request controller handoff."
      : "Recover this recurring run with a fresh task or retry path and request controller handoff.";

  return [{
    id: `setup-job-action:${domainId}:${job.agentId}:${job.jobId}:recover`,
    label,
    description,
    operation: { type: "recover_recurring_run", taskId: job.activeTaskId },
    tone: "primary",
  }];
}

function safeDashboardQuery<T>(query: () => T, fallback: T): T {
  try {
    return query();
  } catch {
    return fallback;
  }
}

export function querySetupExperience(projectId: string): SetupExperienceResponse {
  const root = getClawforceHome();
  const report = buildSetupReport(root, projectId);
  const explanation = buildSetupExplanation(report);
  const config = queryConfig(projectId);
  const domainSummary = report.domains.find((domain) => domain.id === projectId);
  const managerAgentId = domainSummary?.managerAgentId ?? null;
  const normalizedExecution = normalizeExecutionConfig(config.execution) ?? { mode: "live" as const };
  const extConfig = getExtendedProjectConfig(projectId);
  const preflight = buildSetupPreflight({
    domainId: projectId,
    domainSummary: domainSummary ?? null,
    entities: extConfig?.entities,
    execution: normalizedExecution,
    review: extConfig?.review,
    configuredAgentIds: config.agents.map((agent) => agent.id),
  });
  const lastReload = getDomainRuntimeReloadStatus(projectId);
  const simulatedActions = safeDashboardQuery(
    () => getSimulatedActionStats(projectId),
    {
      total: 0,
      pending: 0,
      simulated: 0,
      blocked: 0,
      approvedForLive: 0,
      discarded: 0,
      latestCreatedAt: null,
    },
  );
  const activeSessions = getActiveSessions().filter((session) => session.projectId === projectId);
  const activeSessionCounts = new Map<string, number>();
  for (const session of activeSessions) {
    activeSessionCounts.set(session.agentId, (activeSessionCounts.get(session.agentId) ?? 0) + 1);
  }
  const activeTaskCounts = new Map<string, number>();
  for (const task of listTasks(projectId, { states: ["ASSIGNED", "IN_PROGRESS", "REVIEW"] })) {
    if (!task.assignedTo) continue;
    activeTaskCounts.set(task.assignedTo, (activeTaskCounts.get(task.assignedTo) ?? 0) + 1);
  }
  const jobCounts = new Map<string, number>();
  for (const job of domainSummary?.jobs ?? []) {
    jobCounts.set(job.agentId, (jobCounts.get(job.agentId) ?? 0) + 1);
  }
  const topologyAgents = config.agents.map((agent) => toSetupTopologyAgent(agent, managerAgentId, projectId, {
    jobCount: jobCounts.get(agent.id) ?? 0,
    activeSessionCount: activeSessionCounts.get(agent.id) ?? 0,
    activeTaskCount: activeTaskCounts.get(agent.id) ?? 0,
  }));
  const checkContext = Object.fromEntries(
    report.checks.map((check) => [
      check.id,
      buildSetupCheckContextReferences({
        root,
        projectId,
        checkId: check.id,
        managerAgentId,
        domainSummary: report.domains.find((domain) => domain.id === (check.domainId ?? projectId)),
      }),
    ]),
  );
  const immediateActionContext = Object.fromEntries(
    explanation.immediateActions.map((action) => [
      action.id,
      checkContext[action.id] ?? [],
    ]),
  );
  const immediateActionControls = Object.fromEntries(
    explanation.immediateActions.map((action) => [
      action.id,
      buildSetupImmediateOperatorActions({
        projectId,
        checkId: action.id,
        domainSummary: report.domains.find((domain) => domain.id === (action.domainId ?? projectId)),
      }),
    ]),
  );
  const preflightContext = Object.fromEntries(
    preflight.scenarios.map((scenario) => [
      scenario.id,
      buildSetupPreflightContextReferences({
        root,
        projectId,
        scenario,
        domainSummary,
      }),
    ]),
  );
  const agentContext = Object.fromEntries(
    topologyAgents.map((agent) => [
      agent.id,
      [buildAgentSetupReference(projectId, buildDomainConfigPath(root, domainSummary?.file ?? null), agent.id)],
    ]),
  );
  const jobContext = Object.fromEntries(
    (domainSummary?.jobs ?? []).map((job) => {
      const jobKey = `${job.agentId}:${job.jobId}`;
      return [
        jobKey,
        dedupeSetupContextReferences([
          buildJobSetupReference(projectId, buildDomainConfigPath(root, domainSummary?.file ?? null), job.agentId, job.jobId),
          buildAgentSetupReference(projectId, buildDomainConfigPath(root, domainSummary?.file ?? null), job.agentId),
        ]),
      ];
    }),
  );
  const jobControls = Object.fromEntries(
    (domainSummary?.jobs ?? []).map((job) => [
      `${job.agentId}:${job.jobId}`,
      buildSetupJobOperatorActions(projectId, job),
    ]),
  );

  return {
    domainId: projectId,
    report,
    explanation,
    preflight,
    topology: {
      managerAgentId,
      workflows: domainSummary?.workflows ?? config.workflows ?? [],
      entityKinds: Object.keys(config.entities ?? {}),
      manager: topologyAgents.find((agent) => agent.role === "manager") ?? null,
      owners: topologyAgents.filter((agent) => agent.role === "owner"),
      sharedSpecialists: topologyAgents.filter((agent) => agent.role === "specialist"),
    },
    context: {
      immediateActions: immediateActionContext,
      checks: checkContext,
      preflight: preflightContext,
      agents: agentContext,
      jobs: jobContext,
    },
    actions: {
      immediateActions: immediateActionControls,
      jobs: jobControls,
    },
    config,
    feed: safeDashboardQuery(
      () => queryAttentionSummary(projectId),
      { projectId, counts: { actionNeeded: 0, watching: 0, fyi: 0 }, items: [], generatedAt: Date.now() },
    ),
    decisionInbox: safeDashboardQuery(
      () => queryDecisionInbox(projectId),
      { projectId, counts: { actionNeeded: 0, watching: 0, fyi: 0 }, items: [], generatedAt: Date.now() },
    ),
    runtime: {
      dashboard: safeDashboardQuery(() => queryDashboardSummary(projectId), {
        budgetUtilization: { spent: 0, limit: 0, pct: 0, dimension: "cents" },
        activeAgents: 0,
        totalAgents: 0,
        tasksInFlight: 0,
        pendingApprovals: 0,
      }),
      queue: safeDashboardQuery(
        () => queryQueueStatus(projectId),
        {
          queued: 0,
          leased: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          concurrency: { active: 0, max: null },
          recentItems: [],
          missingEndpoint: false,
        },
      ),
      trackedSessions: safeDashboardQuery(
        () => queryTrackedSessions(projectId, { limit: 20, offset: 0 }),
        { sessions: [], total: 0, count: 0, limit: 20, offset: 0 },
      ),
      execution: {
        mode: normalizedExecution.mode ?? "live",
        ...(normalizedExecution.defaultMutationPolicy
          ? { defaultMutationPolicy: normalizedExecution.defaultMutationPolicy }
          : {}),
        ...(normalizedExecution.environments
          ? { environments: normalizedExecution.environments }
          : {}),
        simulatedActions,
        lastReload,
      },
    },
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

    const sessions = rows.map((r) => {
      const heartbeat = getSessionHeartbeatStatus(r.last_persisted_at);
      return {
        sessionKey: r.session_key,
        agentId: r.agent_id,
        startedAt: r.started_at,
        requirements: r.requirements,
        satisfied: r.satisfied,
        toolCallCount: r.tool_call_count,
        lastPersistedAt: r.last_persisted_at,
        heartbeatState: heartbeat.state,
        heartbeatAgeMs: heartbeat.ageMs,
      };
    });

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
  const versions = getConfigHistory(projectId).slice(0, limit);

  return {
    versions: versions.map((version) => ({
      id: version.id,
      hash: version.contentHash,
      files: version.files,
      detectedBy: version.detectedBy ?? null,
      changeSummary: version.changeSummary ?? null,
      detectedAt: version.detectedAt,
    })),
    count: versions.length,
  };
}

/** Query manager reviews with optional task filter. */
export function queryManagerReviews(projectId: string, taskId?: string, limit = 50, dbOverride?: DatabaseSync) {
  const db = dbOverride ?? getDb(projectId);
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
      id: r.id as string,
      taskId: r.task_id as string,
      reviewerAgentId: r.reviewer_agent_id as string,
      sessionKey: (r.session_key as string | null) ?? undefined,
      verdict: r.verdict as string,
      reasonCode: (r.reason_code as string | null) ?? undefined,
      reasoning: (r.reasoning as string | null) ?? undefined,
      createdAt: r.created_at as number,
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
  taskId?: string;
  entityId?: string;
  issueId?: string;
};

export type UserInboxResponse = {
  messages: UserInboxMessage[];
  count: number;
};

type OperatorCommsMessageRow = {
  id: string;
  from_agent: string;
  to_agent: string;
  content: string;
  created_at: number;
  status: string;
  read_at: number | null;
  metadata: string | null;
};

type MessageContextRefs = {
  proposalId?: string;
  taskId?: string;
  entityId?: string;
  issueId?: string;
};

function parseMessageContextRefs(metadata: string | null | undefined): MessageContextRefs {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const normalize = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined;

    return {
      proposalId: normalize(parsed.proposalId),
      taskId: normalize(parsed.taskId),
      entityId: normalize(parsed.entityId),
      issueId: normalize(parsed.issueId),
    };
  } catch {
    return {};
  }
}

function collectThreadRefLists(rows: Array<{ metadata: string | null }>) {
  const proposalIds = new Set<string>();
  const taskIds = new Set<string>();
  const entityIds = new Set<string>();
  const issueIds = new Set<string>();

  for (const row of rows) {
    const refs = parseMessageContextRefs(row.metadata);
    if (refs.proposalId) proposalIds.add(refs.proposalId);
    if (refs.taskId) taskIds.add(refs.taskId);
    if (refs.entityId) entityIds.add(refs.entityId);
    if (refs.issueId) issueIds.add(refs.issueId);
  }

  return {
    proposalIds: [...proposalIds],
    taskIds: [...taskIds],
    entityIds: [...entityIds],
    issueIds: [...issueIds],
  };
}

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

    const messages: UserInboxMessage[] = rows.map((r) => ({
      id: r.id as string,
      fromAgent: r.from_agent as string,
      toAgent: r.to_agent as string,
      content: r.content as string,
      createdAt: r.created_at as number,
      status: r.status as string,
      parentMessageId: (r.parent_message_id as string) ?? undefined,
      ...parseMessageContextRefs((r.metadata as string | null | undefined) ?? null),
    }));

    return { messages, count: messages.length };
  } catch {
    return { messages: [], count: 0 };
  }
}

export function queryOperatorComms(
  projectId: string,
  filters?: { agentId?: string; limit?: number; since?: number },
): OperatorCommsResponse {
  const db = getDb(projectId);
  const limit = Math.max(1, Math.min(filters?.limit ?? 25, 100));
  const assistant = queryDashboardAssistantStatus(projectId);
  const feed = buildAttentionSummary(projectId, db);
  const decisionInbox = buildDecisionInboxFromSummary(feed);

  const baseConditions = ["project_id = ?", "(from_agent = 'user' OR to_agent = 'user')"];
  const baseParams: Array<string | number> = [projectId];

  if (filters?.agentId) {
    baseConditions.push("(from_agent = ? OR to_agent = ?)");
    baseParams.push(filters.agentId, filters.agentId);
  }
  if (filters?.since) {
    baseConditions.push("created_at > ?");
    baseParams.push(filters.since);
  }

  const whereClause = baseConditions.join(" AND ");

  try {
    const threadRows = db.prepare(
      `SELECT
         CASE WHEN from_agent = 'user' THEN to_agent ELSE from_agent END AS agent_id,
         COUNT(*) AS message_count,
         SUM(CASE WHEN to_agent = 'user' AND read_at IS NULL THEN 1 ELSE 0 END) AS unread_count,
         SUM(CASE WHEN from_agent = 'user' AND to_agent != 'user' AND status = 'queued' THEN 1 ELSE 0 END) AS queued_for_agent_count,
         MAX(created_at) AS last_message_at
       FROM messages
       WHERE ${whereClause}
       GROUP BY agent_id
       ORDER BY last_message_at DESC
       LIMIT ?`,
    ).all(...baseParams, limit) as Array<Record<string, unknown>>;

    const directThreads: OperatorCommsThread[] = threadRows.map((row) => {
      const agentId = String(row.agent_id ?? "");
      const latestRow = db.prepare(
        `SELECT id, from_agent, to_agent, content, created_at, status, read_at, metadata
         FROM messages
         WHERE project_id = ?
           AND (
             (from_agent = 'user' AND to_agent = ?)
             OR
             (to_agent = 'user' AND from_agent = ?)
           )
           ${filters?.since ? "AND created_at > ?" : ""}
         ORDER BY created_at DESC
         LIMIT 1`,
      ).get(
        projectId,
        agentId,
        agentId,
        ...(filters?.since ? [filters.since] : []),
      ) as OperatorCommsMessageRow | undefined;

      const proposalRows = db.prepare(
        `SELECT metadata
         FROM messages
         WHERE project_id = ?
           AND metadata IS NOT NULL
           AND (
             (from_agent = 'user' AND to_agent = ?)
             OR
             (to_agent = 'user' AND from_agent = ?)
           )
           ${filters?.since ? "AND created_at > ?" : ""}
         ORDER BY created_at DESC
         LIMIT 50`,
      ).all(
        projectId,
        agentId,
        agentId,
        ...(filters?.since ? [filters.since] : []),
      ) as Array<{ metadata: string | null }>;

      const threadRefs = collectThreadRefLists(proposalRows);

      const agentEntry = getAgentConfig(agentId);
      const lastDirection: OperatorCommsThread["lastDirection"] = latestRow?.from_agent === "user"
        ? "outbound"
        : "inbound";

      return {
        id: `operator:${agentId}`,
        agentId,
        agentTitle: agentEntry?.projectId === projectId ? agentEntry.config.title : undefined,
        messageCount: Number(row.message_count ?? 0),
        unreadCount: Number(row.unread_count ?? 0),
        queuedForAgentCount: Number(row.queued_for_agent_count ?? 0),
        lastMessageAt: Number(row.last_message_at ?? 0),
        lastDirection,
        lastMessage: latestRow?.content ? latestRow.content.slice(0, 240) : undefined,
        ...threadRefs,
      };
    });

    const inboxRow = db.prepare(
      `SELECT
         COUNT(CASE WHEN to_agent = 'user' THEN 1 END) AS inbox_count,
         COUNT(CASE WHEN to_agent = 'user' AND read_at IS NULL THEN 1 END) AS unread_count,
         COUNT(CASE WHEN from_agent = 'user' AND to_agent != 'user' AND status = 'queued' THEN 1 END) AS queued_for_agents_count
       FROM messages
       WHERE ${whereClause}`,
    ).get(...baseParams) as Record<string, unknown> | undefined;

    const extConfig = getExtendedProjectConfig(projectId);
    const channelsConfigured = !!(extConfig?.channels && (extConfig.channels as unknown[]).length > 0);

    return {
      assistant,
      feed,
      directThreads,
      inboxCount: Number(inboxRow?.inbox_count ?? 0),
      unreadCount: Number(inboxRow?.unread_count ?? 0),
      queuedForAgentsCount: Number(inboxRow?.queued_for_agents_count ?? 0),
      decisionInbox,
      channelsConfigured,
    };
  } catch {
    return {
      assistant,
      feed,
      directThreads: [],
      inboxCount: 0,
      unreadCount: 0,
      queuedForAgentsCount: 0,
      decisionInbox,
      channelsConfigured: false,
    };
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

/** Query all active locks for a domain. */
export function queryLocks(projectId: string) {
  try {
    const locks = listLocks(projectId);
    return { locks, count: locks.length };
  } catch {
    return { locks: [], count: 0 };
  }
}

/** Query recent action status records for a project. */
export function queryActionStatus(
  projectId: string,
  opts?: {
    status?: ActionStatus;
    limit?: number;
    offset?: number;
  },
) {
  try {
    const records = listActionRecords(projectId, opts);
    return { records, count: records.length };
  } catch {
    return { records: [], count: 0 };
  }
}

// --- History queries ---

import {
  getResourceHistory,
  listRecentChanges,
  type ResourceHistoryOpts,
  type RecentChangesOpts,
  type ChangeProvenance,
} from "../history/store.js";

/**
 * Query changes for a specific resource.
 * Wraps getResourceHistory with error handling.
 */
export function queryResourceHistory(
  projectId: string,
  resourceType: string,
  resourceId: string,
  opts?: ResourceHistoryOpts,
) {
  try {
    const records = getResourceHistory(projectId, resourceType, resourceId, opts);
    return { records, count: records.length };
  } catch {
    return { records: [], count: 0 };
  }
}

/**
 * Query recent changes across all resources for a project.
 * Wraps listRecentChanges with error handling.
 */
export function queryRecentChanges(
  projectId: string,
  opts?: RecentChangesOpts,
) {
  try {
    const records = listRecentChanges(projectId, opts);
    return { records, count: records.length };
  } catch {
    return { records: [], count: 0 };
  }
}

// Re-export types for gateway-routes.ts
export type { ChangeProvenance };

// --- Notification queries ---

import {
  listOperatorNotifications,
  getOperatorUnreadCount,
  type ListNotificationsOptions,
} from "../notifications/store.js";
import type { NotificationRecord } from "../notifications/types.js";

/**
 * Query notifications for a project with optional filters.
 */
export function queryNotifications(
  projectId: string,
  opts?: ListNotificationsOptions,
): { notifications: NotificationRecord[]; count: number; unreadCount: number } {
  try {
    const notifications = listOperatorNotifications(projectId, opts);
    const unreadCount = getOperatorUnreadCount(projectId);
    return { notifications, count: notifications.length, unreadCount };
  } catch {
    return { notifications: [], count: 0, unreadCount: 0 };
  }
}

/**
 * Query just the unread notification count for a project.
 */
export function queryUnreadCount(projectId: string): { unreadCount: number } {
  try {
    return { unreadCount: getOperatorUnreadCount(projectId) };
  } catch {
    return { unreadCount: 0 };
  }
}

// --- Attention queries ---

import { buildAttentionSummary, buildDecisionInboxFromSummary } from "../attention/builder.js";
import type { AttentionSummary } from "../attention/types.js";

/**
 * Query attention summary for a single domain.
 */
export function queryAttentionSummary(projectId: string): AttentionSummary {
  return buildAttentionSummary(projectId);
}

/**
 * Query the human-decision subset of the operator feed for a single domain.
 */
export function queryDecisionInbox(projectId: string): AttentionSummary {
  return buildDecisionInboxFromSummary(buildAttentionSummary(projectId));
}

/**
 * Query attention rollup across multiple domains.
 */
export function queryAttentionRollup(projectIds: string[]): {
  businesses: AttentionSummary[];
  totals: { actionNeeded: number; watching: number; fyi: number };
} {
  const businesses = projectIds.map((id) => buildAttentionSummary(id));
  const totals = {
    actionNeeded: businesses.reduce((sum, b) => sum + b.counts.actionNeeded, 0),
    watching: businesses.reduce((sum, b) => sum + b.counts.watching, 0),
    fyi: businesses.reduce((sum, b) => sum + b.counts.fyi, 0),
  };
  return { businesses, totals };
}
