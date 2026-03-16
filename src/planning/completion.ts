/**
 * Clawforce — Completion detection
 *
 * Detects when workflows, goals, and entire projects are complete.
 * Triggers verification tasks for goals with acceptance criteria.
 * Emits project_completed when all top-level goals are achieved.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";
import { ingestEvent } from "../events/store.js";
import { writeAuditEntry } from "../audit.js";
import { createTask } from "../tasks/ops.js";

export type CompletionStatus = {
  topLevelGoals: { total: number; achieved: number; abandoned: number; active: number };
  activeWorkflows: number;
  isComplete: boolean;
};

/**
 * Check if all top-level goals in a project are achieved.
 * A project is "complete" when all top-level goals (no parent) are
 * in a terminal state AND at least one is achieved.
 */
export function detectProjectCompletion(
  projectId: string,
  dbOverride?: DatabaseSync,
): CompletionStatus {
  const db = dbOverride ?? getDb(projectId);

  const rows = db.prepare(
    "SELECT status, COUNT(*) as cnt FROM goals WHERE project_id = ? AND parent_goal_id IS NULL GROUP BY status",
  ).all(projectId) as Record<string, unknown>[];

  const goals = { total: 0, achieved: 0, abandoned: 0, active: 0 };
  for (const row of rows) {
    const count = row.cnt as number;
    goals.total += count;
    switch (row.status as string) {
      case "achieved": goals.achieved += count; break;
      case "abandoned": goals.abandoned += count; break;
      case "active": goals.active += count; break;
    }
  }

  // Check for active workflows
  let activeWorkflows = 0;
  try {
    const wfRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM workflows WHERE project_id = ? AND state = 'active'",
    ).get(projectId) as Record<string, unknown> | undefined;
    activeWorkflows = (wfRow?.cnt as number) ?? 0;
  } catch { /* workflows table may not exist */ }

  // Complete = has goals, none active, at least one achieved, no active workflows
  const isComplete = goals.total > 0
    && goals.active === 0
    && goals.achieved > 0
    && activeWorkflows === 0;

  return { topLevelGoals: goals, activeWorkflows, isComplete };
}

/**
 * Handle workflow completion: check if any linked goals have
 * acceptance criteria that need verification.
 *
 * Returns created verification task IDs.
 */
export function handleWorkflowCompletion(
  projectId: string,
  workflowId: string,
  dbOverride?: DatabaseSync,
): string[] {
  const db = dbOverride ?? getDb(projectId);
  const createdTasks: string[] = [];

  // Find goals that have tasks linked to this workflow
  const goalRows = db.prepare(`
    SELECT DISTINCT g.id, g.title, g.acceptance_criteria, g.owner_agent_id
    FROM goals g
    JOIN tasks t ON t.goal_id = g.id AND t.project_id = g.project_id
    WHERE t.workflow_id = ? AND t.project_id = ? AND g.status = 'active' AND g.acceptance_criteria IS NOT NULL
  `).all(workflowId, projectId) as Record<string, unknown>[];

  for (const row of goalRows) {
    const goalId = row.id as string;
    const goalTitle = row.title as string;
    const criteria = row.acceptance_criteria as string;
    const owner = row.owner_agent_id as string | null;

    // Create verification task
    const task = createTask({
      projectId,
      title: `Verify: ${goalTitle}`,
      description: `Workflow completed. Verify that the goal "${goalTitle}" meets its acceptance criteria:\n\n${criteria}`,
      priority: "P1",
      createdBy: "system:completion",
      tags: ["verification", "goal-check"],
      goalId,
    }, db);

    createdTasks.push(task.id);

    try {
      writeAuditEntry({
        projectId,
        actor: "system:completion",
        action: "verification_task_created",
        targetType: "goal",
        targetId: goalId,
        detail: JSON.stringify({ taskId: task.id, workflowId, goalTitle }),
      }, db);
    } catch (err) { safeLog("completion.auditVerification", err); }
  }

  return createdTasks;
}

/**
 * Handle goal achievement: check if project is now complete.
 * Emits project_completed event if so.
 */
export function handleGoalAchieved(
  projectId: string,
  goalId: string,
  dbOverride?: DatabaseSync,
): { projectComplete: boolean } {
  const db = dbOverride ?? getDb(projectId);

  // Only check project completion for top-level goals
  const goal = db.prepare(
    "SELECT parent_goal_id FROM goals WHERE id = ? AND project_id = ?",
  ).get(goalId, projectId) as Record<string, unknown> | undefined;

  if (!goal || goal.parent_goal_id !== null) {
    return { projectComplete: false };
  }

  const status = detectProjectCompletion(projectId, db);

  if (status.isComplete) {
    // Mark project as complete in metadata
    try {
      // Check if already marked
      const existing = db.prepare(
        "SELECT value FROM project_metadata WHERE project_id = ? AND key = 'completed_at'",
      ).get(projectId) as Record<string, unknown> | undefined;

      if (!existing) {
        db.prepare(
          "INSERT OR IGNORE INTO project_metadata (project_id, key, value) VALUES (?, 'completed_at', ?)",
        ).run(projectId, String(Date.now()));

        ingestEvent(projectId, "project_completed", "internal", {
          topLevelGoals: status.topLevelGoals,
        }, `project-completed:${projectId}`, db);

        writeAuditEntry({
          projectId,
          actor: "system:completion",
          action: "project_completed",
          targetType: "project",
          targetId: projectId,
          detail: JSON.stringify(status.topLevelGoals),
        }, db);

        emitDiagnosticEvent({ type: "project_completed", projectId, goals: status.topLevelGoals });
      }
    } catch (err) {
      safeLog("completion.projectComplete", err);
    }

    return { projectComplete: true };
  }

  return { projectComplete: false };
}
