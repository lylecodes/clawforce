/**
 * Clawforce — Resources context source
 *
 * Renders capacity report (budget + rate limits + projections)
 * as markdown for manager briefing.
 */

import type { DatabaseSync } from "../../sqlite-driver.js";
import { getCapacityReport } from "../../capacity.js";

export function buildResourcesContext(
  projectId: string,
  agentId?: string,
  dbOverride?: DatabaseSync,
): string | null {
  const report = getCapacityReport(projectId, agentId, dbOverride);

  // Don't render if no budget data and no provider rate limit concerns
  const hasBudget = !!(report.budget.daily || report.budget.hourly || report.budget.monthly);
  const hasProviders = report.providers.length > 0;
  if (!hasBudget && !hasProviders) {
    return null;
  }

  const lines = ["## Resource Capacity\n"];

  // Budget windows
  for (const w of [report.budget.hourly, report.budget.daily, report.budget.monthly]) {
    if (!w) continue;
    const label = w.window.charAt(0).toUpperCase() + w.window.slice(1);
    lines.push(
      `**${label}:** $${(w.remainingCents / 100).toFixed(2)} remaining of $${(w.limitCents / 100).toFixed(2)} (${w.usedPercent}% used)`,
    );
  }

  // Estimated remaining sessions
  if (report.estimatedRemainingSessions != null) {
    lines.push(
      `**Projected capacity:** ~${report.estimatedRemainingSessions} remaining sessions (avg $${((report.avgSessionCostCents ?? 0) / 100).toFixed(2)}/session)`,
    );
  }

  // Provider rate limits
  if (report.providers.length > 0) {
    lines.push("", "### Provider Rate Limits");
    for (const p of report.providers) {
      const windowStr = p.windows.map(w => `${w.label}: ${w.usedPercent}%`).join(", ");
      const planStr = p.plan ? ` (${p.plan})` : "";
      lines.push(`- **${p.provider}**${planStr}: ${windowStr}`);
    }
  }

  // Throttle risk
  if (report.throttleRisk === "critical") {
    lines.push("", "**THROTTLE RISK: CRITICAL** — Rate limits nearly exhausted. Reduce dispatch concurrency.");
  } else if (report.throttleRisk === "warning") {
    lines.push("", "**THROTTLE RISK: WARNING** — Approaching rate limits. Consider spacing dispatches.");
  }

  // Budget alerts
  if (report.budget.alerts.length > 0) {
    lines.push("", "### Budget Alerts");
    for (const alert of report.budget.alerts) {
      lines.push(`- ${alert}`);
    }
  }

  return lines.join("\n");
}
