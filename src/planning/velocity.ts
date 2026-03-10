/**
 * Clawforce — Velocity tracking
 *
 * Tasks completed per hour/day with trend direction,
 * phase completion ETA, blocker impact analysis,
 * cost trajectory vs budget projection.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";

// --- Types ---

export type VelocityWindow = {
  /** Window label, e.g. "last_24h" */
  label: string;
  /** Number of tasks completed in this window */
  completed: number;
  /** Window duration in ms */
  durationMs: number;
  /** Tasks per hour */
  tasksPerHour: number;
};

export type VelocityTrend = "accelerating" | "steady" | "decelerating" | "insufficient_data";

export type VelocityReport = {
  windows: VelocityWindow[];
  trend: VelocityTrend;
  /** Average cycle time in ms (creation → DONE) */
  avgCycleTimeMs: number | null;
  /** Tasks remaining (non-terminal states) */
  tasksRemaining: number;
  /** Estimated hours to complete remaining tasks (null if velocity = 0) */
  etaHours: number | null;
  /** Blocker impact: tasks sorted by downstream impact */
  blockerImpact: BlockerImpact[];
  /** Cost trajectory */
  costTrajectory: CostTrajectory | null;
};

export type BlockerImpact = {
  taskId: string;
  taskTitle: string;
  taskState: string;
  /** Number of tasks directly or transitively blocked */
  downstreamCount: number;
  /** IDs of directly blocked tasks */
  directlyBlocked: string[];
};

export type CostTrajectory = {
  /** Total spent so far (cents) */
  totalSpentCents: number;
  /** Daily budget limit (cents), null if no budget */
  dailyLimitCents: number | null;
  /** Spending today (cents) */
  todaySpentCents: number;
  /** Average daily spend (cents) over last 7 days */
  avgDailySpendCents: number;
  /** Projected daily spend based on today's rate (cents) */
  projectedDailySpendCents: number;
  /** Whether projected to exceed daily budget */
  overBudget: boolean;
};

// --- Core functions ---

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Compute velocity windows for completed tasks.
 * Returns stats for last 1h, 6h, 24h, and 7d windows.
 */
export function computeVelocity(
  projectId: string,
  dbOverride?: DatabaseSync,
): { windows: VelocityWindow[]; trend: VelocityTrend } {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();

  const windowDefs: Array<{ label: string; durationMs: number }> = [
    { label: "last_1h", durationMs: HOUR_MS },
    { label: "last_6h", durationMs: 6 * HOUR_MS },
    { label: "last_24h", durationMs: DAY_MS },
    { label: "last_7d", durationMs: 7 * DAY_MS },
  ];

  const windows: VelocityWindow[] = [];

  for (const def of windowDefs) {
    const since = now - def.durationMs;
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM transitions
      WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)
        AND to_state = 'DONE' AND created_at >= ?
    `).get(projectId, since) as Record<string, unknown>;

    const completed = (row?.cnt as number) ?? 0;
    const hours = def.durationMs / HOUR_MS;

    windows.push({
      label: def.label,
      completed,
      durationMs: def.durationMs,
      tasksPerHour: hours > 0 ? completed / hours : 0,
    });
  }

  // Determine trend: compare last 6h rate vs previous 6h rate
  const trend = computeTrend(projectId, now, db);

  return { windows, trend };
}

/**
 * Compare recent velocity (last 6h) vs prior period (6-12h ago).
 */
function computeTrend(
  projectId: string,
  now: number,
  db: DatabaseSync,
): VelocityTrend {
  const recentSince = now - 6 * HOUR_MS;
  const priorSince = now - 12 * HOUR_MS;

  const recentRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM transitions
    WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)
      AND to_state = 'DONE' AND created_at >= ?
  `).get(projectId, recentSince) as Record<string, unknown>;

  const priorRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM transitions
    WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)
      AND to_state = 'DONE' AND created_at >= ? AND created_at < ?
  `).get(projectId, priorSince, recentSince) as Record<string, unknown>;

  const recent = (recentRow?.cnt as number) ?? 0;
  const prior = (priorRow?.cnt as number) ?? 0;

  if (recent + prior < 2) return "insufficient_data";
  if (prior === 0 && recent > 0) return "accelerating";
  if (prior === 0 && recent === 0) return "insufficient_data";

  const ratio = recent / prior;
  if (ratio > 1.25) return "accelerating";
  if (ratio < 0.75) return "decelerating";
  return "steady";
}

/**
 * Compute average cycle time for completed tasks.
 */
export function computeAvgCycleTime(
  projectId: string,
  dbOverride?: DatabaseSync,
  since?: number,
): number | null {
  const db = dbOverride ?? getDb(projectId);
  const sinceMs = since ?? Date.now() - 7 * DAY_MS;

  const row = db.prepare(`
    SELECT AVG(t2.created_at - t.created_at) as avg_cycle
    FROM tasks t
    JOIN transitions t2 ON t2.task_id = t.id AND t2.to_state = 'DONE'
    WHERE t.project_id = ? AND t2.created_at >= ?
  `).get(projectId, sinceMs) as Record<string, unknown>;

  const avg = row?.avg_cycle as number | null;
  return avg ?? null;
}

/**
 * Estimate hours to complete remaining tasks based on current velocity.
 */
export function estimateETA(
  tasksRemaining: number,
  tasksPerHour: number,
): number | null {
  if (tasksPerHour <= 0 || tasksRemaining <= 0) return null;
  return tasksRemaining / tasksPerHour;
}

/**
 * Analyze blocker impact: which blocked/incomplete tasks hold up
 * the most downstream work. Uses the task_dependencies table.
 *
 * Returns top blockers sorted by downstream impact (descending).
 */
export function analyzeBlockerImpact(
  projectId: string,
  dbOverride?: DatabaseSync,
  limit = 10,
): BlockerImpact[] {
  const db = dbOverride ?? getDb(projectId);

  // Find all tasks that are blocking others (not DONE, have dependents with type = 'blocks')
  const blockerRows = db.prepare(`
    SELECT DISTINCT d.depends_on_task_id as task_id,
           t.title, t.state
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.depends_on_task_id AND t.project_id = d.project_id
    WHERE d.project_id = ? AND d.type = 'blocks' AND t.state != 'DONE'
  `).all(projectId) as Record<string, unknown>[];

  if (blockerRows.length === 0) return [];

  // For each blocker, compute total downstream impact (transitive)
  const results: BlockerImpact[] = [];

  for (const row of blockerRows) {
    const taskId = row.task_id as string;
    const { count, directIds } = countDownstream(projectId, taskId, db);

    results.push({
      taskId,
      taskTitle: row.title as string,
      taskState: row.state as string,
      downstreamCount: count,
      directlyBlocked: directIds,
    });
  }

  // Sort by downstream impact descending
  results.sort((a, b) => b.downstreamCount - a.downstreamCount);
  return results.slice(0, limit);
}

/**
 * Count tasks transitively downstream of a given task via hard dependencies.
 */
function countDownstream(
  projectId: string,
  taskId: string,
  db: DatabaseSync,
): { count: number; directIds: string[] } {
  const directIds: string[] = [];
  const visited = new Set<string>();
  const queue = [taskId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const dependents = db.prepare(
      "SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ? AND project_id = ? AND type = 'blocks'",
    ).all(current, projectId) as Record<string, unknown>[];

    for (const dep of dependents) {
      const depId = dep.task_id as string;
      if (current === taskId) directIds.push(depId);
      if (!visited.has(depId)) queue.push(depId);
    }
  }

  // Remove the root task from visited count
  visited.delete(taskId);
  return { count: visited.size, directIds };
}

/**
 * Compute cost trajectory vs budget.
 */
export function computeCostTrajectory(
  projectId: string,
  dbOverride?: DatabaseSync,
): CostTrajectory | null {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();

  // Total spent
  let totalRow: Record<string, unknown> | undefined;
  try {
    totalRow = db.prepare(
      "SELECT COALESCE(SUM(cost_cents), 0) as total FROM cost_records WHERE project_id = ?",
    ).get(projectId) as Record<string, unknown> | undefined;
  } catch {
    return null; // cost_records table may not exist
  }

  const totalSpentCents = (totalRow?.total as number) ?? 0;
  if (totalSpentCents === 0) return null;

  // Today's spending
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayRow = db.prepare(
    "SELECT COALESCE(SUM(cost_cents), 0) as total FROM cost_records WHERE project_id = ? AND created_at >= ?",
  ).get(projectId, todayStart.getTime()) as Record<string, unknown>;
  const todaySpentCents = (todayRow?.total as number) ?? 0;

  // Average daily spend (last 7 days)
  const weekAgo = now - 7 * DAY_MS;
  const weekRow = db.prepare(
    "SELECT COALESCE(SUM(cost_cents), 0) as total FROM cost_records WHERE project_id = ? AND created_at >= ?",
  ).get(projectId, weekAgo) as Record<string, unknown>;
  const weekTotal = (weekRow?.total as number) ?? 0;
  const avgDailySpendCents = Math.round(weekTotal / 7);

  // Project today's rate to full day
  const hoursElapsed = (now - todayStart.getTime()) / HOUR_MS;
  const projectedDailySpendCents = hoursElapsed > 0.5
    ? Math.round((todaySpentCents / hoursElapsed) * 24)
    : avgDailySpendCents; // too early in day, use 7d avg

  // Budget
  let dailyLimitCents: number | null = null;
  try {
    const budget = db.prepare(
      "SELECT daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
    ).get(projectId) as Record<string, unknown> | undefined;
    dailyLimitCents = (budget?.daily_limit_cents as number) ?? null;
  } catch { /* budgets table may not exist */ }

  const overBudget = dailyLimitCents !== null && projectedDailySpendCents > dailyLimitCents;

  return {
    totalSpentCents,
    dailyLimitCents,
    todaySpentCents,
    avgDailySpendCents,
    projectedDailySpendCents,
    overBudget,
  };
}

/**
 * Build a full velocity report for a project.
 */
export function buildVelocityReport(
  projectId: string,
  dbOverride?: DatabaseSync,
): VelocityReport {
  const db = dbOverride ?? getDb(projectId);

  const { windows, trend } = computeVelocity(projectId, db);
  const avgCycleTimeMs = computeAvgCycleTime(projectId, db);

  // Count remaining tasks
  const remainingRow = db.prepare(
    "SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND state NOT IN ('DONE', 'CANCELLED', 'FAILED')",
  ).get(projectId) as Record<string, unknown>;
  const tasksRemaining = (remainingRow?.cnt as number) ?? 0;

  // Use 24h velocity for ETA
  const velocity24h = windows.find((w) => w.label === "last_24h");
  const etaHours = velocity24h ? estimateETA(tasksRemaining, velocity24h.tasksPerHour) : null;

  let blockerImpact: BlockerImpact[] = [];
  try {
    blockerImpact = analyzeBlockerImpact(projectId, db, 5);
  } catch (err) { safeLog("velocity.blockerImpact", err); }

  let costTrajectory: CostTrajectory | null = null;
  try {
    costTrajectory = computeCostTrajectory(projectId, db);
  } catch (err) { safeLog("velocity.costTrajectory", err); }

  return {
    windows,
    trend,
    avgCycleTimeMs,
    tasksRemaining,
    etaHours,
    blockerImpact,
    costTrajectory,
  };
}

/**
 * Render velocity report as markdown for context injection.
 */
export function renderVelocityReport(report: VelocityReport): string | null {
  // Don't render if there's nothing meaningful
  const totalCompleted = report.windows.find((w) => w.label === "last_7d")?.completed ?? 0;
  if (totalCompleted === 0 && report.tasksRemaining === 0 && report.blockerImpact.length === 0 && !report.costTrajectory) {
    return null;
  }

  const lines = ["## Velocity Report", ""];

  // Throughput
  const trendEmoji = {
    accelerating: "trending up",
    steady: "steady",
    decelerating: "trending down",
    insufficient_data: "n/a",
  }[report.trend];

  lines.push("### Throughput");
  for (const w of report.windows) {
    const label = w.label.replace("last_", "").replace("_", " ");
    lines.push(`- **${label}:** ${w.completed} completed (${w.tasksPerHour.toFixed(1)}/hr)`);
  }
  lines.push(`- **Trend:** ${trendEmoji}`);

  // Cycle time
  if (report.avgCycleTimeMs !== null) {
    const hrs = report.avgCycleTimeMs / HOUR_MS;
    const display = hrs < 1
      ? `${Math.round(report.avgCycleTimeMs / 60_000)}m`
      : `${hrs.toFixed(1)}h`;
    lines.push(`- **Avg cycle time:** ${display}`);
  }

  // ETA
  if (report.tasksRemaining > 0) {
    lines.push("");
    lines.push("### Projection");
    lines.push(`- **Tasks remaining:** ${report.tasksRemaining}`);
    if (report.etaHours !== null) {
      const display = report.etaHours < 1
        ? `${Math.round(report.etaHours * 60)}m`
        : report.etaHours < 48
          ? `${report.etaHours.toFixed(1)}h`
          : `${(report.etaHours / 24).toFixed(1)}d`;
      lines.push(`- **ETA at current rate:** ~${display}`);
    } else {
      lines.push("- **ETA:** unable to estimate (no recent completions)");
    }
  }

  // Blocker impact
  if (report.blockerImpact.length > 0) {
    lines.push("");
    lines.push("### Critical Blockers");
    for (const b of report.blockerImpact) {
      lines.push(`- **${b.taskTitle}** (\`${b.taskId.slice(0, 8)}\`) [${b.taskState}] — blocking ${b.downstreamCount} task(s)`);
    }
  }

  // Cost trajectory
  if (report.costTrajectory) {
    const ct = report.costTrajectory;
    lines.push("");
    lines.push("### Cost Trajectory");
    lines.push(`- **Today:** $${(ct.todaySpentCents / 100).toFixed(2)}`);
    lines.push(`- **7d avg/day:** $${(ct.avgDailySpendCents / 100).toFixed(2)}`);
    lines.push(`- **Projected today:** $${(ct.projectedDailySpendCents / 100).toFixed(2)}`);
    if (ct.dailyLimitCents !== null) {
      const pct = Math.round((ct.projectedDailySpendCents / ct.dailyLimitCents) * 100);
      const warning = ct.overBudget ? " **OVER BUDGET**" : "";
      lines.push(`- **Budget:** ${pct}% of $${(ct.dailyLimitCents / 100).toFixed(2)} daily limit${warning}`);
    }
  }

  return lines.join("\n");
}
