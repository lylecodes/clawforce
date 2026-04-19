/**
 * Clawforce — Context render functions
 *
 * Shared render functions that query SQLite and produce markdown sections.
 * Used by the assembler to build session-start context for any agent role.
 */

import type { DatabaseSync, SQLInputValue } from "../sqlite-driver.js";
import type { TaskState } from "../types.js";

export type ContextSnapshot = {
  openCount: number;
  assignedCount: number;
  inProgressCount: number;
  reviewCount: number;
  blockedCount: number;
  failedCount: number;
  doneCount: number;
  cancelledCount: number;
  escalationCount: number;
  activeWorkflows: number;
};

export function renderTaskBoard(
  db: DatabaseSync,
  projectId: string,
  maxPerSection: number,
  snapshot: ContextSnapshot = { openCount: 0, assignedCount: 0, inProgressCount: 0, reviewCount: 0, blockedCount: 0, failedCount: 0, doneCount: 0, cancelledCount: 0, escalationCount: 0, activeWorkflows: 0 },
): string {
  // Get counts by state
  const countRows = db
    .prepare(
      "SELECT state, COUNT(*) as cnt FROM tasks WHERE project_id = ? GROUP BY state",
    )
    .all(projectId) as Record<string, unknown>[];

  for (const row of countRows) {
    const state = row.state as TaskState;
    const cnt = row.cnt as number;
    switch (state) {
      case "OPEN": snapshot.openCount = cnt; break;
      case "ASSIGNED": snapshot.assignedCount = cnt; break;
      case "IN_PROGRESS": snapshot.inProgressCount = cnt; break;
      case "REVIEW": snapshot.reviewCount = cnt; break;
      case "BLOCKED": snapshot.blockedCount = cnt; break;
      case "FAILED": snapshot.failedCount = cnt; break;
      case "DONE": snapshot.doneCount = cnt; break;
      case "CANCELLED": snapshot.cancelledCount = cnt; break;
    }
  }

  const total = countRows.reduce((sum, r) => sum + (r.cnt as number), 0);

  const lines: string[] = [
    "## Work Board",
    "",
    `**Total:** ${total} | ` +
      `OPEN: ${snapshot.openCount} | ASSIGNED: ${snapshot.assignedCount} | ` +
      `IN_PROGRESS: ${snapshot.inProgressCount} | REVIEW: ${snapshot.reviewCount} | ` +
      `BLOCKED: ${snapshot.blockedCount} | FAILED: ${snapshot.failedCount} | ` +
      `DONE: ${snapshot.doneCount}`,
  ];

  // List active (non-terminal) tasks, ordered by priority then age
  const activeTasks = db
    .prepare(
      `SELECT * FROM tasks WHERE project_id = ? AND state NOT IN ('DONE', 'CANCELLED')
       ORDER BY
         CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 END,
         created_at ASC
       LIMIT ?`,
    )
    .all(projectId, maxPerSection) as Record<string, unknown>[];

  if (activeTasks.length > 0) {
    // Fetch blocking reasons for BLOCKED tasks
    const blockedIds = activeTasks
      .filter((r) => r.state === "BLOCKED")
      .map((r) => r.id as string);
    const blockReasons = new Map<string, string>();
    if (blockedIds.length > 0) {
      const placeholders = blockedIds.map(() => "?").join(",");
      const reasonRows = db
        .prepare(
          `SELECT task_id, reason FROM transitions
           WHERE task_id IN (${placeholders}) AND to_state = 'BLOCKED'
           ORDER BY created_at DESC`,
        )
        .all(...(blockedIds as SQLInputValue[])) as Record<string, unknown>[];
      // Keep only the latest reason per task
      for (const r of reasonRows) {
        const tid = r.task_id as string;
        if (!blockReasons.has(tid) && r.reason) {
          blockReasons.set(tid, r.reason as string);
        }
      }
    }

    lines.push("", "### Active Tasks", "");
    for (const row of activeTasks) {
      let line = formatTaskLine(row);
      if (row.state === "BLOCKED") {
        const reason = blockReasons.get(row.id as string);
        if (reason) line += ` — blocked: "${reason}"`;
      }
      lines.push(line);
    }
  }

  return lines.join("\n");
}

export function renderEscalations(
  db: DatabaseSync,
  projectId: string,
  maxPerSection: number,
  snapshot: ContextSnapshot = {} as ContextSnapshot,
): string | null {
  // Tasks that failed and exhausted retries, with last failure reason from transitions
  const rows = db
    .prepare(
      `SELECT t.*,
              (SELECT tr.reason FROM transitions tr
               WHERE tr.task_id = t.id AND tr.to_state = 'FAILED'
               ORDER BY tr.created_at DESC, tr.rowid DESC LIMIT 1) as failure_reason
       FROM tasks t
       WHERE t.project_id = ? AND t.state = 'FAILED' AND t.retry_count >= t.max_retries
       ORDER BY t.updated_at DESC LIMIT ?`,
    )
    .all(projectId, maxPerSection) as Record<string, unknown>[];

  snapshot.escalationCount = rows.length;
  if (rows.length === 0) return null;

  const lines = [
    "## Needs Your Attention",
    "",
    `${rows.length} task(s) have exhausted retries and need manager decision:`,
    "",
  ];
  for (const row of rows) {
    const reason = row.failure_reason as string | null;
    const reasonSuffix = reason ? ` — reason: "${reason}"` : "";
    lines.push(formatTaskLine(row) + reasonSuffix);
  }
  return lines.join("\n");
}

export function renderWorkflows(
  db: DatabaseSync,
  projectId: string,
  snapshot: ContextSnapshot = {} as ContextSnapshot,
): string | null {
  const rows = db
    .prepare(
      "SELECT * FROM workflows WHERE project_id = ? AND state = 'active' ORDER BY created_at",
    )
    .all(projectId) as Record<string, unknown>[];

  snapshot.activeWorkflows = rows.length;
  if (rows.length === 0) return null;

  const lines = ["## Active Workflows", ""];

  for (const row of rows) {
    const name = row.name as string;
    const id = row.id as string;
    const currentPhase = row.current_phase as number;
    const phases = JSON.parse(row.phases as string) as Array<{
      name: string;
      taskIds: string[];
      gateCondition?: string;
    }>;

    lines.push(`### ${name} (${id.slice(0, 8)})`);
    lines.push(`Phase ${currentPhase + 1}/${phases.length}`);

    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i]!;
      const marker = i === currentPhase ? "→" : i < currentPhase ? "✓" : " ";
      const taskCount = phase.taskIds.length;
      // Count done tasks in this phase
      let doneInPhase = 0;
      if (taskCount > 0) {
        const placeholders = phase.taskIds.map(() => "?").join(",");
        const doneRow = db
          .prepare(
            `SELECT COUNT(*) as cnt FROM tasks WHERE id IN (${placeholders}) AND state = 'DONE'`,
          )
          .get(...(phase.taskIds as SQLInputValue[])) as Record<string, unknown>;
        doneInPhase = doneRow.cnt as number;
      }
      const gate = phase.gateCondition ? `, gate: ${phase.gateCondition}` : "";
      lines.push(`  ${marker} Phase ${i + 1}: ${phase.name} (${doneInPhase}/${taskCount} done${gate})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderRecentActivity(
  db: DatabaseSync,
  projectId: string,
  maxTransitions: number,
): string | null {
  const rows = db
    .prepare(
      `SELECT t.*, tk.title as task_title FROM transitions t
       JOIN tasks tk ON t.task_id = tk.id
       WHERE tk.project_id = ?
       ORDER BY t.created_at DESC LIMIT ?`,
    )
    .all(projectId, maxTransitions) as Record<string, unknown>[];

  if (rows.length === 0) return null;

  const lines = ["## Recent Activity", ""];
  const now = Date.now();

  for (const row of rows) {
    const ago = formatTimeAgo(now - (row.created_at as number));
    const title = row.task_title as string;
    const from = row.from_state as string;
    const to = row.to_state as string;
    const actor = row.actor as string;
    const reason = row.reason as string | null;
    const reasonSuffix = reason ? ` — "${reason}"` : "";
    lines.push(`- ${ago}: **${title}** ${from}→${to} by ${actor}${reasonSuffix}`);
  }

  return lines.join("\n");
}

export function renderSweepStatus(db: DatabaseSync, projectId: string): string | null {
  const MAX_LISTED = 10;

  // Stale tasks (no update in 2 hours, not DONE/FAILED)
  const staleThreshold = Date.now() - 2 * 60 * 60 * 1000;
  const staleRows = db
    .prepare(
      `SELECT id, title, state, assigned_to, updated_at FROM tasks
       WHERE project_id = ? AND state NOT IN ('DONE', 'FAILED', 'CANCELLED') AND updated_at < ?
       ORDER BY updated_at ASC LIMIT ?`,
    )
    .all(projectId, staleThreshold, MAX_LISTED + 1) as Record<string, unknown>[];

  // Approaching deadlines (within 1 hour)
  const deadlineThreshold = Date.now() + 60 * 60 * 1000;
  const urgentRows = db
    .prepare(
      `SELECT id, title, state, assigned_to, deadline FROM tasks
       WHERE project_id = ? AND state NOT IN ('DONE', 'FAILED', 'CANCELLED') AND deadline IS NOT NULL AND deadline < ?
       ORDER BY deadline ASC LIMIT ?`,
    )
    .all(projectId, deadlineThreshold, MAX_LISTED + 1) as Record<string, unknown>[];

  if (staleRows.length === 0 && urgentRows.length === 0) return null;

  const lines = ["## Operations Status", ""];

  if (staleRows.length > 0) {
    const overflow = staleRows.length > MAX_LISTED;
    const shown = overflow ? staleRows.slice(0, MAX_LISTED) : staleRows;
    lines.push(`**${overflow ? `${MAX_LISTED}+` : staleRows.length}** stale task(s) (no update in 2h):`);
    for (const row of shown) {
      const id = (row.id as string).slice(0, 8);
      const assignee = row.assigned_to ? ` assigned:${row.assigned_to}` : "";
      const ago = formatTimeAgo(Date.now() - (row.updated_at as number));
      lines.push(`- #${id} "${row.title}" ${row.state}${assignee} last update:${ago}`);
    }
    if (overflow) lines.push(`- *(and more…)*`);
    lines.push("");
  }

  if (urgentRows.length > 0) {
    const overflow = urgentRows.length > MAX_LISTED;
    const shown = overflow ? urgentRows.slice(0, MAX_LISTED) : urgentRows;
    lines.push(`**${overflow ? `${MAX_LISTED}+` : urgentRows.length}** task(s) approaching deadline (<1h):`);
    for (const row of shown) {
      const id = (row.id as string).slice(0, 8);
      const assignee = row.assigned_to ? ` assigned:${row.assigned_to}` : "";
      const remaining = formatTimeAgo((row.deadline as number) - Date.now());
      lines.push(`- #${id} "${row.title}" ${row.state}${assignee} deadline in:${remaining}`);
    }
    if (overflow) lines.push(`- *(and more…)*`);
    lines.push("");
  }

  return lines.join("\n");
}

function formatTaskLine(row: Record<string, unknown>): string {
  const id = (row.id as string).slice(0, 8);
  const priority = row.priority as string;
  const title = row.title as string;
  const state = row.state as string;
  const assignedTo = row.assigned_to as string | null;
  const updatedAt = row.updated_at as number;
  const retryCount = row.retry_count as number;
  const maxRetries = row.max_retries as number;

  const ago = formatTimeAgo(Date.now() - updatedAt);
  const assignStr = assignedTo ? ` assigned:${assignedTo}` : "";
  const retryStr = retryCount > 0 ? ` retry:${retryCount}/${maxRetries}` : "";

  return `- [${priority}] #${id} "${title}" ${state}${assignStr}${retryStr} updated:${ago}`;
}

/**
 * Render a scoped task board filtered by the manager's department, team, or direct reports.
 * Used for managers so they only see tasks relevant to their scope.
 */
export function renderScopedTaskBoard(
  db: DatabaseSync,
  projectId: string,
  maxPerSection: number,
  scope: { department?: string; team?: string; directReports?: string[] },
): string {
  // Build WHERE conditions for scoped filtering
  const conditions: string[] = ["project_id = ?"];
  const params: SQLInputValue[] = [projectId];

  const scopeFilters: string[] = [];

  if (scope.department) {
    scopeFilters.push("department = ?");
    params.push(scope.department);
  }
  if (scope.team) {
    scopeFilters.push("team = ?");
    params.push(scope.team);
  }
  if (scope.directReports && scope.directReports.length > 0) {
    const placeholders = scope.directReports.map(() => "?").join(",");
    scopeFilters.push(`assigned_to IN (${placeholders})`);
    params.push(...scope.directReports);
  }

  // If no scope filters apply, fall back to full board
  if (scopeFilters.length === 0) {
    return renderTaskBoard(db, projectId, maxPerSection);
  }

  // Also include untagged tasks (no department, no team, unassigned) so
  // managers can triage work that hasn't been categorized yet
  scopeFilters.push("(department IS NULL AND team IS NULL AND assigned_to IS NULL)");

  // Combine scope filters with OR (show tasks matching any scope criterion)
  conditions.push(`(${scopeFilters.join(" OR ")})`);

  const whereClause = conditions.join(" AND ");

  // Get counts by state for scoped tasks
  const countRows = db
    .prepare(`SELECT state, COUNT(*) as cnt FROM tasks WHERE ${whereClause} GROUP BY state`)
    .all(...params) as Record<string, unknown>[];

  const total = countRows.reduce((sum, r) => sum + (r.cnt as number), 0);
  if (total === 0) return "## Work Board\n\nNo tasks in your scope.";

  const counts: Record<string, number> = {};
  for (const row of countRows) {
    counts[row.state as string] = row.cnt as number;
  }

  const lines: string[] = [
    "## Work Board",
    "",
    `**Total (your scope):** ${total} | ` +
      `OPEN: ${counts.OPEN ?? 0} | ASSIGNED: ${counts.ASSIGNED ?? 0} | ` +
      `IN_PROGRESS: ${counts.IN_PROGRESS ?? 0} | REVIEW: ${counts.REVIEW ?? 0} | ` +
      `BLOCKED: ${counts.BLOCKED ?? 0} | FAILED: ${counts.FAILED ?? 0} | ` +
      `DONE: ${counts.DONE ?? 0}`,
  ];

  // List active scoped tasks
  const activeTasks = db
    .prepare(
      `SELECT * FROM tasks WHERE ${whereClause} AND state NOT IN ('DONE', 'CANCELLED')
       ORDER BY
         CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 END,
         created_at ASC
       LIMIT ?`,
    )
    .all(...params, maxPerSection) as Record<string, unknown>[];

  if (activeTasks.length > 0) {
    lines.push("", "### Active Tasks", "");
    for (const row of activeTasks) {
      lines.push(formatTaskLine(row));
    }
  }

  return lines.join("\n");
}

export function formatTimeAgo(ms: number): string {
  if (ms < 60_000) return "<1m ago";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
