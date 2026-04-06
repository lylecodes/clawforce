/**
 * Clawforce — Attention Item Builder
 *
 * Scans current domain state and builds a prioritized list of attention items.
 * Designed to be cheap — reuses existing query functions, never throws.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { listPendingProposals } from "../approval/resolve.js";
import { getBudgetStatus } from "../budget-windows.js";
import { isEmergencyStopActive } from "../safety.js";
import { listTasks } from "../tasks/ops.js";
import { listRecentChanges } from "../history/store.js";
import type { AttentionItem, AttentionSummary, AttentionUrgency } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${_idCounter++}`;
}

function item(
  projectId: string,
  urgency: AttentionUrgency,
  category: string,
  title: string,
  summary: string,
  destination: string,
  focusContext?: Record<string, string>,
  metadata?: Record<string, unknown>,
): AttentionItem {
  return {
    id: makeId(category),
    projectId,
    urgency,
    category,
    title,
    summary,
    destination,
    focusContext,
    detectedAt: Date.now(),
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

function detectApprovals(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const proposals = listPendingProposals(projectId);
    for (const p of proposals) {
      items.push(item(
        projectId,
        "action-needed",
        "approval",
        `Approval required: ${p.title}`,
        p.description ?? `Proposed by ${p.proposed_by}`,
        "/approvals",
        { proposalId: p.id },
        { proposalId: p.id, riskTier: p.risk_tier ?? undefined },
      ));
    }
  } catch { /* DB may not exist */ }
}

function detectReviewTasks(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const reviewTasks = listTasks(projectId, { state: "REVIEW" });
    for (const t of reviewTasks) {
      items.push(item(
        projectId,
        "action-needed",
        "task",
        `Task awaiting review: ${t.title ?? t.id}`,
        "Task is in REVIEW state and needs a human decision",
        "/tasks",
        { taskId: t.id },
        { taskId: t.id, assignedTo: t.assignedTo ?? undefined },
      ));
    }
  } catch { /* tasks table may not exist */ }
}

function detectBudget(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const status = getBudgetStatus(projectId, undefined, db);
    for (const window of ["hourly", "daily", "monthly"] as const) {
      const w = status[window];
      if (!w) continue;
      if (w.usedPercent >= 90) {
        items.push(item(
          projectId,
          "action-needed",
          "budget",
          `${window.charAt(0).toUpperCase() + window.slice(1)} budget critical (${w.usedPercent}%)`,
          `${w.spentCents} of ${w.limitCents} cents used in ${window} window`,
          "/config",
          { section: "budget" },
          { window, usedPercent: w.usedPercent, spentCents: w.spentCents, limitCents: w.limitCents },
        ));
      } else if (w.usedPercent >= 70) {
        items.push(item(
          projectId,
          "watching",
          "budget",
          `${window.charAt(0).toUpperCase() + window.slice(1)} budget elevated (${w.usedPercent}%)`,
          `${w.spentCents} of ${w.limitCents} cents used in ${window} window`,
          "/config",
          { section: "budget" },
          { window, usedPercent: w.usedPercent, spentCents: w.spentCents, limitCents: w.limitCents },
        ));
      }
    }
  } catch { /* budget table may not exist */ }
}

function detectKillSwitch(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    if (isEmergencyStopActive(projectId, db)) {
      items.push(item(
        projectId,
        "action-needed",
        "health",
        "Emergency stop is active",
        "All agent tool calls are blocked. Resume when safe.",
        "/ops",
      ));
    }
  } catch { /* ignore */ }
}

function detectUnreadMessages(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    // Query for messages addressed to "user" pseudo-agent that are unread
    const rows = db.prepare(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE project_id = ? AND to_agent = 'user' AND status = 'delivered'`,
    ).get(projectId) as { cnt: number } | undefined;
    const count = rows?.cnt ?? 0;
    if (count > 0) {
      items.push(item(
        projectId,
        "action-needed",
        "comms",
        `${count} unread message${count === 1 ? "" : "s"} from agents`,
        "Agents have sent messages awaiting your attention",
        "/comms",
        undefined,
        { count },
      ));
    }
  } catch { /* messaging table may not exist */ }
}

function detectStaleTasks(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const now = Date.now();
    const rows = db.prepare(
      `SELECT id, title, deadline FROM tasks
       WHERE project_id = ? AND deadline IS NOT NULL AND deadline < ?
         AND state NOT IN ('DONE','CANCELLED')`,
    ).all(projectId, now) as Array<{ id: string; title: string | null; deadline: number }>;

    for (const t of rows) {
      items.push(item(
        projectId,
        "action-needed",
        "task",
        `Overdue task: ${t.title ?? t.id}`,
        `Deadline passed ${Math.round((now - t.deadline) / 3_600_000)}h ago`,
        "/tasks",
        { taskId: t.id },
        { taskId: t.id, deadline: t.deadline },
      ));
    }
  } catch { /* tasks table may not exist */ }
}

function detectHighCostRunningTasks(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    // Tasks in active states with associated cost records summing to >$1 (100 cents)
    const THRESHOLD_CENTS = 100;
    const rows = db.prepare(
      `SELECT t.id, t.title, COALESCE(SUM(c.cost_cents), 0) as total_cost
       FROM tasks t
       LEFT JOIN cost_records c ON c.project_id = t.project_id AND c.task_id = t.id
       WHERE t.project_id = ? AND t.state IN ('OPEN','IN_PROGRESS')
       GROUP BY t.id
       HAVING total_cost > ?`,
    ).all(projectId, THRESHOLD_CENTS) as Array<{ id: string; title: string | null; total_cost: number }>;

    for (const t of rows) {
      items.push(item(
        projectId,
        "watching",
        "task",
        `High-cost running task: ${t.title ?? t.id}`,
        `$${(t.total_cost / 100).toFixed(2)} spent on active task`,
        "/tasks",
        { taskId: t.id },
        { taskId: t.id, totalCostCents: t.total_cost },
      ));
    }
  } catch { /* ignore */ }
}

function detectRecentFailedTasks(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const since = Date.now() - 24 * 3_600_000;
    const rows = db.prepare(
      `SELECT id, title, updated_at FROM tasks
       WHERE project_id = ? AND state = 'CANCELLED' AND updated_at >= ?
       ORDER BY updated_at DESC`,
    ).all(projectId, since) as Array<{ id: string; title: string | null; updated_at: number }>;

    // Also check tasks that may have failed via a failed state — some schemas may not have FAILED
    // but we use CANCELLED as the terminal failure state per the task state machine
    for (const t of rows) {
      items.push(item(
        projectId,
        "watching",
        "task",
        `Task failed recently: ${t.title ?? t.id}`,
        "Task was cancelled or failed in the last 24 hours",
        "/tasks",
        { taskId: t.id },
        { taskId: t.id, failedAt: t.updated_at },
      ));
    }
  } catch { /* ignore */ }
}

function detectCompletedTasks(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const since = Date.now() - 24 * 3_600_000;
    const rows = db.prepare(
      `SELECT id, title, updated_at FROM tasks
       WHERE project_id = ? AND state = 'DONE' AND updated_at >= ?
       ORDER BY updated_at DESC
       LIMIT 10`,
    ).all(projectId, since) as Array<{ id: string; title: string | null; updated_at: number }>;

    if (rows.length > 0) {
      items.push(item(
        projectId,
        "fyi",
        "task",
        `${rows.length} task${rows.length === 1 ? "" : "s"} completed in the last 24h`,
        rows.map((t) => t.title ?? t.id).join(", "),
        "/tasks",
        { state: "DONE" },
        { count: rows.length, taskIds: rows.map((t) => t.id) },
      ));
    }
  } catch { /* ignore */ }
}

function detectRecentAgentConfigChanges(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    const since = Date.now() - 24 * 3_600_000;
    const changes = listRecentChanges(projectId, {
      provenance: "agent",
      limit: 20,
    }, db);
    const recent = changes.filter((c) => c.createdAt >= since);
    if (recent.length > 0) {
      items.push(item(
        projectId,
        "fyi",
        "compliance",
        `${recent.length} config change${recent.length === 1 ? "" : "s"} by agents in the last 24h`,
        recent.slice(0, 3).map((c) => `${c.action} ${c.resourceType}/${c.resourceId}`).join("; "),
        "/config",
        undefined,
        { count: recent.length },
      ));
    }
  } catch { /* history table may not exist */ }
}

function detectHealthChanges(projectId: string, db: DatabaseSync, items: AttentionItem[]): void {
  try {
    // Emit FYI if there are fired alerts (health changes worth noting)
    const alertRows = db.prepare(
      `SELECT COUNT(*) as cnt FROM metrics
       WHERE project_id = ? AND type = 'alert' AND created_at >= ?`,
    ).get(projectId, Date.now() - 24 * 3_600_000) as { cnt: number } | undefined;

    if (alertRows && alertRows.cnt > 0) {
      items.push(item(
        projectId,
        "fyi",
        "health",
        `${alertRows.cnt} health alert${alertRows.cnt === 1 ? "" : "s"} in the last 24h`,
        "Review health and SLO status for details",
        "/ops",
        undefined,
        { alertCount: alertRows.cnt },
      ));
    }
  } catch { /* metrics table may not exist */ }
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Scan current domain state and return a prioritized attention summary.
 * Never throws — DB errors are silently suppressed per item.
 */
export function buildAttentionSummary(projectId: string, dbOverride?: DatabaseSync): AttentionSummary {
  let db: DatabaseSync;
  try {
    db = dbOverride ?? getDb(projectId);
  } catch {
    // If we can't get a DB at all, return empty summary
    return {
      projectId,
      items: [],
      counts: { actionNeeded: 0, watching: 0, fyi: 0 },
      generatedAt: Date.now(),
    };
  }

  const items: AttentionItem[] = [];

  // --- Action-needed ---
  detectApprovals(projectId, db, items);
  detectReviewTasks(projectId, db, items);
  detectBudget(projectId, db, items);
  detectKillSwitch(projectId, db, items);
  detectUnreadMessages(projectId, db, items);
  detectStaleTasks(projectId, db, items);

  // --- Watching ---
  detectHighCostRunningTasks(projectId, db, items);
  detectRecentFailedTasks(projectId, db, items);

  // --- FYI ---
  detectCompletedTasks(projectId, db, items);
  detectRecentAgentConfigChanges(projectId, db, items);
  detectHealthChanges(projectId, db, items);

  const counts = {
    actionNeeded: items.filter((i) => i.urgency === "action-needed").length,
    watching: items.filter((i) => i.urgency === "watching").length,
    fyi: items.filter((i) => i.urgency === "fyi").length,
  };

  return {
    projectId,
    items,
    counts,
    generatedAt: Date.now(),
  };
}
