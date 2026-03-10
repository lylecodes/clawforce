/**
 * Clawforce — OODA planning protocol
 *
 * Structured decision framework for manager sessions.
 * Observe → Orient → Decide → Act → Record
 *
 * Provides delta-aware context: "what changed since last wake"
 * instead of just a snapshot.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";

export type DeltaReport = {
  lastWakeAt: number | null;
  sinceLabel: string;
  taskTransitions: DeltaTransition[];
  newTasks: DeltaTask[];
  completedTasks: DeltaTask[];
  failedTasks: DeltaTask[];
  unblockedTasks: DeltaTask[];
  newEvents: DeltaEvent[];
  goalChanges: DeltaGoal[];
  newMessages: number;
  newProposals: number;
  replanNeeded: DeltaReplan[];
};

type DeltaReplan = {
  taskId: string;
  taskTitle: string;
  priority: string;
  replanCount: number;
};

type DeltaTransition = {
  taskId: string;
  taskTitle: string;
  fromState: string;
  toState: string;
  actor: string;
  reason?: string;
  at: number;
};

type DeltaTask = {
  id: string;
  title: string;
  priority: string;
  state: string;
  assignedTo?: string;
};

type DeltaEvent = {
  type: string;
  source: string;
  at: number;
};

type DeltaGoal = {
  id: string;
  title: string;
  status: string;
  previousStatus?: string;
};

/**
 * Get the timestamp of the manager's last session end.
 * Uses audit_runs to find the most recent completed session.
 */
export function getLastWakeTime(
  projectId: string,
  agentId: string,
  dbOverride?: DatabaseSync,
): number | null {
  const db = dbOverride ?? getDb(projectId);
  try {
    const row = db.prepare(
      "SELECT ended_at FROM audit_runs WHERE project_id = ? AND agent_id = ? ORDER BY ended_at DESC LIMIT 1",
    ).get(projectId, agentId) as Record<string, unknown> | undefined;
    return (row?.ended_at as number) ?? null;
  } catch {
    return null;
  }
}

/**
 * Build a delta report: what changed since the manager's last session.
 */
export function buildDeltaReport(
  projectId: string,
  agentId: string,
  dbOverride?: DatabaseSync,
): DeltaReport {
  const db = dbOverride ?? getDb(projectId);
  const lastWake = getLastWakeTime(projectId, agentId, db);
  const since = lastWake ?? (Date.now() - 24 * 60 * 60 * 1000); // Default: last 24h

  const sinceLabel = lastWake
    ? formatDuration(Date.now() - lastWake)
    : "last 24 hours (no previous session found)";

  return {
    lastWakeAt: lastWake,
    sinceLabel,
    taskTransitions: queryTaskTransitions(db, projectId, since),
    newTasks: queryNewTasks(db, projectId, since),
    completedTasks: queryTasksByState(db, projectId, since, "DONE"),
    failedTasks: queryTasksByState(db, projectId, since, "FAILED"),
    unblockedTasks: queryUnblockedTasks(db, projectId, since),
    newEvents: queryNewEvents(db, projectId, since),
    goalChanges: queryGoalChanges(db, projectId, since),
    newMessages: countNewMessages(db, projectId, agentId, since),
    newProposals: countNewProposals(db, projectId, since),
    replanNeeded: queryReplanNeeded(db, projectId),
  };
}

/**
 * Render the delta report as a markdown section for context injection.
 */
export function renderDeltaReport(report: DeltaReport): string | null {
  const sections: string[] = [];

  sections.push(`## What Changed (since ${report.sinceLabel} ago)`);
  sections.push("");

  // Summary line
  const counts: string[] = [];
  if (report.completedTasks.length > 0) counts.push(`${report.completedTasks.length} completed`);
  if (report.failedTasks.length > 0) counts.push(`${report.failedTasks.length} failed`);
  if (report.newTasks.length > 0) counts.push(`${report.newTasks.length} new`);
  if (report.unblockedTasks.length > 0) counts.push(`${report.unblockedTasks.length} unblocked`);
  if (report.replanNeeded.length > 0) counts.push(`${report.replanNeeded.length} need re-planning`);
  if (report.newMessages > 0) counts.push(`${report.newMessages} messages`);
  if (report.newProposals > 0) counts.push(`${report.newProposals} proposals`);

  if (counts.length === 0) {
    sections.push("No significant changes since last session.");
    return sections.join("\n");
  }

  sections.push(`**Summary:** ${counts.join(", ")}`);
  sections.push("");

  // Completed tasks
  if (report.completedTasks.length > 0) {
    sections.push("### Completed");
    for (const t of report.completedTasks.slice(0, 10)) {
      sections.push(`- **${t.title}** (${t.priority}) ${t.assignedTo ? `by ${t.assignedTo}` : ""}`);
    }
    sections.push("");
  }

  // Failed tasks
  if (report.failedTasks.length > 0) {
    sections.push("### Failed");
    for (const t of report.failedTasks.slice(0, 10)) {
      sections.push(`- **${t.title}** (${t.priority}) ${t.assignedTo ? `assigned to ${t.assignedTo}` : ""}`);
    }
    sections.push("");
  }

  // Unblocked tasks
  if (report.unblockedTasks.length > 0) {
    sections.push("### Unblocked");
    for (const t of report.unblockedTasks.slice(0, 10)) {
      sections.push(`- **${t.title}** (${t.priority}) → now ${t.state}`);
    }
    sections.push("");
  }

  // New tasks
  if (report.newTasks.length > 0) {
    sections.push("### New Tasks");
    for (const t of report.newTasks.slice(0, 10)) {
      sections.push(`- **${t.title}** (${t.priority}, ${t.state})`);
    }
    if (report.newTasks.length > 10) {
      sections.push(`- …and ${report.newTasks.length - 10} more`);
    }
    sections.push("");
  }

  // Re-planning needed (highest priority)
  if (report.replanNeeded.length > 0) {
    sections.push("### Re-planning Required");
    for (const r of report.replanNeeded) {
      sections.push(`- **${r.taskTitle}** (${r.priority}) — ${r.replanCount} previous re-plan(s). Use \`clawforce_task get task_id=${r.taskId}\` to review failure evidence.`);
    }
    sections.push("");
  }

  // Key transitions (non-terminal, for situational awareness)
  const nonTerminalTransitions = report.taskTransitions.filter(
    (t) => t.toState !== "DONE" && t.toState !== "FAILED",
  );
  if (nonTerminalTransitions.length > 0) {
    sections.push("### State Changes");
    for (const t of nonTerminalTransitions.slice(0, 10)) {
      const reason = t.reason ? ` — ${t.reason}` : "";
      sections.push(`- **${t.taskTitle}**: ${t.fromState} → ${t.toState} (${t.actor})${reason}`);
    }
    sections.push("");
  }

  // Goal changes
  if (report.goalChanges.length > 0) {
    sections.push("### Goal Updates");
    for (const g of report.goalChanges.slice(0, 10)) {
      sections.push(`- **${g.title}**: ${g.status}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * Build the OODA framework prompt for manager sessions.
 * This replaces the numbered action list with a structured decision process.
 */
export function buildOodaPrompt(projectId: string, stateHints: string[]): string {
  const hints = stateHints.length > 0
    ? ["", "**Current state:**", ...stateHints.map((h) => `- ${h}`), ""]
    : [""];

  return [
    `You are the manager for project "${projectId}".`,
    "",
    "Follow the OODA decision framework for this session:",
    "",
    "## 1. OBSERVE — What's the current state?",
    "Review the delta report (what changed since last wake) and your full context.",
    "Process any pending events first: `clawforce_ops process_events`",
    "",
    "## 2. ORIENT — Compare to goals",
    "- Are we on track toward active goals?",
    "- What's blocking progress?",
    "- Are there failures, escalations, or stale items?",
    "- Are there unplanned goals needing decomposition?",
    "",
    "## 3. DECIDE — Highest-impact action",
    "Pick the single most impactful thing to do right now. Priority order:",
    "- P0/P1 escalations and failures",
    "- Blocked tasks that can be unblocked",
    "- OPEN tasks needing assignment",
    "- REVIEW tasks needing verification dispatch",
    "- Goal decomposition (clawforce_goal decompose)",
    "- New task creation for identified gaps",
    "- Workflow advancement",
    "",
    "## 4. ACT — Execute",
    "Take the action using clawforce tools. Then repeat DECIDE → ACT for remaining items.",
    ...hints,
    "## 5. RECORD — Save rationale",
    "Before ending, record your planning decisions:",
    "- `clawforce_log write` with category `decision` — what you decided and why",
    "- `clawforce_log outcome` — session result summary",
    "",
    "Use `clawforce_ops enqueue_work` to queue tasks, `dispatch_worker` for immediate dispatch.",
    "Use `clawforce_ops refresh_context` to get fresh state mid-session.",
  ].join("\n");
}

// --- Query helpers ---

function queryTaskTransitions(
  db: DatabaseSync,
  projectId: string,
  since: number,
): DeltaTransition[] {
  try {
    const rows = db.prepare(`
      SELECT tr.task_id, tr.from_state, tr.to_state, tr.actor, tr.reason, tr.created_at,
             t.title as task_title
      FROM transitions tr
      JOIN tasks t ON t.id = tr.task_id AND t.project_id = ?
      WHERE tr.created_at > ?
      ORDER BY tr.created_at DESC
      LIMIT 50
    `).all(projectId, since) as Record<string, unknown>[];

    return rows.map((r) => ({
      taskId: r.task_id as string,
      taskTitle: r.task_title as string,
      fromState: r.from_state as string,
      toState: r.to_state as string,
      actor: r.actor as string,
      reason: (r.reason as string) ?? undefined,
      at: r.created_at as number,
    }));
  } catch (err) {
    safeLog("ooda.queryTransitions", err);
    return [];
  }
}

function queryNewTasks(
  db: DatabaseSync,
  projectId: string,
  since: number,
): DeltaTask[] {
  try {
    const rows = db.prepare(
      "SELECT id, title, priority, state, assigned_to FROM tasks WHERE project_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 20",
    ).all(projectId, since) as Record<string, unknown>[];

    return rows.map(rowToDeltaTask);
  } catch (err) {
    safeLog("ooda.queryNewTasks", err);
    return [];
  }
}

function queryTasksByState(
  db: DatabaseSync,
  projectId: string,
  since: number,
  state: string,
): DeltaTask[] {
  try {
    // Tasks that entered this state since last wake
    const rows = db.prepare(`
      SELECT DISTINCT t.id, t.title, t.priority, t.state, t.assigned_to
      FROM tasks t
      JOIN transitions tr ON tr.task_id = t.id
      WHERE t.project_id = ? AND tr.to_state = ? AND tr.created_at > ?
      ORDER BY t.updated_at DESC
      LIMIT 20
    `).all(projectId, state, since) as Record<string, unknown>[];

    return rows.map(rowToDeltaTask);
  } catch (err) {
    safeLog("ooda.queryTasksByState", err);
    return [];
  }
}

function queryUnblockedTasks(
  db: DatabaseSync,
  projectId: string,
  since: number,
): DeltaTask[] {
  try {
    // Tasks that transitioned FROM BLOCKED since last wake
    const rows = db.prepare(`
      SELECT DISTINCT t.id, t.title, t.priority, t.state, t.assigned_to
      FROM tasks t
      JOIN transitions tr ON tr.task_id = t.id
      WHERE t.project_id = ? AND tr.from_state = 'BLOCKED' AND tr.created_at > ?
      ORDER BY t.updated_at DESC
      LIMIT 20
    `).all(projectId, since) as Record<string, unknown>[];

    return rows.map(rowToDeltaTask);
  } catch (err) {
    safeLog("ooda.queryUnblockedTasks", err);
    return [];
  }
}

function queryNewEvents(
  db: DatabaseSync,
  projectId: string,
  since: number,
): DeltaEvent[] {
  try {
    const rows = db.prepare(
      "SELECT type, source, created_at FROM events WHERE project_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 20",
    ).all(projectId, since) as Record<string, unknown>[];

    return rows.map((r) => ({
      type: r.type as string,
      source: r.source as string,
      at: r.created_at as number,
    }));
  } catch (err) {
    safeLog("ooda.queryNewEvents", err);
    return [];
  }
}

function queryGoalChanges(
  db: DatabaseSync,
  projectId: string,
  since: number,
): DeltaGoal[] {
  try {
    const rows = db.prepare(
      "SELECT id, title, status FROM goals WHERE project_id = ? AND (created_at > ? OR achieved_at > ?) ORDER BY created_at DESC LIMIT 10",
    ).all(projectId, since, since) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: r.id as string,
      title: r.title as string,
      status: r.status as string,
    }));
  } catch (err) {
    // goals table may not exist
    return [];
  }
}

function countNewMessages(
  db: DatabaseSync,
  projectId: string,
  agentId: string,
  since: number,
): number {
  try {
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE project_id = ? AND to_agent = ? AND created_at > ?",
    ).get(projectId, agentId, since) as Record<string, unknown> | undefined;
    return (row?.cnt as number) ?? 0;
  } catch {
    return 0;
  }
}

function countNewProposals(
  db: DatabaseSync,
  projectId: string,
  since: number,
): number {
  try {
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM proposals WHERE project_id = ? AND created_at > ?",
    ).get(projectId, since) as Record<string, unknown> | undefined;
    return (row?.cnt as number) ?? 0;
  } catch {
    return 0;
  }
}

function queryReplanNeeded(
  db: DatabaseSync,
  projectId: string,
): DeltaReplan[] {
  try {
    // Tasks that are FAILED, escalated, and have replan metadata
    const rows = db.prepare(`
      SELECT id, title, priority, metadata
      FROM tasks
      WHERE project_id = ? AND state = 'FAILED'
        AND retry_count >= max_retries
        AND COALESCE(json_extract(metadata, '$.escalated'), false) = true
      ORDER BY priority ASC, updated_at DESC
      LIMIT 10
    `).all(projectId) as Record<string, unknown>[];

    return rows.map((r) => {
      let replanCount = 0;
      try {
        const meta = r.metadata ? JSON.parse(r.metadata as string) : {};
        replanCount = meta.replan_count ?? 0;
      } catch { /* */ }

      return {
        taskId: r.id as string,
        taskTitle: r.title as string,
        priority: r.priority as string,
        replanCount,
      };
    });
  } catch (err) {
    safeLog("ooda.queryReplanNeeded", err);
    return [];
  }
}

// --- Helpers ---

function rowToDeltaTask(row: Record<string, unknown>): DeltaTask {
  return {
    id: row.id as string,
    title: row.title as string,
    priority: row.priority as string,
    state: row.state as string,
    assignedTo: (row.assigned_to as string) ?? undefined,
  };
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}
