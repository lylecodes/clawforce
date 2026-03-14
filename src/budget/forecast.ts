/**
 * Clawforce — Budget Forecasting Module
 *
 * Multi-day budget forecasting: daily snapshot, weekly trend, monthly projection.
 * Uses counter-based O(1) reads for current state and cost_records for historical data.
 * Per-initiative breakdowns walk the goal tree (BFS) to sum task-level costs.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  DailyBudgetSnapshot,
  MonthlyProjection,
  WeeklyTrend,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTodayStartMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Collect all goal IDs under a root via BFS (cycle-safe). */
function collectGoalTree(
  projectId: string,
  rootGoalId: string,
  db: DatabaseSync,
): string[] {
  const ids: string[] = [];
  const queue: string[] = [rootGoalId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    ids.push(id);

    const children = db
      .prepare(
        "SELECT id FROM goals WHERE parent_goal_id = ? AND project_id = ?",
      )
      .all(id, projectId) as Array<{ id: string }>;

    for (const child of children) {
      queue.push(child.id);
    }
  }

  return ids;
}

/** Sum cost_cents and total tokens for tasks linked to any of the given goals, since a timestamp. */
function sumInitiativeSpendSince(
  projectId: string,
  goalIds: string[],
  sinceMs: number,
  db: DatabaseSync,
): { cents: number; tokens: number } {
  if (goalIds.length === 0) return { cents: 0, tokens: 0 };

  const placeholders = goalIds.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cr.cost_cents), 0) as cents,
              COALESCE(SUM(cr.input_tokens + cr.output_tokens + cr.cache_read_tokens + cr.cache_write_tokens), 0) as tokens
       FROM cost_records cr
       INNER JOIN tasks t ON cr.task_id = t.id AND t.project_id = cr.project_id
       WHERE t.goal_id IN (${placeholders})
         AND cr.project_id = ?
         AND cr.created_at >= ?`,
    )
    .get(...goalIds, projectId, sinceMs) as {
    cents: number;
    tokens: number;
  };

  return { cents: row.cents, tokens: row.tokens };
}

/** Get top-level initiatives: goals with allocation > 0 and no parent with allocation > 0. */
function getTopInitiatives(
  projectId: string,
  db: DatabaseSync,
): Array<{ id: string; title: string; allocation: number }> {
  const rows = db
    .prepare(
      `SELECT id, title, allocation FROM goals
       WHERE project_id = ? AND allocation IS NOT NULL AND allocation > 0 AND status = 'active'
       ORDER BY allocation DESC`,
    )
    .all(projectId) as Array<{
    id: string;
    title: string;
    allocation: number;
  }>;

  return rows;
}

// ---------------------------------------------------------------------------
// computeDailySnapshot
// ---------------------------------------------------------------------------

function dimSnapshot(
  limit: number | null,
  spent: number,
  reserved: number,
): {
  limit: number;
  spent: number;
  reserved: number;
  remaining: number;
  utilization: number;
} {
  const effectiveLimit = limit ?? 0;
  const remaining = Math.max(0, effectiveLimit - spent - reserved);
  const utilization =
    effectiveLimit > 0
      ? Math.round((spent / effectiveLimit) * 100)
      : 0;
  return { limit: effectiveLimit, spent, reserved, remaining, utilization };
}

export function computeDailySnapshot(
  projectId: string,
  db: DatabaseSync,
): DailyBudgetSnapshot {
  const todayMs = getTodayStartMs();

  // Read budget counters (O(1))
  const budget = db
    .prepare(
      "SELECT * FROM budgets WHERE project_id = ? AND agent_id IS NULL",
    )
    .get(projectId) as Record<string, number | null> | undefined;

  const dailyLimitCents = (budget?.daily_limit_cents as number | null) ?? 0;
  const dailySpentCents = (budget?.daily_spent_cents as number) ?? 0;
  const reservedCents = (budget?.reserved_cents as number) ?? 0;

  const dailyLimitTokens = (budget?.daily_limit_tokens as number | null) ?? 0;
  const dailySpentTokens = (budget?.daily_spent_tokens as number) ?? 0;
  const reservedTokens = (budget?.reserved_tokens as number) ?? 0;

  const dailyLimitRequests =
    (budget?.daily_limit_requests as number | null) ?? 0;
  const dailySpentRequests = (budget?.daily_spent_requests as number) ?? 0;
  const reservedRequests = (budget?.reserved_requests as number) ?? 0;

  const cents = dimSnapshot(dailyLimitCents, dailySpentCents, reservedCents);
  const tokens = dimSnapshot(
    dailyLimitTokens,
    dailySpentTokens,
    reservedTokens,
  );
  const requests = dimSnapshot(
    dailyLimitRequests,
    dailySpentRequests,
    reservedRequests,
  );

  // Average cost per session from today's records
  const avgRow = db
    .prepare(
      `SELECT COALESCE(AVG(cost_cents), 0) as avg_cost, COUNT(*) as cnt
       FROM cost_records
       WHERE project_id = ? AND created_at >= ? AND cost_cents > 0`,
    )
    .get(projectId, todayMs) as { avg_cost: number; cnt: number };

  const avgCost = avgRow.avg_cost;
  const sessionsRemaining =
    avgCost > 0 ? Math.floor(cents.remaining / avgCost) : 0;

  // Exhaustion ETA from burn rate
  let exhaustionEta: Date | null = null;
  if (avgRow.cnt >= 2 && dailySpentCents > 0) {
    const hoursElapsed = (Date.now() - todayMs) / 3_600_000;
    if (hoursElapsed > 0) {
      const burnRatePerHour = dailySpentCents / hoursElapsed;
      if (burnRatePerHour > 0 && cents.remaining > 0) {
        const hoursRemaining = cents.remaining / burnRatePerHour;
        exhaustionEta = new Date(Date.now() + hoursRemaining * 3_600_000);
      } else if (cents.remaining <= 0) {
        exhaustionEta = new Date(); // already exhausted
      }
    }
  }

  // Per-initiative breakdown
  const initiatives: DailyBudgetSnapshot["initiatives"] = [];
  const topInitiatives = getTopInitiatives(projectId, db);

  for (const init of topInitiatives) {
    const goalIds = collectGoalTree(projectId, init.id, db);
    const spend = sumInitiativeSpendSince(projectId, goalIds, todayMs, db);

    const allocationCents =
      dailyLimitCents > 0
        ? Math.round((init.allocation / 100) * dailyLimitCents)
        : 0;
    const utilization =
      allocationCents > 0
        ? Math.round((spend.cents / allocationCents) * 100)
        : 0;

    initiatives.push({
      id: init.id,
      name: init.title,
      allocation: init.allocation,
      spent: spend,
      utilization,
    });
  }

  return {
    cents,
    tokens,
    requests,
    sessionsRemaining,
    exhaustionEta,
    initiatives,
  };
}

// ---------------------------------------------------------------------------
// computeWeeklyTrend
// ---------------------------------------------------------------------------

type DayBucket = {
  date: string;
  cents: number;
  tokens: number;
  requests: number;
};

export function computeWeeklyTrend(
  projectId: string,
  db: DatabaseSync,
): WeeklyTrend {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 86_400_000;

  // Query cost_records grouped by date for last 7 days
  const rows = db
    .prepare(
      `SELECT DATE(created_at / 1000, 'unixepoch', 'localtime') as day,
              COALESCE(SUM(cost_cents), 0) as cents,
              COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) as tokens,
              COUNT(*) as requests
       FROM cost_records
       WHERE project_id = ? AND created_at >= ?
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(projectId, sevenDaysAgo) as Array<{
    day: string;
    cents: number;
    tokens: number;
    requests: number;
  }>;

  const buckets: DayBucket[] = rows.map((r) => ({
    date: r.day,
    cents: r.cents,
    tokens: r.tokens,
    requests: r.requests,
  }));

  const numDays = Math.max(buckets.length, 1);
  const totalCents = buckets.reduce((s, b) => s + b.cents, 0);
  const totalTokens = buckets.reduce((s, b) => s + b.tokens, 0);
  const totalRequests = buckets.reduce((s, b) => s + b.requests, 0);

  const dailyAverage = {
    cents: Math.round(totalCents / numDays),
    tokens: Math.round(totalTokens / numDays),
    requests: Math.round(totalRequests / numDays),
  };

  // Direction: compare last 3 days vs previous 4 (or available days)
  // Sort ascending; recent = end of array
  const recentDays = buckets.slice(-3);
  const previousDays = buckets.slice(0, Math.max(0, buckets.length - 3));

  const recentAvgCents =
    recentDays.length > 0
      ? recentDays.reduce((s, b) => s + b.cents, 0) / recentDays.length
      : 0;
  const previousAvgCents =
    previousDays.length > 0
      ? previousDays.reduce((s, b) => s + b.cents, 0) / previousDays.length
      : recentAvgCents; // if no previous, treat as stable

  const recentAvgTokens =
    recentDays.length > 0
      ? recentDays.reduce((s, b) => s + b.tokens, 0) / recentDays.length
      : 0;
  const previousAvgTokens =
    previousDays.length > 0
      ? previousDays.reduce((s, b) => s + b.tokens, 0) / previousDays.length
      : recentAvgTokens;

  function calcDirection(
    recent: number,
    previous: number,
  ): "up" | "down" | "stable" {
    if (previous === 0) return recent > 0 ? "up" : "stable";
    const pctChange = ((recent - previous) / previous) * 100;
    if (pctChange > 10) return "up";
    if (pctChange < -10) return "down";
    return "stable";
  }

  function calcChangePercent(recent: number, previous: number): number {
    if (previous === 0) return recent > 0 ? 100 : 0;
    return Math.round(((recent - previous) / previous) * 100);
  }

  const direction = {
    cents: calcDirection(recentAvgCents, previousAvgCents),
    tokens: calcDirection(recentAvgTokens, previousAvgTokens),
  };

  const changePercent = {
    cents: calcChangePercent(recentAvgCents, previousAvgCents),
    tokens: calcChangePercent(recentAvgTokens, previousAvgTokens),
  };

  // Per-initiative daily averages vs allocation
  const perInitiative: WeeklyTrend["perInitiative"] = [];
  const topInitiatives = getTopInitiatives(projectId, db);

  // Read daily budget for allocation reference
  const budgetRow = db
    .prepare(
      "SELECT daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
    )
    .get(projectId) as { daily_limit_cents: number | null } | undefined;
  const dailyLimitCents = budgetRow?.daily_limit_cents ?? 0;

  for (const init of topInitiatives) {
    const goalIds = collectGoalTree(projectId, init.id, db);
    if (goalIds.length === 0) continue;

    const placeholders = goalIds.map(() => "?").join(", ");
    const initRow = db
      .prepare(
        `SELECT COALESCE(SUM(cr.cost_cents), 0) as cents,
                COALESCE(SUM(cr.input_tokens + cr.output_tokens + cr.cache_read_tokens + cr.cache_write_tokens), 0) as tokens
         FROM cost_records cr
         INNER JOIN tasks t ON cr.task_id = t.id AND t.project_id = cr.project_id
         WHERE t.goal_id IN (${placeholders})
           AND cr.project_id = ?
           AND cr.created_at >= ?`,
      )
      .get(...goalIds, projectId, sevenDaysAgo) as {
      cents: number;
      tokens: number;
    };

    const initDailyAvg = {
      cents: Math.round(initRow.cents / numDays),
      tokens: Math.round(initRow.tokens / numDays),
    };

    const allocationCentsPerDay =
      dailyLimitCents > 0
        ? Math.round((init.allocation / 100) * dailyLimitCents)
        : 0;

    const overUnder =
      allocationCentsPerDay > 0
        ? Math.round(
            ((initDailyAvg.cents - allocationCentsPerDay) /
              allocationCentsPerDay) *
              100,
          )
        : 0;

    perInitiative.push({
      id: init.id,
      name: init.title,
      dailyAverage: initDailyAvg,
      allocation: init.allocation,
      overUnder,
    });
  }

  return { dailyAverage, direction, changePercent, perInitiative };
}

// ---------------------------------------------------------------------------
// computeMonthlyProjection
// ---------------------------------------------------------------------------

export function computeMonthlyProjection(
  projectId: string,
  db: DatabaseSync,
): MonthlyProjection {
  const now = new Date();
  const monthStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    1,
  ).getTime();
  const daysInMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
  ).getDate();
  const dayOfMonth = now.getDate();
  const remainingDays = daysInMonth - dayOfMonth;

  // Total spend this month so far
  const monthRow = db
    .prepare(
      `SELECT COALESCE(SUM(cost_cents), 0) as cents,
              COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) as tokens
       FROM cost_records
       WHERE project_id = ? AND created_at >= ?`,
    )
    .get(projectId, monthStart) as { cents: number; tokens: number };

  const daysElapsed = Math.max(dayOfMonth, 1);
  const dailyAvgCents = monthRow.cents / daysElapsed;
  const dailyAvgTokens = monthRow.tokens / daysElapsed;

  const projectedTotal = {
    cents: Math.round(monthRow.cents + dailyAvgCents * remainingDays),
    tokens: Math.round(monthRow.tokens + dailyAvgTokens * remainingDays),
  };

  // Read monthly limits from budget
  const budget = db
    .prepare(
      "SELECT monthly_limit_cents, monthly_limit_tokens FROM budgets WHERE project_id = ? AND agent_id IS NULL",
    )
    .get(projectId) as {
    monthly_limit_cents: number | null;
    monthly_limit_tokens: number | null;
  } | undefined;

  const monthlyLimit = {
    cents: budget?.monthly_limit_cents ?? null,
    tokens: budget?.monthly_limit_tokens ?? null,
  };

  // Calculate exhaustion day
  let exhaustionDay: number | null = null;
  if (monthlyLimit.cents !== null && dailyAvgCents > 0) {
    const daysUntilExhaustion =
      (monthlyLimit.cents - monthRow.cents) / dailyAvgCents;
    if (daysUntilExhaustion >= 0 && daysUntilExhaustion <= remainingDays) {
      exhaustionDay = dayOfMonth + Math.ceil(daysUntilExhaustion);
    }
  }
  // Also check token exhaustion
  if (
    exhaustionDay === null &&
    monthlyLimit.tokens !== null &&
    dailyAvgTokens > 0
  ) {
    const daysUntilTokenExhaustion =
      (monthlyLimit.tokens - monthRow.tokens) / dailyAvgTokens;
    if (
      daysUntilTokenExhaustion >= 0 &&
      daysUntilTokenExhaustion <= remainingDays
    ) {
      exhaustionDay = dayOfMonth + Math.ceil(daysUntilTokenExhaustion);
    }
  }

  // Per-initiative projections
  const perInitiative: MonthlyProjection["perInitiative"] = [];
  const topInitiatives = getTopInitiatives(projectId, db);

  for (const init of topInitiatives) {
    const goalIds = collectGoalTree(projectId, init.id, db);
    if (goalIds.length === 0) continue;

    const placeholders = goalIds.map(() => "?").join(", ");
    const initRow = db
      .prepare(
        `SELECT COALESCE(SUM(cr.cost_cents), 0) as cents
         FROM cost_records cr
         INNER JOIN tasks t ON cr.task_id = t.id AND t.project_id = cr.project_id
         WHERE t.goal_id IN (${placeholders})
           AND cr.project_id = ?
           AND cr.created_at >= ?`,
      )
      .get(...goalIds, projectId, monthStart) as { cents: number };

    const initDailyAvg = initRow.cents / daysElapsed;
    const initProjectedTotal = Math.round(
      initRow.cents + initDailyAvg * remainingDays,
    );

    // Monthly allocation = daily allocation * days in month
    const dailyAllocationCents =
      monthlyLimit.cents !== null
        ? Math.round((init.allocation / 100) * monthlyLimit.cents)
        : 0;

    const onTrack =
      dailyAllocationCents > 0
        ? initProjectedTotal <= dailyAllocationCents
        : true;

    perInitiative.push({
      id: init.id,
      projectedTotal: initProjectedTotal,
      allocation: init.allocation,
      onTrack,
    });
  }

  return { projectedTotal, monthlyLimit, exhaustionDay, perInitiative };
}
