/**
 * Clawforce — Goal completion cascade
 *
 * When all child goals of a parent are achieved, the parent is
 * automatically marked achieved. This cascades upward through
 * the hierarchy.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";
import { ingestEvent } from "../events/store.js";

// --- Progress computation ---

export type GoalProgress = {
  childGoals: { total: number; achieved: number; abandoned: number; active: number };
  tasks: { total: number; done: number; failed: number; active: number };
  progressPct: number;
};

export function computeGoalProgress(projectId: string, goalId: string, dbOverride?: DatabaseSync): GoalProgress {
  const db = dbOverride ?? getDb(projectId);

  // Count child goals by status
  const childRows = db.prepare(
    "SELECT status, COUNT(*) as cnt FROM goals WHERE parent_goal_id = ? AND project_id = ? GROUP BY status",
  ).all(goalId, projectId) as Record<string, unknown>[];

  const childGoals = { total: 0, achieved: 0, abandoned: 0, active: 0 };
  for (const row of childRows) {
    const count = row.cnt as number;
    childGoals.total += count;
    switch (row.status as string) {
      case "achieved": childGoals.achieved += count; break;
      case "abandoned": childGoals.abandoned += count; break;
      case "active": childGoals.active += count; break;
    }
  }

  // Count linked tasks by state
  const taskRows = db.prepare(
    "SELECT state, COUNT(*) as cnt FROM tasks WHERE goal_id = ? AND project_id = ? GROUP BY state",
  ).all(goalId, projectId) as Record<string, unknown>[];

  const tasks = { total: 0, done: 0, failed: 0, active: 0 };
  const terminalStates = new Set(["DONE", "FAILED", "CANCELLED"]);
  for (const row of taskRows) {
    const count = row.cnt as number;
    const state = row.state as string;
    tasks.total += count;
    if (state === "DONE") tasks.done += count;
    else if (state === "FAILED") tasks.failed += count;
    else if (!terminalStates.has(state)) tasks.active += count;
  }

  // Progress = (achieved goals + done tasks) / (total non-abandoned goals + total non-cancelled tasks)
  const completedItems = childGoals.achieved + tasks.done;
  const totalItems = (childGoals.total - childGoals.abandoned) + (tasks.total - tasks.failed);
  const progressPct = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

  return { childGoals, tasks, progressPct };
}

// --- Cascade check ---

export type CascadeResult = {
  checked: number;
  achieved: number;
};

export function checkGoalCascade(projectId: string, dbOverride?: DatabaseSync): CascadeResult {
  const db = dbOverride ?? getDb(projectId);
  let checked = 0;
  let achieved = 0;

  // Find active goals that have at least one child goal
  // Process bottom-up: order by depth (deepest first)
  // We use iterative approach: keep checking until no more auto-achieves
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;

    const candidates = db.prepare(`
      SELECT g.id, g.title FROM goals g
      WHERE g.project_id = ? AND g.status = 'active'
        AND EXISTS (SELECT 1 FROM goals c WHERE c.parent_goal_id = g.id)
    `).all(projectId) as Record<string, unknown>[];

    for (const row of candidates) {
      checked++;
      const goalId = row.id as string;
      const title = row.title as string;

      // Check if all children are achieved (no active children)
      const activeChildren = db.prepare(
        "SELECT COUNT(*) as cnt FROM goals WHERE parent_goal_id = ? AND project_id = ? AND status = 'active'",
      ).get(goalId, projectId) as Record<string, unknown>;

      if ((activeChildren.cnt as number) > 0) continue;

      // Check that at least one child is achieved (not all abandoned)
      const achievedChildren = db.prepare(
        "SELECT COUNT(*) as cnt FROM goals WHERE parent_goal_id = ? AND project_id = ? AND status = 'achieved'",
      ).get(goalId, projectId) as Record<string, unknown>;

      if ((achievedChildren.cnt as number) === 0) continue;

      // All children are terminal and at least one is achieved → auto-achieve
      const now = Date.now();
      db.prepare("UPDATE goals SET status = 'achieved', achieved_at = ? WHERE id = ? AND project_id = ?")
        .run(now, goalId, projectId);
      achieved++;
      madeProgress = true;

      emitDiagnosticEvent({ type: "goal_cascade_achieved", goalId, projectId, title });

      try {
        ingestEvent(projectId, "goal_achieved", "internal", {
          goalId, title, actor: "system:cascade", cascade: true,
        }, `goal-cascade:${goalId}`, db);
      } catch { /* non-fatal */ }

      safeLog("goals.cascade", { goalId, title, projectId });
    }
  }

  return { checked, achieved };
}
