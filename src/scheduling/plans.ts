/**
 * Clawforce — Dispatch Plan CRUD
 *
 * Coordination agents create a plan per wake cycle, track execution,
 * and review actual vs. planned on completion.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import type { ActualResult, DispatchPlan, DispatchPlanStatus, PlannedItem } from "../types.js";

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

export function startPlan(projectId: string, planId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare("UPDATE dispatch_plans SET status = 'executing' WHERE id = ? AND project_id = ? AND status = 'planned'")
    .run(planId, projectId);
}

export type CompletePlanParams = {
  actualResults: ActualResult[];
};

export function completePlan(projectId: string, planId: string, params: CompletePlanParams, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const actualCostCents = params.actualResults.reduce((sum, r) => sum + (r.actualCostCents ?? 0), 0);

  db.prepare(`
    UPDATE dispatch_plans
    SET status = 'completed', actual_results = ?, actual_cost_cents = ?, completed_at = ?
    WHERE id = ? AND project_id = ? AND status IN ('planned', 'executing')
  `).run(JSON.stringify(params.actualResults), actualCostCents, now, planId, projectId);
}

export function abandonPlan(projectId: string, planId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  db.prepare("UPDATE dispatch_plans SET status = 'abandoned', completed_at = ? WHERE id = ? AND project_id = ? AND status IN ('planned', 'executing')")
    .run(now, planId, projectId);
}

export function listPlans(projectId: string, agentId: string, dbOverride?: DatabaseSync, limit: number = 10): DispatchPlan[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM dispatch_plans WHERE project_id = ? AND agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
  ).all(projectId, agentId, limit) as Record<string, unknown>[];
  return rows.map(rowToPlan);
}
