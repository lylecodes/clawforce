/**
 * Clawforce — Cost summary context source
 *
 * Renders project/agent cost breakdown as markdown for context injection.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../../db.js";
import { getCostSummary } from "../../cost.js";

/**
 * Build cost summary markdown for a project/agent.
 */
export function buildCostSummary(
  projectId: string,
  agentId?: string,
  dbOverride?: DatabaseSync,
): string | null {
  const db = dbOverride ?? getDb(projectId);

  const now = Date.now();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);

  // Overall project cost
  const projectTotal = getCostSummary({ projectId }, db);
  if (projectTotal.recordCount === 0) return null;

  const todayCost = getCostSummary({ projectId, since: todayStart.getTime() }, db);

  const lines = [
    "## Cost Summary\n",
    `**Project total:** $${(projectTotal.totalCostCents / 100).toFixed(2)} (${projectTotal.recordCount} dispatches)`,
    `**Today:** $${(todayCost.totalCostCents / 100).toFixed(2)} (${todayCost.recordCount} dispatches)`,
  ];

  // Budget status
  const budget = db.prepare(
    "SELECT daily_limit_cents, daily_spent_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(projectId) as Record<string, unknown> | undefined;

  if (budget && budget.daily_limit_cents) {
    const limit = budget.daily_limit_cents as number;
    const spent = budget.daily_spent_cents as number;
    const pct = Math.round((spent / limit) * 100);
    lines.push(`**Daily budget:** ${pct}% used ($${(spent / 100).toFixed(2)} / $${(limit / 100).toFixed(2)})`);
  }

  // Per-agent breakdown (top 5)
  const agentRows = db.prepare(`
    SELECT agent_id, SUM(cost_cents) as total, COUNT(*) as cnt
    FROM cost_records WHERE project_id = ?
    GROUP BY agent_id ORDER BY total DESC LIMIT 5
  `).all(projectId) as Record<string, unknown>[];

  if (agentRows.length > 1) {
    lines.push("", "### By Agent");
    for (const row of agentRows) {
      lines.push(`- \`${row.agent_id}\`: $${((row.total as number) / 100).toFixed(2)} (${row.cnt} dispatches)`);
    }
  }

  return lines.join("\n");
}
