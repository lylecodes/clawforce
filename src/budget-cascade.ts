/**
 * Clawforce — Cascading budget allocation
 *
 * Allocates budget from parent agents to child agents across all dimensions
 * (cents, tokens, requests) and all windows (hourly, daily, monthly).
 * Child limits are bounded by the parent's remaining allocatable budget.
 */

import { type DatabaseSync, type SQLInputValue } from "./sqlite-driver.js";
import { getDb } from "./db.js";
import { safeLog } from "./diagnostics.js";
import type { BudgetConfigV2, BudgetWindowConfig } from "./types.js";
import { normalizeBudgetConfig } from "./budget/normalize.js";
import { getNextMidnightUTC, getNextHourBoundary, getNextMonthBoundaryUTC } from "./budget/reset.js";

export type BudgetAllocation = {
  hourly?: BudgetWindowConfig;
  daily?: BudgetWindowConfig;
  monthly?: BudgetWindowConfig;
};

export type AllocateBudgetParams = {
  projectId: string;
  parentAgentId: string;
  childAgentId: string;
  /** @deprecated Use allocationConfig instead */
  dailyLimitCents?: number;
  allocationConfig?: BudgetAllocation;
};

export type AllocateBudgetResult =
  | { ok: true }
  | { ok: false; reason: string };

export type AgentBudgetStatus = {
  dailyLimitCents: number;
  dailySpentCents: number;
  allocatedToReportsCents: number;
  allocatableCents: number;
};

type WindowKey = "hourly" | "daily" | "monthly";
type DimKey = "cents" | "tokens" | "requests";

const WINDOWS: WindowKey[] = ["hourly", "daily", "monthly"];
const DIMENSIONS: DimKey[] = ["cents", "tokens", "requests"];

/**
 * Resolve a BudgetAllocation from params, supporting both v2 allocationConfig
 * and legacy dailyLimitCents.
 */
function resolveAllocation(params: AllocateBudgetParams): BudgetAllocation {
  if (params.allocationConfig) {
    return params.allocationConfig;
  }
  // Legacy fallback: only dailyLimitCents
  if (params.dailyLimitCents != null) {
    return { daily: { cents: params.dailyLimitCents } };
  }
  return {};
}

/**
 * Allocate budget from parent agent to child agent.
 * Supports all dimensions (cents, tokens, requests) and all windows (hourly, daily, monthly).
 * Each dimension is validated independently: sum(children allocations) <= parent limit.
 *
 * Backward compatible: if only `dailyLimitCents` provided, maps to `{ daily: { cents: value } }`.
 */
export function allocateBudget(
  params: AllocateBudgetParams,
  dbOverride?: DatabaseSync,
): AllocateBudgetResult {
  const db = dbOverride ?? getDb(params.projectId);
  const allocation = resolveAllocation(params);

  // Get parent's budget (all limit columns)
  const parentBudget = db.prepare(
    `SELECT
      hourly_limit_cents, hourly_limit_tokens, hourly_limit_requests,
      daily_limit_cents, daily_limit_tokens, daily_limit_requests,
      monthly_limit_cents, monthly_limit_tokens, monthly_limit_requests
     FROM budgets WHERE project_id = ? AND agent_id = ?`,
  ).get(params.projectId, params.parentAgentId) as Record<string, number | null> | undefined;

  if (!parentBudget) {
    return { ok: false, reason: `Parent agent "${params.parentAgentId}" has no budget` };
  }

  // Validate each dimension independently: sum(children) + this allocation <= parent limit
  for (const win of WINDOWS) {
    const windowConfig = allocation[win];
    if (!windowConfig) continue;

    for (const dim of DIMENSIONS) {
      const requestedLimit = windowConfig[dim];
      if (requestedLimit == null || requestedLimit <= 0) continue;

      const parentLimitCol = `${win}_limit_${dim}`;
      const parentLimit = parentBudget[parentLimitCol] as number | null;

      if (parentLimit == null || parentLimit <= 0) {
        return {
          ok: false,
          reason: `Parent has no ${win} ${dim} limit set — cannot allocate ${requestedLimit}`,
        };
      }

      // Get current allocations to other children (excluding target child for update case)
      const otherRow = db.prepare(`
        SELECT COALESCE(SUM(${parentLimitCol}), 0) as total
        FROM budgets
        WHERE project_id = ? AND agent_id IS NOT NULL AND agent_id != ? AND agent_id != ?
      `).get(params.projectId, params.parentAgentId, params.childAgentId) as { total: number };

      const allocatable = parentLimit - otherRow.total;
      if (requestedLimit > allocatable) {
        return {
          ok: false,
          reason: `${win} ${dim} allocation of ${requestedLimit} exceeds parent's allocatable ${win} ${dim} budget of ${allocatable}`,
        };
      }
    }
  }

  // Upsert child's budget
  const existing = db.prepare(
    "SELECT id FROM budgets WHERE project_id = ? AND agent_id = ?",
  ).get(params.projectId, params.childAgentId) as { id: string } | undefined;

  const now = Date.now();

  if (existing) {
    // Build SET clause for all provided limits
    const setClauses: string[] = [];
    const setParams: SQLInputValue[] = [];

    for (const win of WINDOWS) {
      const windowConfig = allocation[win];
      if (!windowConfig) continue;
      for (const dim of DIMENSIONS) {
        const val = windowConfig[dim];
        if (val != null) {
          setClauses.push(`${win}_limit_${dim} = ?`);
          setParams.push(val);
        }
      }
    }

    if (setClauses.length > 0) {
      setClauses.push("updated_at = ?");
      setParams.push(now, existing.id);
      db.prepare(
        `UPDATE budgets SET ${setClauses.join(", ")} WHERE id = ?`,
      ).run(...setParams);
    }
  } else {
    // INSERT new budget row with all provided limits
    const id = `budget-${params.childAgentId}-${now}`;

    // Build columns and values lists
    const cols = ["id", "project_id", "agent_id", "daily_spent_cents", "daily_reset_at", "created_at", "updated_at"];
    const vals: SQLInputValue[] = [id, params.projectId, params.childAgentId, 0, getNextMidnightUTC(now), now, now];

    for (const win of WINDOWS) {
      const windowConfig = allocation[win];
      if (!windowConfig) continue;
      for (const dim of DIMENSIONS) {
        const val = windowConfig[dim];
        if (val != null) {
          cols.push(`${win}_limit_${dim}`);
          vals.push(val);
        }
      }
    }

    // Add window reset boundaries for windows that have limits set
    if (allocation.hourly) {
      cols.push("hourly_reset_at");
      vals.push(getNextHourBoundary(now));
    }
    if (allocation.monthly) {
      cols.push("monthly_reset_at");
      vals.push(getNextMonthBoundaryUTC(now));
    }

    const placeholders = vals.map(() => "?").join(", ");
    db.prepare(
      `INSERT INTO budgets (${cols.join(", ")}) VALUES (${placeholders})`,
    ).run(...vals);
  }

  safeLog("budget.cascade.allocate", {
    parent: params.parentAgentId,
    child: params.childAgentId,
    allocation,
  });
  return { ok: true };
}

/**
 * Get budget status for an agent including how much is allocated to reports.
 */
export function getAgentBudgetStatus(
  projectId: string,
  agentId: string,
  dbOverride?: DatabaseSync,
): AgentBudgetStatus {
  const db = dbOverride ?? getDb(projectId);

  const budget = db.prepare(
    "SELECT daily_limit_cents, daily_spent_cents FROM budgets WHERE project_id = ? AND agent_id = ?",
  ).get(projectId, agentId) as { daily_limit_cents: number; daily_spent_cents: number } | undefined;

  const dailyLimitCents = budget?.daily_limit_cents ?? 0;
  const dailySpentCents = budget?.daily_spent_cents ?? 0;

  // Sum allocations to other agents (reports)
  const reportAllocations = db.prepare(`
    SELECT COALESCE(SUM(daily_limit_cents), 0) as total
    FROM budgets
    WHERE project_id = ? AND agent_id IS NOT NULL AND agent_id != ?
  `).get(projectId, agentId) as { total: number };

  const allocatedToReportsCents = reportAllocations.total;
  const allocatableCents = Math.max(0, dailyLimitCents - allocatedToReportsCents);

  return {
    dailyLimitCents,
    dailySpentCents,
    allocatedToReportsCents,
    allocatableCents,
  };
}
