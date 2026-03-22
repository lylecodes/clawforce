/**
 * Clawforce — ClawForce health report context source
 *
 * Aggregates telemetry metrics, TODO/FIXME counts, and unimplemented specs
 * into a compact markdown report (under 2KB).
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../../db.js";

/**
 * Recursively walk a directory and return all matching file paths.
 */
function walkDir(dir: string, pattern: RegExp): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules and hidden directories
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      results.push(...walkDir(fullPath, pattern));
    } else if (pattern.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Count TODO/FIXME occurrences in TypeScript source files.
 */
function countTodos(projectDir: string): number {
  const srcDir = path.join(projectDir, "src");
  const files = walkDir(srcDir, /\.ts$/);
  let count = 0;
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, "utf-8");
      const matches = content.match(/\bTODO\b|\bFIXME\b/g);
      if (matches) count += matches.length;
    } catch {
      // skip unreadable files
    }
  }
  return count;
}

/**
 * List unimplemented spec files from docs/superpowers/specs/.
 */
function listUnimplementedSpecs(projectDir: string): string[] {
  const specsDir = path.join(projectDir, "docs", "superpowers", "specs");
  try {
    return fs.readdirSync(specsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

/**
 * Build a compact health report for ClawForce itself.
 *
 * Collects telemetry from the project DB and source-level metrics,
 * rendering as markdown under 2KB.
 */
export function buildClawforceHealthReport(
  projectId: string,
  projectDir?: string,
  dbOverride?: DatabaseSync,
): string | null {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const oneDayAgo = now - 86_400_000;

  const lines: string[] = ["## ClawForce Health Report", ""];

  // --- Telemetry metrics ---

  // Session compliance rate from audit_runs
  const auditRows = db.prepare(`
    SELECT status, COUNT(*) as cnt
    FROM audit_runs
    WHERE project_id = ? AND ended_at > ?
    GROUP BY status
  `).all(projectId, oneDayAgo) as Record<string, unknown>[];

  let totalSessions = 0;
  let compliantSessions = 0;
  for (const row of auditRows) {
    const cnt = row.cnt as number;
    totalSessions += cnt;
    if (row.status === "compliant" || row.status === "pass") {
      compliantSessions += cnt;
    }
  }
  const complianceRate = totalSessions > 0
    ? Math.round((compliantSessions / totalSessions) * 100)
    : 0;

  // Task completion rate
  const taskRows = db.prepare(`
    SELECT state, COUNT(*) as cnt
    FROM tasks
    WHERE project_id = ?
    GROUP BY state
  `).all(projectId) as Record<string, unknown>[];

  let totalTasks = 0;
  let doneTasks = 0;
  for (const row of taskRows) {
    const cnt = row.cnt as number;
    totalTasks += cnt;
    if (row.state === "DONE") {
      doneTasks += cnt;
    }
  }
  const completionRate = totalTasks > 0
    ? Math.round((doneTasks / totalTasks) * 100)
    : 0;

  // Average cost per session
  const costRow = db.prepare(`
    SELECT AVG(cost_cents) as avg_cost, COUNT(*) as cnt
    FROM cost_records
    WHERE project_id = ? AND created_at > ?
  `).get(projectId, oneDayAgo) as Record<string, unknown> | undefined;

  const avgCostCents = costRow && (costRow.cnt as number) > 0
    ? (costRow.avg_cost as number)
    : 0;
  const avgCostDollars = (avgCostCents / 100).toFixed(2);

  // Evidence capture rate (tasks with evidence / total non-OPEN tasks)
  const evidenceRow = db.prepare(`
    SELECT COUNT(DISTINCT e.task_id) as with_evidence
    FROM evidence e
    JOIN tasks t ON e.task_id = t.id
    WHERE t.project_id = ? AND t.state != 'OPEN'
  `).get(projectId) as Record<string, unknown> | undefined;

  const tasksWithEvidence = evidenceRow ? (evidenceRow.with_evidence as number) : 0;
  const nonOpenTasks = totalTasks - (taskRows.find((r) => r.state === "OPEN")?.cnt as number ?? 0);
  const evidenceRate = nonOpenTasks > 0
    ? Math.round((tasksWithEvidence / nonOpenTasks) * 100)
    : 0;

  // Summary line
  lines.push(`**Compliance:** ${complianceRate}% | **Completion:** ${completionRate}% | **Avg cost:** $${avgCostDollars}/session`);

  // TODO count
  let todoCount = 0;
  if (projectDir) {
    todoCount = countTodos(projectDir);
  }
  lines.push(`**Evidence rate:** ${evidenceRate}% | **TODOs:** ${todoCount}`);
  lines.push("");

  // --- Recent issues from audit data ---
  const issueRows = db.prepare(`
    SELECT agent_id, status, summary
    FROM audit_runs
    WHERE project_id = ? AND ended_at > ? AND status != 'compliant' AND status != 'pass'
    ORDER BY ended_at DESC LIMIT 5
  `).all(projectId, oneDayAgo) as Record<string, unknown>[];

  if (issueRows.length > 0) {
    lines.push("### Recent Issues");
    for (const row of issueRows) {
      const summary = row.summary
        ? String(row.summary).slice(0, 100)
        : row.status;
      lines.push(`- **${row.agent_id}**: ${summary}`);
    }
    lines.push("");
  }

  // --- Unimplemented specs ---
  if (projectDir) {
    const specs = listUnimplementedSpecs(projectDir);
    if (specs.length > 0) {
      lines.push("### Unimplemented Specs");
      for (const spec of specs) {
        lines.push(`- ${spec}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
