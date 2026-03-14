/**
 * Clawforce — Budget Guidance Briefing Source
 *
 * Runtime budget guidance injected into manager reflection.
 * Uses historical cost data when available, model estimates when fresh.
 */

import { getDb } from "../../db.js";
import { safeLog } from "../../diagnostics.js";

export function resolveBudgetGuidanceSource(
  projectId: string,
  params: Record<string, unknown> | undefined,
): string | null {
  if (!projectId) return null;

  try {
    const db = getDb(projectId);

    // Get today's spend
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    const spendRow = db.prepare(`
      SELECT COALESCE(SUM(cost_cents), 0) as spent
      FROM cost_records
      WHERE project_id = ? AND created_at >= ?
    `).get(projectId, todayMs) as { spent: number } | undefined;

    const spent = spendRow?.spent ?? 0;

    // Get daily budget from budgets table (project-level = agent_id IS NULL)
    const budgetRow = db.prepare(
      `SELECT daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL`,
    ).get(projectId) as { daily_limit_cents: number } | undefined;

    if (!budgetRow) return null;
    const dailyBudget = budgetRow.daily_limit_cents;
    if (!dailyBudget || dailyBudget <= 0) return null;

    const utilization = Math.round((spent / dailyBudget) * 100);
    const remaining = dailyBudget - spent;

    // Estimate sessions remaining based on average session cost
    const avgRow = db.prepare(`
      SELECT COALESCE(AVG(cost_cents), 0) as avg_cost, COUNT(*) as count
      FROM cost_records
      WHERE project_id = ? AND created_at >= ? AND cost_cents > 0
    `).get(projectId, todayMs) as { avg_cost: number; count: number } | undefined;

    const avgCost = avgRow?.avg_cost ?? 0;
    const sessionsRemaining = avgCost > 0 ? Math.floor(remaining / avgCost) : 0;

    // Estimate exhaustion time
    let exhaustionNote = "";
    if (avgRow && avgRow.count >= 2 && avgCost > 0) {
      const hoursElapsed = (Date.now() - todayMs) / 3600000;
      if (hoursElapsed > 0) {
        const burnRate = spent / hoursElapsed;
        if (burnRate > 0) {
          const hoursRemaining = remaining / burnRate;
          const exhaustionHour = new Date(Date.now() + hoursRemaining * 3600000);
          exhaustionNote = ` At current velocity, exhausts by ${exhaustionHour.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`;
        }
      }
    }

    const lines = [
      "## Budget Guidance",
      "",
      `Budget utilization: ${utilization}% ($${(spent / 100).toFixed(2)} of $${(dailyBudget / 100).toFixed(2)}).${exhaustionNote}`,
    ];

    if (sessionsRemaining > 0) {
      lines.push(`Estimated sessions remaining: ~${sessionsRemaining}.`);
    }

    return lines.join("\n");
  } catch (err) {
    safeLog("budget-guidance", `Failed to generate budget guidance: ${err}`);
    return null;
  }
}
