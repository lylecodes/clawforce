/**
 * Clawforce — Budget enforcement
 *
 * Manages per-project and per-agent budgets.
 * Checks spending against limits before dispatch.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db.js";
import { safeLog } from "./diagnostics.js";
import { checkBudgetV2 } from "./budget/check-v2.js";
import type { BudgetCheckResult, BudgetConfig } from "./types.js";

/**
 * Set or update a budget for a project or agent.
 */
export function setBudget(
  params: {
    projectId: string;
    agentId?: string;
    config: BudgetConfig;
  },
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(params.projectId);
  const now = Date.now();
  const nextMidnight = getNextMidnight(now);

  // Upsert: check if budget exists
  const existing = db.prepare(
    params.agentId
      ? "SELECT id FROM budgets WHERE project_id = ? AND agent_id = ?"
      : "SELECT id FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(...(params.agentId ? [params.projectId, params.agentId] : [params.projectId])) as Record<string, unknown> | undefined;

  if (existing) {
    db.prepare(`
      UPDATE budgets SET
        daily_limit_cents = ?, session_limit_cents = ?, task_limit_cents = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      params.config.dailyLimitCents ?? null,
      params.config.sessionLimitCents ?? null,
      params.config.taskLimitCents ?? null,
      now,
      existing.id as string,
    );
  } else {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, session_limit_cents, task_limit_cents,
        daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      id,
      params.projectId,
      params.agentId ?? null,
      params.config.dailyLimitCents ?? null,
      params.config.sessionLimitCents ?? null,
      params.config.taskLimitCents ?? null,
      nextMidnight,
      now,
      now,
    );
  }
}

/**
 * Check if an agent/project is within budget.
 * Delegates time-window checks (hourly/daily/monthly) to checkBudgetV2 (O(1)).
 * Keeps session/task per-record checks (bounded O(n) scope).
 * Returns { ok: true } if within budget or no budget set.
 */
export function checkBudget(
  params: {
    projectId: string;
    agentId?: string;
    taskId?: string;
    sessionKey?: string;
  },
  dbOverride?: DatabaseSync,
): BudgetCheckResult {
  const db = dbOverride ?? getDb(params.projectId);

  // Time-window checks via v2 (O(1) counter-based)
  const v2Result = checkBudgetV2({ projectId: params.projectId, agentId: params.agentId }, db);
  if (!v2Result.ok) return v2Result;

  // Session/task per-record checks (bounded scope)
  const perRecordResult = evaluatePerRecordBudget(params, db);
  if (!perRecordResult.ok) return perRecordResult;

  return { ok: true, remaining: v2Result.remaining };
}

function evaluatePerRecordBudget(
  params: { projectId: string; agentId?: string; taskId?: string; sessionKey?: string },
  db: DatabaseSync,
): BudgetCheckResult {
  // Get budget rows to check task/session limits
  const budgets: Array<Record<string, unknown>> = [];

  if (params.agentId) {
    const agentBudget = db.prepare(
      "SELECT * FROM budgets WHERE project_id = ? AND agent_id = ?",
    ).get(params.projectId, params.agentId) as Record<string, unknown> | undefined;
    if (agentBudget) budgets.push(agentBudget);
  }

  const projectBudget = db.prepare(
    "SELECT * FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(params.projectId) as Record<string, unknown> | undefined;
  if (projectBudget) budgets.push(projectBudget);

  for (const budget of budgets) {
    const taskLimit = budget.task_limit_cents as number | null;
    const sessionLimit = budget.session_limit_cents as number | null;

    // Task limit check
    if (taskLimit !== null && params.taskId) {
      const taskRow = db.prepare(
        "SELECT COALESCE(SUM(cost_cents), 0) as spent FROM cost_records WHERE project_id = ? AND task_id = ?",
      ).get(params.projectId, params.taskId) as Record<string, unknown>;
      const taskSpent = taskRow.spent as number;
      if (taskSpent >= taskLimit) {
        return {
          ok: false,
          remaining: 0,
          reason: `Task budget exceeded: spent ${taskSpent} cents of ${taskLimit} cents limit`,
        };
      }
    }

    // Session limit check
    if (sessionLimit !== null && params.sessionKey) {
      const sessionRow = db.prepare(
        "SELECT COALESCE(SUM(cost_cents), 0) as spent FROM cost_records WHERE project_id = ? AND session_key = ?",
      ).get(params.projectId, params.sessionKey) as Record<string, unknown>;
      const sessionSpent = sessionRow.spent as number;
      if (sessionSpent >= sessionLimit) {
        return {
          ok: false,
          remaining: 0,
          reason: `Session budget exceeded: spent ${sessionSpent} cents of ${sessionLimit} cents limit`,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Reset daily budget counters for all budgets past their reset time.
 */
export function resetDailyBudgets(
  projectId: string,
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const nextMidnight = getNextMidnight(now);

  const result = db.prepare(`
    UPDATE budgets SET daily_spent_cents = 0, daily_reset_at = ?, updated_at = ?
    WHERE project_id = ? AND daily_reset_at <= ?
  `).run(nextMidnight, now, projectId, now);

  return Number(result.changes);
}

function getNextMidnight(now: number): number {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}
