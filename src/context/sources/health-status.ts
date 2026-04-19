/**
 * Clawforce — Health status context source
 *
 * Renders SLO compliance, recent alerts, and anomalies as markdown.
 */

import type { DatabaseSync } from "../../sqlite-driver.js";
import { getDb } from "../../db.js";
import { computeHealthTier } from "../../monitoring/health-tier.js";

/**
 * Build health status markdown for a project.
 */
export function buildHealthStatus(
  projectId: string,
  dbOverride?: DatabaseSync,
): string | null {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const oneHourAgo = now - 3600000;

  const lines: string[] = [];

  // Collect data for health tier computation
  let sloBreachCount = 0;
  let sloCheckedCount = 0;
  let alertCount = 0;

  // Recent SLO evaluations
  const sloRows = db.prepare(`
    SELECT slo_name, passed, actual, threshold, evaluated_at
    FROM slo_evaluations WHERE project_id = ? AND evaluated_at > ?
    ORDER BY evaluated_at DESC LIMIT 20
  `).all(projectId, oneHourAgo) as Record<string, unknown>[];

  if (sloRows.length > 0) {
    // Group by SLO name, show latest evaluation
    const seen = new Set<string>();
    const sloLines: string[] = [];
    for (const row of sloRows) {
      const name = row.slo_name as string;
      if (seen.has(name)) continue;
      seen.add(name);

      const passed = row.passed as number;
      const actual = row.actual as number | null;
      const threshold = row.threshold as number;
      const icon = passed ? "OK" : "BREACH";
      const actualStr = actual !== null ? actual.toFixed(2) : "N/A";
      sloLines.push(`- **${name}**: ${icon} (actual: ${actualStr}, threshold: ${threshold})`);

      sloCheckedCount++;
      if (!passed) sloBreachCount++;
    }

    lines.push("### SLO Compliance\n");
    lines.push(...sloLines);
    lines.push("");
  }

  // Recent alerts
  const alertRows = db.prepare(`
    SELECT name, last_fired_at FROM alert_rules
    WHERE project_id = ? AND last_fired_at IS NOT NULL AND last_fired_at > ?
    ORDER BY last_fired_at DESC LIMIT 10
  `).all(projectId, oneHourAgo) as Record<string, unknown>[];

  if (alertRows.length > 0) {
    alertCount = alertRows.length;
    lines.push("### Recent Alerts\n");
    for (const row of alertRows) {
      const minutesAgo = Math.round((now - (row.last_fired_at as number)) / 60000);
      lines.push(`- **${row.name}**: fired ${minutesAgo}m ago`);
    }
    lines.push("");
  }

  if (lines.length === 0) return null;

  // Compute and prepend overall health tier
  const healthTier = computeHealthTier({
    sloChecked: sloCheckedCount,
    sloBreach: sloBreachCount,
    alertsFired: alertCount,
    anomaliesDetected: 0,
  });
  lines.unshift(`## Health Status\n\n**Overall Health: ${healthTier}**\n`);

  return lines.join("\n");
}
