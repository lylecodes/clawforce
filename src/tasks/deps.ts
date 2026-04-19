/**
 * Clawforce — Task dependency DAG
 *
 * Fine-grained task dependencies beyond workflow phases.
 * Supports "blocks" (hard) and "soft" (advisory) dependency types.
 * When a task completes, hard-blocked dependents auto-unblock.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { transitionTask } from "./ops.js";
import { ingestEvent } from "../events/store.js";

export type DependencyType = "blocks" | "soft";

export type TaskDependency = {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  type: DependencyType;
  createdAt: number;
  createdBy: string;
};

export type AddDependencyParams = {
  projectId: string;
  taskId: string;
  dependsOnTaskId: string;
  type?: DependencyType;
  createdBy: string;
};

export type RemoveDependencyParams = {
  projectId: string;
  taskId: string;
  dependsOnTaskId: string;
};

/**
 * Add a dependency: taskId depends on dependsOnTaskId.
 * Validates both tasks exist and prevents self-deps and cycles.
 */
export function addDependency(
  params: AddDependencyParams,
  dbOverride?: DatabaseSync,
): { ok: true; dependency: TaskDependency } | { ok: false; reason: string } {
  const db = dbOverride ?? getDb(params.projectId);
  const type: DependencyType = params.type ?? "blocks";

  if (params.taskId === params.dependsOnTaskId) {
    return { ok: false, reason: "A task cannot depend on itself." };
  }

  // Validate both tasks exist
  const task = db.prepare("SELECT id, state FROM tasks WHERE id = ? AND project_id = ?")
    .get(params.taskId, params.projectId) as Record<string, unknown> | undefined;
  if (!task) return { ok: false, reason: `Task ${params.taskId} not found.` };

  const depTask = db.prepare("SELECT id, state FROM tasks WHERE id = ? AND project_id = ?")
    .get(params.dependsOnTaskId, params.projectId) as Record<string, unknown> | undefined;
  if (!depTask) return { ok: false, reason: `Dependency task ${params.dependsOnTaskId} not found.` };

  // Check for duplicate
  const existing = db.prepare(
    "SELECT id FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ? AND project_id = ?",
  ).get(params.taskId, params.dependsOnTaskId, params.projectId) as Record<string, unknown> | undefined;
  if (existing) return { ok: false, reason: "Dependency already exists." };

  // Cycle detection: would adding this edge create a cycle?
  if (wouldCreateCycle(params.taskId, params.dependsOnTaskId, params.projectId, db)) {
    return { ok: false, reason: "Adding this dependency would create a cycle." };
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO task_dependencies (id, project_id, task_id, depends_on_task_id, type, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.projectId, params.taskId, params.dependsOnTaskId, type, now, params.createdBy);

  const dependency: TaskDependency = {
    id,
    taskId: params.taskId,
    dependsOnTaskId: params.dependsOnTaskId,
    type,
    createdAt: now,
    createdBy: params.createdBy,
  };

  return { ok: true, dependency };
}

/**
 * Remove a dependency.
 */
export function removeDependency(
  params: RemoveDependencyParams,
  dbOverride?: DatabaseSync,
): { ok: true } | { ok: false; reason: string } {
  const db = dbOverride ?? getDb(params.projectId);

  const result = db.prepare(
    "DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ? AND project_id = ?",
  ).run(params.taskId, params.dependsOnTaskId, params.projectId);

  if (result.changes === 0) return { ok: false, reason: "Dependency not found." };
  return { ok: true };
}

/**
 * Get all dependencies OF a task (things this task depends on).
 */
export function getTaskDependencies(
  projectId: string,
  taskId: string,
  dbOverride?: DatabaseSync,
): TaskDependency[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM task_dependencies WHERE task_id = ? AND project_id = ? ORDER BY created_at",
  ).all(taskId, projectId) as Record<string, unknown>[];

  return rows.map(rowToDependency);
}

/**
 * Get all tasks that depend ON a given task (dependents / downstream).
 */
export function getTaskDependents(
  projectId: string,
  taskId: string,
  dbOverride?: DatabaseSync,
): TaskDependency[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM task_dependencies WHERE depends_on_task_id = ? AND project_id = ? ORDER BY created_at",
  ).all(taskId, projectId) as Record<string, unknown>[];

  return rows.map(rowToDependency);
}

/**
 * Get unresolved hard blockers for a task — dependencies where the
 * upstream task is NOT in a terminal-complete state (DONE).
 */
export function getUnresolvedBlockers(
  projectId: string,
  taskId: string,
  dbOverride?: DatabaseSync,
): Array<{ dependency: TaskDependency; blockerState: string; blockerTitle: string }> {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(`
    SELECT d.*, t.state as blocker_state, t.title as blocker_title
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.depends_on_task_id AND t.project_id = d.project_id
    WHERE d.task_id = ? AND d.project_id = ? AND d.type = 'blocks' AND t.state != 'DONE'
    ORDER BY d.created_at
  `).all(taskId, projectId) as Record<string, unknown>[];

  return rows.map((r) => ({
    dependency: rowToDependency(r),
    blockerState: r.blocker_state as string,
    blockerTitle: r.blocker_title as string,
  }));
}

/**
 * When a task completes, check its dependents and auto-unblock any
 * BLOCKED tasks whose hard dependencies are now all resolved.
 *
 * Returns the list of task IDs that were unblocked.
 */
export function cascadeUnblock(
  projectId: string,
  completedTaskId: string,
  actor: string,
  dbOverride?: DatabaseSync,
): string[] {
  const db = dbOverride ?? getDb(projectId);
  const unblocked: string[] = [];

  // Find all tasks that depend on the completed task (hard deps only)
  const dependents = db.prepare(`
    SELECT DISTINCT d.task_id
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.task_id AND t.project_id = d.project_id
    WHERE d.depends_on_task_id = ? AND d.project_id = ? AND d.type = 'blocks' AND t.state = 'BLOCKED'
  `).all(completedTaskId, projectId) as Record<string, unknown>[];

  for (const row of dependents) {
    const depTaskId = row.task_id as string;

    // Check if ALL hard blockers for this task are now DONE
    const remaining = getUnresolvedBlockers(projectId, depTaskId, db);
    if (remaining.length === 0) {
      // All blockers resolved — transition BLOCKED → OPEN
      const result = transitionTask({
        projectId,
        taskId: depTaskId,
        toState: "OPEN",
        actor,
        reason: `Auto-unblocked: dependency ${completedTaskId} completed`,
        withinTransaction: false,
      }, db);

      if (result.ok) {
        unblocked.push(depTaskId);

        try {
          ingestEvent(projectId, "task_unblocked", "internal", {
            taskId: depTaskId,
            unblockReason: "dependency_resolved",
            completedDependency: completedTaskId,
          }, `task-unblocked:${depTaskId}:${completedTaskId}`, db);
        } catch (err) { safeLog("deps.cascadeUnblock.event", err); }
      }
    }
  }

  return unblocked;
}

// --- Cycle detection ---

/**
 * Check if adding an edge taskId → dependsOnTaskId would create a cycle.
 * This means: is there already a path from dependsOnTaskId to taskId?
 * If so, adding taskId → dependsOnTaskId closes the loop.
 */
function wouldCreateCycle(
  taskId: string,
  dependsOnTaskId: string,
  projectId: string,
  db: DatabaseSync,
): boolean {
  // BFS from dependsOnTaskId upstream — if we reach taskId, it's a cycle
  const visited = new Set<string>();
  const queue = [dependsOnTaskId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    // Get what current depends on (upstream)
    const upstream = db.prepare(
      "SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? AND project_id = ?",
    ).all(current, projectId) as Record<string, unknown>[];

    for (const row of upstream) {
      queue.push(row.depends_on_task_id as string);
    }
  }

  return false;
}

// --- Helpers ---

function rowToDependency(row: Record<string, unknown>): TaskDependency {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    dependsOnTaskId: row.depends_on_task_id as string,
    type: row.type as DependencyType,
    createdAt: row.created_at as number,
    createdBy: row.created_by as string,
  };
}
