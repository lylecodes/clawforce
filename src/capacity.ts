/**
 * Clawforce — Capacity planner
 *
 * Combines budget status + rate limit data + historical cost
 * into a forward-looking capacity report for manager briefing.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db.js";
import { getBudgetStatus, type BudgetStatus } from "./budget-windows.js";
import { getAllProviderUsage, type ProviderUsage } from "./rate-limits.js";

export type ThrottleRisk = "none" | "warning" | "critical";

export type CapacityReport = {
  budget: BudgetStatus;
  providers: ProviderUsage[];
  throttleRisk: ThrottleRisk;
  estimatedRemainingSessions?: number;
  avgSessionCostCents?: number;
};

/**
 * Build a capacity report for a project.
 */
export function getCapacityReport(
  projectId: string,
  agentId?: string,
  dbOverride?: DatabaseSync,
): CapacityReport {
  const db = dbOverride ?? getDb(projectId);
  const budget = getBudgetStatus(projectId, agentId, db);
  const providers = getAllProviderUsage();

  // Determine throttle risk from provider usage
  let throttleRisk: ThrottleRisk = "none";
  for (const p of providers) {
    for (const w of p.windows) {
      if (w.usedPercent >= 95) {
        throttleRisk = "critical";
        break;
      }
      if (w.usedPercent >= 80) {
        throttleRisk = "warning";
      }
    }
    if (throttleRisk === "critical") break;
  }

  // Estimate remaining sessions from historical average using tightest budget window
  const avgCost = getAverageSessionCost(projectId, db);
  let estimatedRemainingSessions: number | undefined;
  if (avgCost > 0) {
    const windowRemaining = [budget.hourly, budget.daily, budget.monthly]
      .filter(Boolean)
      .map(w => w!.remainingCents);
    if (windowRemaining.length > 0) {
      const tightest = Math.min(...windowRemaining);
      estimatedRemainingSessions = Math.floor(tightest / avgCost);
    }
  }

  return {
    budget,
    providers,
    throttleRisk,
    estimatedRemainingSessions,
    avgSessionCostCents: avgCost > 0 ? avgCost : undefined,
  };
}

/**
 * Calculate average cost per dispatch session from recent history.
 * Uses last 24 hours of records, grouped by session.
 */
function getAverageSessionCost(
  projectId: string,
  db: DatabaseSync,
): number {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const row = db.prepare(`
    SELECT COUNT(DISTINCT session_key) as sessions, COALESCE(SUM(cost_cents), 0) as total
    FROM cost_records
    WHERE project_id = ? AND created_at >= ? AND session_key IS NOT NULL
  `).get(projectId, since) as Record<string, unknown>;

  const sessions = row.sessions as number;
  const total = row.total as number;
  if (sessions === 0) return 0;
  return Math.round(total / sessions);
}
