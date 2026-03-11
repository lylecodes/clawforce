/**
 * Clawforce — Cascading budget allocation
 *
 * Allocates daily budget from parent agents to child agents.
 * Child limits are bounded by the parent's remaining allocatable budget.
 */

import { type DatabaseSync } from "node:sqlite";
import { getDb } from "./db.js";
import { safeLog } from "./diagnostics.js";

export type AllocateBudgetParams = {
  projectId: string;
  parentAgentId: string;
  childAgentId: string;
  dailyLimitCents: number;
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

/**
 * Allocate daily budget from parent agent to child agent.
 * Child's limit is bounded by parent's remaining allocatable budget.
 */
export function allocateBudget(
  params: AllocateBudgetParams,
  dbOverride?: DatabaseSync,
): AllocateBudgetResult {
  const db = dbOverride ?? getDb(params.projectId);

  // Get parent's budget
  const parentBudget = db.prepare(
    "SELECT daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id = ?",
  ).get(params.projectId, params.parentAgentId) as { daily_limit_cents: number } | undefined;

  if (!parentBudget) {
    return { ok: false, reason: `Parent agent "${params.parentAgentId}" has no budget` };
  }

  // Get current allocations to other reports (excluding the target child for update case)
  const otherAllocations = db.prepare(`
    SELECT COALESCE(SUM(daily_limit_cents), 0) as total
    FROM budgets
    WHERE project_id = ? AND agent_id IS NOT NULL AND agent_id != ? AND agent_id != ?
  `).get(params.projectId, params.parentAgentId, params.childAgentId) as { total: number };

  const allocatable = parentBudget.daily_limit_cents - otherAllocations.total;

  if (params.dailyLimitCents > allocatable) {
    return {
      ok: false,
      reason: `Allocation of ${params.dailyLimitCents}c exceeds parent's allocatable budget of ${allocatable}c`,
    };
  }

  // Upsert child's budget
  const existing = db.prepare(
    "SELECT id FROM budgets WHERE project_id = ? AND agent_id = ?",
  ).get(params.projectId, params.childAgentId) as { id: string } | undefined;

  const now = Date.now();
  if (existing) {
    db.prepare(
      "UPDATE budgets SET daily_limit_cents = ?, updated_at = ? WHERE id = ?",
    ).run(params.dailyLimitCents, now, existing.id);
  } else {
    const id = `budget-${params.childAgentId}-${now}`;
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    `).run(id, params.projectId, params.childAgentId, params.dailyLimitCents, now + 86400000, now, now);
  }

  safeLog("budget.cascade.allocate", { parent: params.parentAgentId, child: params.childAgentId, cents: params.dailyLimitCents });
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
