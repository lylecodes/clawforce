/**
 * Clawforce — Budget Reallocation
 *
 * Shifts budget allocation between agents within a domain.
 * Used by managers to redistribute resources based on workload.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { setBudget } from "../budget.js";

export type ReallocateParams = {
  from: string;
  to: string;
  amount_cents: number;
  window: "hourly" | "daily" | "monthly";
  reason: string;
};

export type ReallocateResult = {
  success: boolean;
  error?: string;
  from_new_limit?: number;
  to_new_limit?: number;
};

/** Column name mapping for each budget window */
const WINDOW_COLUMN: Record<string, string> = {
  hourly: "hourly_limit_cents",
  daily: "daily_limit_cents",
  monthly: "monthly_limit_cents",
};

function getAgentBudgetLimit(db: DatabaseSync, projectId: string, agentId: string, window: string): number | null {
  const col = WINDOW_COLUMN[window];
  if (!col) return null;
  const row = db.prepare(
    `SELECT ${col} as limit_cents FROM budgets WHERE project_id = ? AND agent_id = ?`
  ).get(projectId, agentId) as { limit_cents: number | null } | undefined;
  return row?.limit_cents ?? null;
}

export function reallocateBudget(
  projectId: string,
  params: ReallocateParams,
  dbOverride?: DatabaseSync,
): ReallocateResult {
  if (params.amount_cents <= 0) {
    return { success: false, error: "amount_cents must be positive" };
  }

  const db = dbOverride ?? getDb(projectId);

  const fromLimit = getAgentBudgetLimit(db, projectId, params.from, params.window);
  if (fromLimit === null) {
    return { success: false, error: `No budget found for agent "${params.from}"` };
  }

  if (fromLimit < params.amount_cents) {
    return { success: false, error: `Insufficient budget: "${params.from}" has ${fromLimit} cents in ${params.window} window, cannot transfer ${params.amount_cents}` };
  }

  const toLimit = getAgentBudgetLimit(db, projectId, params.to, params.window) ?? 0;

  const newFromLimit = fromLimit - params.amount_cents;
  const newToLimit = toLimit + params.amount_cents;

  setBudget({ projectId, agentId: params.from, config: { [params.window]: { cents: newFromLimit } } }, db);
  setBudget({ projectId, agentId: params.to, config: { [params.window]: { cents: newToLimit } } }, db);

  return {
    success: true,
    from_new_limit: newFromLimit,
    to_new_limit: newToLimit,
  };
}
