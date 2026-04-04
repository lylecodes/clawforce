/**
 * Clawforce — Operational metrics
 *
 * SQL-based metrics computed from existing tables (tasks, transitions,
 * session_archives, cost_records, dispatch_queue). No new tables required.
 *
 * Metrics:
 *   1. Agent Workload Saturation — (assigned + queued) / avg_completed_per_hour
 *   2. Queue Wait Time — avg time from ASSIGNED → IN_PROGRESS per agent
 *   3. Throughput — tasks completed per hour per agent (rolling)
 *   4. Cost Efficiency — cost per completed task per agent
 *   5. Session Efficiency — ratio of sessions that produced output
 *   6. Task Cycle Time — avg time from creation to DONE per agent + priority
 *   7. Failure Rate — % of tasks ending FAILED vs DONE per agent
 *   8. Retry Rate — count of FAILED→OPEN cycles per agent
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";

// --- Types ---

export type AgentSaturation = {
  agentId: string;
  assignedTasks: number;
  queuedDispatches: number;
  avgCompletedPerHour: number;
  saturation: number;
};

export type AgentQueueWaitTime = {
  agentId: string;
  avgWaitMs: number;
  medianWaitMs: number;
  maxWaitMs: number;
  sampleCount: number;
};

export type AgentThroughput = {
  agentId: string;
  completedLastHour: number;
  completedLast4Hours: number;
  completedLast24Hours: number;
  avgPerHour: number;
};

export type AgentCostEfficiency = {
  agentId: string;
  totalCostCents: number;
  tasksCompleted: number;
  costPerTaskCents: number;
};

export type AgentSessionEfficiency = {
  agentId: string;
  totalSessions: number;
  productiveSessions: number;
  efficiencyPct: number;
};

export type AgentCycleTime = {
  agentId: string;
  priority: string | null;
  avgCycleMs: number;
  minCycleMs: number;
  maxCycleMs: number;
  sampleCount: number;
};

export type AgentFailureRate = {
  agentId: string;
  doneTasks: number;
  failedTasks: number;
  failureRatePct: number;
};

export type AgentRetryRate = {
  agentId: string;
  retryCycles: number;
  tasksWithRetries: number;
};

export type OperationalMetrics = {
  saturation: AgentSaturation[];
  queueWaitTime: AgentQueueWaitTime[];
  throughput: AgentThroughput[];
  costEfficiency: AgentCostEfficiency[];
  sessionEfficiency: AgentSessionEfficiency[];
  cycleTime: AgentCycleTime[];
  failureRate: AgentFailureRate[];
  retryRate: AgentRetryRate[];
};

// --- Query functions ---

/**
 * Agent Workload Saturation: (assigned_tasks + queued_dispatches) / avg_completed_per_hour
 * High saturation (>3) means the agent is overloaded.
 */
export function getAgentSaturation(
  projectId: string,
  windowHours = 24,
  dbOverride?: DatabaseSync,
): AgentSaturation[] {
  const db = dbOverride ?? getDb(projectId);
  const since = Date.now() - windowHours * 3_600_000;

  try {
    // Get assigned/in-progress task counts per agent
    const assignedRows = db.prepare(`
      SELECT assigned_to, COUNT(*) as cnt
      FROM tasks
      WHERE project_id = ? AND state IN ('ASSIGNED', 'IN_PROGRESS') AND assigned_to IS NOT NULL
      GROUP BY assigned_to
    `).all(projectId) as Array<{ assigned_to: string; cnt: number }>;

    // Get queued dispatch items per agent (via task assignment)
    const queuedRows = db.prepare(`
      SELECT t.assigned_to, COUNT(*) as cnt
      FROM dispatch_queue dq
      JOIN tasks t ON dq.task_id = t.id
      WHERE dq.project_id = ? AND dq.status = 'queued' AND t.assigned_to IS NOT NULL
      GROUP BY t.assigned_to
    `).all(projectId) as Array<{ assigned_to: string; cnt: number }>;

    // Get completion rate per agent in the window
    const completedRows = db.prepare(`
      SELECT t.assigned_to, COUNT(*) as cnt
      FROM transitions tr
      JOIN tasks t ON tr.task_id = t.id
      WHERE t.project_id = ? AND tr.to_state = 'DONE' AND tr.created_at > ?
      GROUP BY t.assigned_to
    `).all(projectId, since) as Array<{ assigned_to: string; cnt: number }>;

    // Build maps
    const assignedMap = new Map(assignedRows.map((r) => [r.assigned_to, r.cnt]));
    const queuedMap = new Map(queuedRows.map((r) => [r.assigned_to, r.cnt]));
    const completedMap = new Map(completedRows.map((r) => [r.assigned_to, r.cnt]));

    // Collect all agent IDs
    const allAgents = new Set([
      ...assignedMap.keys(),
      ...queuedMap.keys(),
      ...completedMap.keys(),
    ]);

    const results: AgentSaturation[] = [];
    for (const agentId of allAgents) {
      const assigned = assignedMap.get(agentId) ?? 0;
      const queued = queuedMap.get(agentId) ?? 0;
      const completed = completedMap.get(agentId) ?? 0;
      const avgPerHour = windowHours > 0 ? completed / windowHours : 0;
      const saturation = avgPerHour > 0 ? (assigned + queued) / avgPerHour : assigned + queued > 0 ? Infinity : 0;

      results.push({
        agentId,
        assignedTasks: assigned,
        queuedDispatches: queued,
        avgCompletedPerHour: Math.round(avgPerHour * 100) / 100,
        saturation: saturation === Infinity ? 999 : Math.round(saturation * 100) / 100,
      });
    }

    return results.sort((a, b) => b.saturation - a.saturation);
  } catch {
    return [];
  }
}

/**
 * Queue Wait Time: time between ASSIGNED transition and IN_PROGRESS transition for same task.
 */
export function getQueueWaitTime(
  projectId: string,
  windowHours = 24,
  dbOverride?: DatabaseSync,
): AgentQueueWaitTime[] {
  const db = dbOverride ?? getDb(projectId);
  const since = Date.now() - windowHours * 3_600_000;

  try {
    // For each task that went ASSIGNED → IN_PROGRESS, compute the delta
    const rows = db.prepare(`
      SELECT
        t.assigned_to as agent_id,
        (ip.created_at - a.created_at) as wait_ms
      FROM transitions a
      JOIN transitions ip ON a.task_id = ip.task_id AND ip.to_state = 'IN_PROGRESS' AND ip.created_at > a.created_at
      JOIN tasks t ON a.task_id = t.id
      WHERE a.to_state = 'ASSIGNED'
        AND a.created_at > ?
        AND t.project_id = ?
        AND t.assigned_to IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM transitions mid
          WHERE mid.task_id = a.task_id
            AND mid.to_state = 'ASSIGNED'
            AND mid.created_at > a.created_at
            AND mid.created_at < ip.created_at
        )
    `).all(since, projectId) as Array<{ agent_id: string; wait_ms: number }>;

    // Group by agent
    const agentWaits = new Map<string, number[]>();
    for (const row of rows) {
      if (!row.agent_id) continue;
      const waits = agentWaits.get(row.agent_id) ?? [];
      waits.push(row.wait_ms);
      agentWaits.set(row.agent_id, waits);
    }

    const results: AgentQueueWaitTime[] = [];
    for (const [agentId, waits] of agentWaits) {
      waits.sort((a, b) => a - b);
      const avg = waits.reduce((s, v) => s + v, 0) / waits.length;
      const median = waits[Math.floor(waits.length / 2)];
      const max = waits[waits.length - 1];
      results.push({
        agentId,
        avgWaitMs: Math.round(avg),
        medianWaitMs: median,
        maxWaitMs: max,
        sampleCount: waits.length,
      });
    }

    return results.sort((a, b) => b.avgWaitMs - a.avgWaitMs);
  } catch {
    return [];
  }
}

/**
 * Throughput: tasks completed per hour per agent.
 */
export function getAgentThroughput(
  projectId: string,
  dbOverride?: DatabaseSync,
): AgentThroughput[] {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const oneHourAgo = now - 3_600_000;
  const fourHoursAgo = now - 4 * 3_600_000;
  const twentyFourHoursAgo = now - 24 * 3_600_000;

  try {
    const rows = db.prepare(`
      SELECT
        t.assigned_to as agent_id,
        SUM(CASE WHEN tr.created_at > ? THEN 1 ELSE 0 END) as last_1h,
        SUM(CASE WHEN tr.created_at > ? THEN 1 ELSE 0 END) as last_4h,
        COUNT(*) as last_24h
      FROM transitions tr
      JOIN tasks t ON tr.task_id = t.id
      WHERE t.project_id = ?
        AND tr.to_state = 'DONE'
        AND tr.created_at > ?
        AND t.assigned_to IS NOT NULL
      GROUP BY t.assigned_to
    `).all(oneHourAgo, fourHoursAgo, projectId, twentyFourHoursAgo) as Array<{
      agent_id: string;
      last_1h: number;
      last_4h: number;
      last_24h: number;
    }>;

    return rows.map((r) => ({
      agentId: r.agent_id,
      completedLastHour: r.last_1h,
      completedLast4Hours: r.last_4h,
      completedLast24Hours: r.last_24h,
      avgPerHour: Math.round((r.last_24h / 24) * 100) / 100,
    })).sort((a, b) => b.avgPerHour - a.avgPerHour);
  } catch {
    return [];
  }
}

/**
 * Cost Efficiency: cost per completed task per agent.
 */
export function getCostEfficiency(
  projectId: string,
  windowHours = 24,
  dbOverride?: DatabaseSync,
): AgentCostEfficiency[] {
  const db = dbOverride ?? getDb(projectId);
  const since = Date.now() - windowHours * 3_600_000;

  try {
    const rows = db.prepare(`
      SELECT
        cr.agent_id,
        COALESCE(SUM(cr.cost_cents), 0) as total_cost,
        (SELECT COUNT(DISTINCT tr.task_id)
         FROM transitions tr
         JOIN tasks t ON tr.task_id = t.id
         WHERE t.assigned_to = cr.agent_id AND tr.to_state = 'DONE' AND tr.created_at > ? AND t.project_id = ?
        ) as tasks_completed
      FROM cost_records cr
      WHERE cr.project_id = ? AND cr.created_at > ?
      GROUP BY cr.agent_id
    `).all(since, projectId, projectId, since) as Array<{
      agent_id: string;
      total_cost: number;
      tasks_completed: number;
    }>;

    return rows.map((r) => ({
      agentId: r.agent_id,
      totalCostCents: r.total_cost,
      tasksCompleted: r.tasks_completed,
      costPerTaskCents: r.tasks_completed > 0 ? Math.round(r.total_cost / r.tasks_completed) : 0,
    })).sort((a, b) => b.costPerTaskCents - a.costPerTaskCents);
  } catch {
    return [];
  }
}

/**
 * Session Efficiency: ratio of sessions that produced at least 1 transition or 1 proposal.
 */
export function getSessionEfficiency(
  projectId: string,
  windowHours = 24,
  dbOverride?: DatabaseSync,
): AgentSessionEfficiency[] {
  const db = dbOverride ?? getDb(projectId);
  const since = Date.now() - windowHours * 3_600_000;

  try {
    const rows = db.prepare(`
      SELECT
        sa.agent_id,
        COUNT(*) as total_sessions,
        SUM(CASE
          WHEN (SELECT COUNT(*) FROM transitions t WHERE t.actor LIKE 'agent:' || sa.agent_id || ':%' AND t.created_at >= sa.started_at AND t.created_at <= COALESCE(sa.ended_at, sa.started_at + 86400000)) > 0
            OR (SELECT COUNT(*) FROM proposals p WHERE p.proposed_by LIKE 'agent:' || sa.agent_id || ':%' AND p.created_at >= sa.started_at AND p.created_at <= COALESCE(sa.ended_at, sa.started_at + 86400000)) > 0
          THEN 1 ELSE 0
        END) as productive_sessions
      FROM session_archives sa
      WHERE sa.project_id = ? AND sa.started_at > ?
      GROUP BY sa.agent_id
    `).all(projectId, since) as Array<{
      agent_id: string;
      total_sessions: number;
      productive_sessions: number;
    }>;

    return rows.map((r) => ({
      agentId: r.agent_id,
      totalSessions: r.total_sessions,
      productiveSessions: r.productive_sessions,
      efficiencyPct: r.total_sessions > 0
        ? Math.round((r.productive_sessions / r.total_sessions) * 100)
        : 0,
    })).sort((a, b) => a.efficiencyPct - b.efficiencyPct);
  } catch {
    return [];
  }
}

/**
 * Task Cycle Time: time from task creation to DONE, averaged per agent and priority.
 */
export function getTaskCycleTime(
  projectId: string,
  windowHours = 168, // 1 week default for meaningful cycle time data
  dbOverride?: DatabaseSync,
): AgentCycleTime[] {
  const db = dbOverride ?? getDb(projectId);
  const since = Date.now() - windowHours * 3_600_000;

  try {
    const rows = db.prepare(`
      SELECT
        t.assigned_to as agent_id,
        t.priority,
        AVG(tr.created_at - t.created_at) as avg_cycle_ms,
        MIN(tr.created_at - t.created_at) as min_cycle_ms,
        MAX(tr.created_at - t.created_at) as max_cycle_ms,
        COUNT(*) as sample_count
      FROM tasks t
      JOIN transitions tr ON t.id = tr.task_id AND tr.to_state = 'DONE'
      WHERE t.project_id = ?
        AND tr.created_at > ?
        AND t.assigned_to IS NOT NULL
      GROUP BY t.assigned_to, t.priority
    `).all(projectId, since) as Array<{
      agent_id: string;
      priority: string | null;
      avg_cycle_ms: number;
      min_cycle_ms: number;
      max_cycle_ms: number;
      sample_count: number;
    }>;

    return rows.map((r) => ({
      agentId: r.agent_id,
      priority: r.priority,
      avgCycleMs: Math.round(r.avg_cycle_ms),
      minCycleMs: r.min_cycle_ms,
      maxCycleMs: r.max_cycle_ms,
      sampleCount: r.sample_count,
    })).sort((a, b) => b.avgCycleMs - a.avgCycleMs);
  } catch {
    return [];
  }
}

/**
 * Failure Rate: percentage of tasks ending FAILED vs DONE per agent.
 */
export function getFailureRate(
  projectId: string,
  windowHours = 168,
  dbOverride?: DatabaseSync,
): AgentFailureRate[] {
  const db = dbOverride ?? getDb(projectId);
  const since = Date.now() - windowHours * 3_600_000;

  try {
    const rows = db.prepare(`
      SELECT
        t.assigned_to as agent_id,
        SUM(CASE WHEN t.state = 'DONE' THEN 1 ELSE 0 END) as done_tasks,
        SUM(CASE WHEN t.state = 'FAILED' THEN 1 ELSE 0 END) as failed_tasks
      FROM tasks t
      WHERE t.project_id = ?
        AND t.state IN ('DONE', 'FAILED')
        AND t.updated_at > ?
        AND t.assigned_to IS NOT NULL
      GROUP BY t.assigned_to
    `).all(projectId, since) as Array<{
      agent_id: string;
      done_tasks: number;
      failed_tasks: number;
    }>;

    return rows.map((r) => {
      const total = r.done_tasks + r.failed_tasks;
      return {
        agentId: r.agent_id,
        doneTasks: r.done_tasks,
        failedTasks: r.failed_tasks,
        failureRatePct: total > 0 ? Math.round((r.failed_tasks / total) * 100) : 0,
      };
    }).sort((a, b) => b.failureRatePct - a.failureRatePct);
  } catch {
    return [];
  }
}

/**
 * Retry Rate: count of FAILED → OPEN transition cycles per agent.
 */
export function getRetryRate(
  projectId: string,
  windowHours = 168,
  dbOverride?: DatabaseSync,
): AgentRetryRate[] {
  const db = dbOverride ?? getDb(projectId);
  const since = Date.now() - windowHours * 3_600_000;

  try {
    // Count transitions where a task went FAILED → OPEN (a retry cycle)
    const rows = db.prepare(`
      SELECT
        t.assigned_to as agent_id,
        COUNT(*) as retry_cycles,
        COUNT(DISTINCT tr.task_id) as tasks_with_retries
      FROM transitions tr
      JOIN tasks t ON tr.task_id = t.id
      WHERE t.project_id = ?
        AND tr.from_state = 'FAILED'
        AND tr.to_state = 'OPEN'
        AND tr.created_at > ?
        AND t.assigned_to IS NOT NULL
      GROUP BY t.assigned_to
    `).all(projectId, since) as Array<{
      agent_id: string;
      retry_cycles: number;
      tasks_with_retries: number;
    }>;

    return rows.map((r) => ({
      agentId: r.agent_id,
      retryCycles: r.retry_cycles,
      tasksWithRetries: r.tasks_with_retries,
    })).sort((a, b) => b.retryCycles - a.retryCycles);
  } catch {
    return [];
  }
}

/**
 * Compute all operational metrics in a single call.
 */
export function getAllOperationalMetrics(
  projectId: string,
  windowHours = 24,
  dbOverride?: DatabaseSync,
): OperationalMetrics {
  return {
    saturation: getAgentSaturation(projectId, windowHours, dbOverride),
    queueWaitTime: getQueueWaitTime(projectId, windowHours, dbOverride),
    throughput: getAgentThroughput(projectId, dbOverride),
    costEfficiency: getCostEfficiency(projectId, windowHours, dbOverride),
    sessionEfficiency: getSessionEfficiency(projectId, windowHours, dbOverride),
    cycleTime: getTaskCycleTime(projectId, windowHours * 7, dbOverride), // wider window for cycle time
    failureRate: getFailureRate(projectId, windowHours * 7, dbOverride),
    retryRate: getRetryRate(projectId, windowHours * 7, dbOverride),
  };
}
