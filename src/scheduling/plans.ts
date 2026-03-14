/**
 * Clawforce — Dispatch Plan CRUD
 *
 * Coordination agents create a plan per wake cycle, track execution,
 * and review actual vs. planned on completion.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { reserveBudget, releasePlanReservation } from "../budget/reservation.js";
import { ensureWindowsCurrent } from "../budget/reset.js";
import type { ActualResult, BudgetCheckResult, DispatchPlan, DispatchPlanStatus, PlannedItem } from "../types.js";

function rowToPlan(row: Record<string, unknown>): DispatchPlan {
  const plan: DispatchPlan = {
    id: row.id as string,
    projectId: row.project_id as string,
    agentId: row.agent_id as string,
    status: row.status as DispatchPlanStatus,
    plannedItems: JSON.parse(row.planned_items as string),
    estimatedCostCents: row.estimated_cost_cents as number,
    createdAt: row.created_at as number,
  };
  if (row.actual_results != null) {
    try { plan.actualResults = JSON.parse(row.actual_results as string); } catch { /* ignore */ }
  }
  if (row.actual_cost_cents != null) plan.actualCostCents = row.actual_cost_cents as number;
  if (row.completed_at != null) plan.completedAt = row.completed_at as number;
  return plan;
}

/**
 * Pre-flight budget validation for a dispatch plan.
 * Checks if the plan's estimated cost fits within remaining budget
 * (accounting for current spend and existing reservations).
 */
export function validatePlanBudget(
  plan: { estimatedCostCents: number; estimatedTokens?: number; plannedItems?: PlannedItem[] },
  projectId: string,
  dbOverride?: DatabaseSync,
): BudgetCheckResult {
  const db = dbOverride ?? getDb(projectId);

  // Trigger lazy reset before reading
  ensureWindowsCurrent(projectId, undefined, db);

  const row = db.prepare(
    "SELECT * FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(projectId) as Record<string, number | null> | undefined;

  if (!row) {
    // No budget configured — allow
    return { ok: true };
  }

  const dailyLimit = row.daily_limit_cents as number | null;
  if (dailyLimit == null || dailyLimit <= 0) {
    return { ok: true };
  }

  const dailySpent = (row.daily_spent_cents as number) ?? 0;
  const reservedCents = (row.reserved_cents as number) ?? 0;
  const remaining = dailyLimit - dailySpent - reservedCents;

  if (plan.estimatedCostCents > remaining) {
    return {
      ok: false,
      remaining: Math.max(0, remaining),
      reason: `Plan estimated cost (${plan.estimatedCostCents} cents) exceeds remaining daily budget (${remaining} cents = ${dailyLimit} limit - ${dailySpent} spent - ${reservedCents} reserved)`,
    };
  }

  // Also check token limits if configured
  const dailyLimitTokens = row.daily_limit_tokens as number | null;
  if (dailyLimitTokens != null && dailyLimitTokens > 0 && plan.estimatedTokens) {
    const dailySpentTokens = (row.daily_spent_tokens as number) ?? 0;
    const reservedTokens = (row.reserved_tokens as number) ?? 0;
    const remainingTokens = dailyLimitTokens - dailySpentTokens - reservedTokens;

    if (plan.estimatedTokens > remainingTokens) {
      return {
        ok: false,
        remaining: Math.max(0, remaining),
        reason: `Plan estimated tokens (${plan.estimatedTokens}) exceeds remaining daily token budget (${remainingTokens} = ${dailyLimitTokens} limit - ${dailySpentTokens} spent - ${reservedTokens} reserved)`,
      };
    }
  }

  return { ok: true, remaining: Math.max(0, remaining) };
}

export type CreatePlanParams = {
  projectId: string;
  agentId: string;
  plannedItems: PlannedItem[];
};

export function createPlan(params: CreatePlanParams, dbOverride?: DatabaseSync): DispatchPlan {
  const db = dbOverride ?? getDb(params.projectId);
  const id = randomUUID();
  const now = Date.now();
  const estimatedCostCents = params.plannedItems.reduce((sum, item) => sum + item.estimatedCostCents, 0);

  db.prepare(`
    INSERT INTO dispatch_plans (id, project_id, agent_id, status, planned_items, estimated_cost_cents, created_at)
    VALUES (?, ?, ?, 'planned', ?, ?, ?)
  `).run(id, params.projectId, params.agentId, JSON.stringify(params.plannedItems), estimatedCostCents, now);

  return {
    id,
    projectId: params.projectId,
    agentId: params.agentId,
    status: "planned",
    plannedItems: params.plannedItems,
    estimatedCostCents,
    createdAt: now,
  };
}

export function getPlan(projectId: string, planId: string, dbOverride?: DatabaseSync): DispatchPlan | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare("SELECT * FROM dispatch_plans WHERE id = ? AND project_id = ?")
    .get(planId, projectId) as Record<string, unknown> | undefined;
  return row ? rowToPlan(row) : null;
}

export function startPlan(projectId: string, planId: string, dbOverride?: DatabaseSync): BudgetCheckResult {
  const db = dbOverride ?? getDb(projectId);

  // Fetch the plan to get estimated costs
  const plan = getPlan(projectId, planId, db);
  if (!plan) {
    return { ok: false, reason: `Plan ${planId} not found` };
  }
  if (plan.status !== "planned") {
    return { ok: false, reason: `Plan ${planId} is in '${plan.status}' state, expected 'planned'` };
  }

  // Calculate total estimated tokens from planned items
  const estimatedTokens = plan.plannedItems.reduce(
    (sum, item) => sum + (item.estimatedTokens ?? 0), 0,
  );
  const estimatedRequests = plan.plannedItems.length;

  // Pre-flight budget validation
  const validation = validatePlanBudget(
    { estimatedCostCents: plan.estimatedCostCents, estimatedTokens, plannedItems: plan.plannedItems },
    projectId,
    db,
  );
  if (!validation.ok) {
    return validation;
  }

  // Reserve budget
  reserveBudget(projectId, plan.estimatedCostCents, estimatedTokens, estimatedRequests, db);

  // Transition to executing with started_at timestamp
  const now = Date.now();
  db.prepare("UPDATE dispatch_plans SET status = 'executing', started_at = ? WHERE id = ? AND project_id = ? AND status = 'planned'")
    .run(now, planId, projectId);

  return { ok: true, remaining: validation.remaining };
}

export type CompletePlanParams = {
  actualResults: ActualResult[];
};

export function completePlan(projectId: string, planId: string, params: CompletePlanParams, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const actualCostCents = params.actualResults.reduce((sum, r) => sum + (r.actualCostCents ?? 0), 0);

  // Fetch plan to get reservation amounts before completing
  const plan = getPlan(projectId, planId, db);

  db.prepare(`
    UPDATE dispatch_plans
    SET status = 'completed', actual_results = ?, actual_cost_cents = ?, completed_at = ?
    WHERE id = ? AND project_id = ? AND status IN ('planned', 'executing')
  `).run(JSON.stringify(params.actualResults), actualCostCents, now, planId, projectId);

  // Release remaining reservation (only if plan was executing with reservation)
  if (plan && plan.status === "executing") {
    const estimatedTokens = plan.plannedItems.reduce(
      (sum, item) => sum + (item.estimatedTokens ?? 0), 0,
    );
    const estimatedRequests = plan.plannedItems.length;
    releasePlanReservation(projectId, plan.estimatedCostCents, estimatedTokens, estimatedRequests, db);
  }
}

export function abandonPlan(projectId: string, planId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();

  // Fetch plan to get reservation amounts before abandoning
  const plan = getPlan(projectId, planId, db);

  db.prepare("UPDATE dispatch_plans SET status = 'abandoned', completed_at = ? WHERE id = ? AND project_id = ? AND status IN ('planned', 'executing')")
    .run(now, planId, projectId);

  // Release reservation (only if plan was executing with reservation)
  if (plan && plan.status === "executing") {
    const estimatedTokens = plan.plannedItems.reduce(
      (sum, item) => sum + (item.estimatedTokens ?? 0), 0,
    );
    const estimatedRequests = plan.plannedItems.length;
    releasePlanReservation(projectId, plan.estimatedCostCents, estimatedTokens, estimatedRequests, db);
  }
}

export function listPlans(projectId: string, agentId: string, dbOverride?: DatabaseSync, limit: number = 10): DispatchPlan[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM dispatch_plans WHERE project_id = ? AND agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
  ).all(projectId, agentId, limit) as Record<string, unknown>[];
  return rows.map(rowToPlan);
}
