/**
 * Clawforce — Budget Plan Briefing Source
 *
 * Runtime budget pacing briefing injected into lead/manager context.
 * Queries budget state, task pipeline counts, calls computeBudgetPacing(),
 * and formats as actionable markdown for leads.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../../db.js";
import { safeLog } from "../../diagnostics.js";
import { computeBudgetPacing } from "../../budget/pacer.js";

export function resolveBudgetPlanSource(
  projectId: string,
  dbOverride?: DatabaseSync,
): string | null {
  if (!projectId) return null;

  try {
    const db = dbOverride ?? getDb(projectId);

    // Read project-level budget
    const budgetRow = db.prepare(
      "SELECT daily_limit_cents, daily_spent_cents, hourly_spent_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
    ).get(projectId) as { daily_limit_cents: number | null; daily_spent_cents: number; hourly_spent_cents: number } | undefined;

    if (!budgetRow || !budgetRow.daily_limit_cents || budgetRow.daily_limit_cents <= 0) {
      return "No daily budget configured — spending is unlimited. Set a budget with: pnpm cf config set budget.project.daily.cents <amount>";
    }

    const dailyLimit = budgetRow.daily_limit_cents;
    const dailySpent = budgetRow.daily_spent_cents ?? 0;
    const hourlySpent = budgetRow.hourly_spent_cents ?? 0;

    // Compute hours remaining in the day
    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setUTCHours(23, 59, 59, 999);
    const hoursRemaining = Math.max(0, (endOfDay.getTime() - now.getTime()) / (60 * 60 * 1000));

    // Compute pacing
    const pacing = computeBudgetPacing({
      dailyBudgetCents: dailyLimit,
      spentCents: dailySpent,
      hoursRemaining,
      currentHourSpentCents: hourlySpent,
    });

    // Query task pipeline counts
    const taskCounts = db.prepare(
      `SELECT state, COUNT(*) as cnt FROM tasks WHERE project_id = ? AND state IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REVIEW')
       GROUP BY state`,
    ).all(projectId) as { state: string; cnt: number }[];

    const countMap: Record<string, number> = {};
    for (const row of taskCounts) {
      countMap[row.state] = row.cnt;
    }

    const openCount = countMap["OPEN"] ?? 0;
    const assignedCount = countMap["ASSIGNED"] ?? 0;
    const inProgressCount = countMap["IN_PROGRESS"] ?? 0;
    const reviewCount = countMap["REVIEW"] ?? 0;

    // Estimate worker session capacity
    const workerSessionCostCents = 30; // default
    const remaining = Math.max(0, dailyLimit - dailySpent);
    const estimatedWorkerSessions = pacing.canDispatchWorker
      ? Math.floor(remaining / workerSessionCostCents)
      : 0;

    // Format as markdown
    const fmtDollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

    const lines: string[] = [
      "## Budget Plan",
      "",
      `Daily budget: ${fmtDollars(dailyLimit)} | Spent: ${fmtDollars(dailySpent)} | Remaining: ${fmtDollars(remaining)}`,
      `Reserve: ${fmtDollars(pacing.reactiveReserve)} | Hourly rate: ${fmtDollars(pacing.hourlyRate)}/hr`,
      "",
      "### Pipeline Status",
      `- OPEN: ${openCount}`,
      `- ASSIGNED: ${assignedCount}`,
      `- IN_PROGRESS: ${inProgressCount}`,
      `- REVIEW: ${reviewCount}`,
      "",
      "### Dispatch Status",
      `- Worker dispatch: ${pacing.canDispatchWorker ? "ALLOWED" : "BLOCKED"}`,
      `- Lead dispatch: ${pacing.canDispatchLead ? "ALLOWED" : "BLOCKED"}`,
      `- Estimated worker sessions remaining: ~${estimatedWorkerSessions}`,
    ];

    if (pacing.paceDelay > 0) {
      lines.push(`- Pace delay: ${Math.round(pacing.paceDelay / 1000)}s (throttling active)`);
    }

    lines.push("");
    lines.push(`**Recommendation:** ${pacing.recommendation}`);

    return lines.join("\n");
  } catch (err) {
    safeLog("budget-plan", `Failed to generate budget plan: ${err}`);
    return null;
  }
}
