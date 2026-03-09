/**
 * Clawforce — Multi-window budget tracking
 *
 * Extends budget enforcement to hourly, daily, and monthly windows.
 * Provides budget status with remaining capacity and alert thresholds.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db.js";
import type { BudgetCheckResult } from "./types.js";

export type WindowStatus = {
  window: "hourly" | "daily" | "monthly";
  limitCents: number;
  spentCents: number;
  remainingCents: number;
  usedPercent: number;
};

export type BudgetStatus = {
  hourly?: WindowStatus;
  daily?: WindowStatus;
  monthly?: WindowStatus;
  alerts: string[];
};

const ALERT_THRESHOLD = 75; // percent

function getWindowStart(window: "hourly" | "daily" | "monthly", now: number): number {
  const d = new Date(now);
  if (window === "hourly") {
    d.setMinutes(0, 0, 0);
  } else if (window === "daily") {
    d.setUTCHours(0, 0, 0, 0);
  } else {
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
  }
  return d.getTime();
}

function getSpentInWindow(
  projectId: string,
  agentId: string | undefined,
  windowStart: number,
  db: DatabaseSync,
): number {
  let sql = "SELECT COALESCE(SUM(cost_cents), 0) as spent FROM cost_records WHERE project_id = ? AND created_at >= ?";
  const params: (string | number)[] = [projectId, windowStart];
  if (agentId) {
    sql += " AND agent_id = ?";
    params.push(agentId);
  }
  const row = db.prepare(sql).get(...params) as Record<string, unknown>;
  return row.spent as number;
}

export function getBudgetStatus(
  projectId: string,
  agentId?: string,
  dbOverride?: DatabaseSync,
): BudgetStatus {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const alerts: string[] = [];

  const budget = db.prepare(
    agentId
      ? "SELECT * FROM budgets WHERE project_id = ? AND agent_id = ?"
      : "SELECT * FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(...(agentId ? [projectId, agentId] : [projectId])) as Record<string, unknown> | undefined;

  if (!budget) return { alerts };

  const result: BudgetStatus = { alerts };

  const windows: Array<{ key: "hourly" | "daily" | "monthly"; limitCol: string }> = [
    { key: "hourly", limitCol: "hourly_limit_cents" },
    { key: "daily", limitCol: "daily_limit_cents" },
    { key: "monthly", limitCol: "monthly_limit_cents" },
  ];

  for (const w of windows) {
    const limit = budget[w.limitCol] as number | null;
    if (limit == null) continue;

    const windowStart = getWindowStart(w.key, now);
    const spent = w.key === "daily"
      ? (budget.daily_spent_cents as number)  // use tracked counter for daily
      : getSpentInWindow(projectId, agentId, windowStart, db);

    const remaining = Math.max(0, limit - spent);
    const pct = Math.round((spent / limit) * 100);

    result[w.key] = { window: w.key, limitCents: limit, spentCents: spent, remainingCents: remaining, usedPercent: pct };

    if (pct >= ALERT_THRESHOLD) {
      alerts.push(`${w.key.charAt(0).toUpperCase() + w.key.slice(1)} budget ${pct}% consumed`);
    }
  }

  return result;
}

export function checkMultiWindowBudget(
  params: { projectId: string; agentId?: string },
  dbOverride?: DatabaseSync,
): BudgetCheckResult {
  const status = getBudgetStatus(params.projectId, params.agentId, dbOverride);

  for (const w of [status.hourly, status.daily, status.monthly]) {
    if (w && w.remainingCents <= 0) {
      return {
        ok: false,
        remaining: 0,
        reason: `${w.window.charAt(0).toUpperCase() + w.window.slice(1)} budget exceeded: spent ${w.spentCents} cents of ${w.limitCents} cents limit`,
      };
    }
  }

  const minRemaining = [status.hourly, status.daily, status.monthly]
    .filter(Boolean)
    .map(w => w!.remainingCents);

  return {
    ok: true,
    remaining: minRemaining.length > 0 ? Math.min(...minRemaining) : undefined,
  };
}
