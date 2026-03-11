/**
 * Clawforce — Goal CRUD operations
 *
 * Manages the goal hierarchy: create, read, update, achieve, abandon.
 * Goals cascade completion upward — when all children are achieved,
 * the parent is automatically marked achieved (via cascade module).
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";
import { ingestEvent } from "../events/store.js";
import type { Goal, GoalStatus, Task } from "../types.js";

// --- Row mapper ---

function rowToGoal(row: Record<string, unknown>): Goal {
  const goal: Goal = {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    status: row.status as GoalStatus,
    createdBy: row.created_by as string,
    createdAt: row.created_at as number,
  };
  if (row.description != null) goal.description = row.description as string;
  if (row.acceptance_criteria != null) goal.acceptanceCriteria = row.acceptance_criteria as string;
  if (row.parent_goal_id != null) goal.parentGoalId = row.parent_goal_id as string;
  if (row.owner_agent_id != null) goal.ownerAgentId = row.owner_agent_id as string;
  if (row.department != null) goal.department = row.department as string;
  if (row.team != null) goal.team = row.team as string;
  if (row.achieved_at != null) goal.achievedAt = row.achieved_at as number;
  if (row.metadata != null) {
    try { goal.metadata = JSON.parse(row.metadata as string); } catch { /* ignore */ }
  }
  if (row.allocation != null) goal.allocation = row.allocation as number;
  return goal;
}

// --- Create ---

export type CreateGoalParams = {
  projectId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  parentGoalId?: string;
  ownerAgentId?: string;
  department?: string;
  team?: string;
  createdBy: string;
  metadata?: Record<string, unknown>;
  allocation?: number;
};

export function createGoal(params: CreateGoalParams, dbOverride?: DatabaseSync): Goal {
  const db = dbOverride ?? getDb(params.projectId);
  const id = randomUUID();
  const now = Date.now();

  // Validate parent exists if provided
  if (params.parentGoalId) {
    const parent = db.prepare("SELECT id FROM goals WHERE id = ? AND project_id = ?")
      .get(params.parentGoalId, params.projectId) as Record<string, unknown> | undefined;
    if (!parent) {
      throw new Error(`Parent goal not found: ${params.parentGoalId}`);
    }
  }

  db.prepare(`
    INSERT INTO goals (id, project_id, title, description, acceptance_criteria, status, parent_goal_id, owner_agent_id, department, team, created_by, created_at, metadata, allocation)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.projectId,
    params.title,
    params.description ?? null,
    params.acceptanceCriteria ?? null,
    params.parentGoalId ?? null,
    params.ownerAgentId ?? null,
    params.department ?? null,
    params.team ?? null,
    params.createdBy,
    now,
    params.metadata ? JSON.stringify(params.metadata) : null,
    params.allocation ?? null,
  );

  const goal: Goal = {
    id,
    projectId: params.projectId,
    title: params.title,
    description: params.description,
    acceptanceCriteria: params.acceptanceCriteria,
    status: "active",
    parentGoalId: params.parentGoalId,
    ownerAgentId: params.ownerAgentId,
    department: params.department,
    team: params.team,
    createdBy: params.createdBy,
    createdAt: now,
    metadata: params.metadata,
    allocation: params.allocation,
  };

  safeLog("goals.create", { id, title: params.title, project: params.projectId });
  emitDiagnosticEvent({ type: "goal_created", goalId: id, projectId: params.projectId, title: params.title });

  try {
    ingestEvent(params.projectId, "goal_created", "internal", {
      goalId: id, title: params.title, parentGoalId: params.parentGoalId ?? null,
      ownerAgentId: params.ownerAgentId ?? null,
    }, `goal-created:${id}`, db);
  } catch { /* non-fatal */ }

  return goal;
}

// --- Read ---

export function getGoal(projectId: string, goalId: string, dbOverride?: DatabaseSync): Goal | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare("SELECT * FROM goals WHERE id = ? AND project_id = ?")
    .get(goalId, projectId) as Record<string, unknown> | undefined;
  return row ? rowToGoal(row) : null;
}

export type ListGoalsFilters = {
  status?: GoalStatus;
  parentGoalId?: string | null; // null = top-level only
  ownerAgentId?: string;
  department?: string;
  team?: string;
  limit?: number;
};

export function listGoals(projectId: string, filters?: ListGoalsFilters, dbOverride?: DatabaseSync): Goal[] {
  const db = dbOverride ?? getDb(projectId);
  let query = "SELECT * FROM goals WHERE project_id = ?";
  const params: (string | number | null)[] = [projectId];

  if (filters?.status) {
    query += " AND status = ?";
    params.push(filters.status);
  }
  if (filters?.parentGoalId !== undefined) {
    if (filters.parentGoalId === null) {
      query += " AND parent_goal_id IS NULL";
    } else {
      query += " AND parent_goal_id = ?";
      params.push(filters.parentGoalId);
    }
  }
  if (filters?.ownerAgentId) {
    query += " AND owner_agent_id = ?";
    params.push(filters.ownerAgentId);
  }
  if (filters?.department) {
    query += " AND department = ?";
    params.push(filters.department);
  }
  if (filters?.team) {
    query += " AND team = ?";
    params.push(filters.team);
  }

  query += " ORDER BY created_at ASC";

  if (filters?.limit) {
    query += " LIMIT ?";
    params.push(filters.limit);
  }

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(rowToGoal);
}

export function getChildGoals(projectId: string, goalId: string, dbOverride?: DatabaseSync): Goal[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare("SELECT * FROM goals WHERE parent_goal_id = ? AND project_id = ? ORDER BY created_at ASC")
    .all(goalId, projectId) as Record<string, unknown>[];
  return rows.map(rowToGoal);
}

export type GoalTreeNode = Goal & { children: GoalTreeNode[] };

export function getGoalTree(projectId: string, goalId: string, dbOverride?: DatabaseSync): GoalTreeNode | null {
  const goal = getGoal(projectId, goalId, dbOverride);
  if (!goal) return null;

  const children = getChildGoals(projectId, goalId, dbOverride);
  const childNodes: GoalTreeNode[] = children.map(
    (child) => getGoalTree(projectId, child.id, dbOverride)!,
  ).filter(Boolean);

  return { ...goal, children: childNodes };
}

// --- Update ---

export type UpdateGoalParams = {
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  ownerAgentId?: string;
  department?: string;
  team?: string;
  metadata?: Record<string, unknown>;
  allocation?: number;
};

export function updateGoal(projectId: string, goalId: string, updates: UpdateGoalParams, dbOverride?: DatabaseSync): Goal {
  const db = dbOverride ?? getDb(projectId);
  const goal = getGoal(projectId, goalId, db);
  if (!goal) throw new Error(`Goal not found: ${goalId}`);

  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (updates.title !== undefined) { sets.push("title = ?"); params.push(updates.title); }
  if (updates.description !== undefined) { sets.push("description = ?"); params.push(updates.description); }
  if (updates.acceptanceCriteria !== undefined) { sets.push("acceptance_criteria = ?"); params.push(updates.acceptanceCriteria); }
  if (updates.ownerAgentId !== undefined) { sets.push("owner_agent_id = ?"); params.push(updates.ownerAgentId); }
  if (updates.department !== undefined) { sets.push("department = ?"); params.push(updates.department); }
  if (updates.team !== undefined) { sets.push("team = ?"); params.push(updates.team); }
  if (updates.metadata !== undefined) { sets.push("metadata = ?"); params.push(JSON.stringify(updates.metadata)); }
  if (updates.allocation !== undefined) { sets.push("allocation = ?"); params.push(updates.allocation); }

  if (sets.length === 0) return goal;

  params.push(goalId, projectId);
  db.prepare(`UPDATE goals SET ${sets.join(", ")} WHERE id = ? AND project_id = ?`).run(...params);

  return getGoal(projectId, goalId, db)!;
}

// --- Status transitions ---

export function achieveGoal(projectId: string, goalId: string, actor: string, dbOverride?: DatabaseSync): Goal {
  const db = dbOverride ?? getDb(projectId);
  const goal = getGoal(projectId, goalId, db);
  if (!goal) throw new Error(`Goal not found: ${goalId}`);
  if (goal.status !== "active") throw new Error(`Cannot achieve goal in status: ${goal.status}`);

  const now = Date.now();
  db.prepare("UPDATE goals SET status = 'achieved', achieved_at = ? WHERE id = ? AND project_id = ?")
    .run(now, goalId, projectId);

  emitDiagnosticEvent({ type: "goal_achieved", goalId, projectId, actor });

  try {
    ingestEvent(projectId, "goal_achieved", "internal", {
      goalId, title: goal.title, actor,
    }, `goal-achieved:${goalId}`, db);
  } catch { /* non-fatal */ }

  return { ...goal, status: "achieved", achievedAt: now };
}

export function abandonGoal(projectId: string, goalId: string, actor: string, reason?: string, dbOverride?: DatabaseSync): Goal {
  const db = dbOverride ?? getDb(projectId);
  const goal = getGoal(projectId, goalId, db);
  if (!goal) throw new Error(`Goal not found: ${goalId}`);
  if (goal.status !== "active") throw new Error(`Cannot abandon goal in status: ${goal.status}`);

  const metadataUpdate = reason
    ? JSON.stringify({ ...(goal.metadata ?? {}), abandonReason: reason })
    : (goal.metadata ? JSON.stringify(goal.metadata) : null);

  db.prepare("UPDATE goals SET status = 'abandoned', metadata = ? WHERE id = ? AND project_id = ?")
    .run(metadataUpdate, goalId, projectId);

  emitDiagnosticEvent({ type: "goal_abandoned", goalId, projectId, actor, reason });

  try {
    ingestEvent(projectId, "goal_abandoned", "internal", {
      goalId, title: goal.title, actor, reason,
    }, `goal-abandoned:${goalId}`, db);
  } catch { /* non-fatal */ }

  return { ...goal, status: "abandoned", metadata: reason ? { ...(goal.metadata ?? {}), abandonReason: reason } : goal.metadata };
}

// --- Task linkage ---

export function linkTaskToGoal(projectId: string, taskId: string, goalId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);

  // Verify goal exists
  const goal = db.prepare("SELECT id FROM goals WHERE id = ? AND project_id = ?")
    .get(goalId, projectId) as Record<string, unknown> | undefined;
  if (!goal) throw new Error(`Goal not found: ${goalId}`);

  // Verify task exists
  const task = db.prepare("SELECT id FROM tasks WHERE id = ? AND project_id = ?")
    .get(taskId, projectId) as Record<string, unknown> | undefined;
  if (!task) throw new Error(`Task not found: ${taskId}`);

  db.prepare("UPDATE tasks SET goal_id = ? WHERE id = ? AND project_id = ?")
    .run(goalId, taskId, projectId);
}

export function unlinkTaskFromGoal(projectId: string, taskId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare("UPDATE tasks SET goal_id = NULL WHERE id = ? AND project_id = ?")
    .run(taskId, projectId);
}

function rowToTask(row: Record<string, unknown>): Task {
  const task: Task = {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    state: row.state as Task["state"],
    priority: row.priority as Task["priority"],
    createdBy: row.created_by as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    retryCount: row.retry_count as number,
    maxRetries: row.max_retries as number,
  };
  if (row.description != null) task.description = row.description as string;
  if (row.assigned_to != null) task.assignedTo = row.assigned_to as string;
  if (row.deadline != null) task.deadline = row.deadline as number;
  if (row.workflow_id != null) task.workflowId = row.workflow_id as string;
  if (row.workflow_phase != null) task.workflowPhase = row.workflow_phase as number;
  if (row.parent_task_id != null) task.parentTaskId = row.parent_task_id as string;
  if (row.department != null) task.department = row.department as string;
  if (row.team != null) task.team = row.team as string;
  if (row.tags != null) {
    try { task.tags = JSON.parse(row.tags as string); } catch { /* ignore */ }
  }
  if (row.metadata != null) {
    try { task.metadata = JSON.parse(row.metadata as string); } catch { /* ignore */ }
  }
  return task;
}

export function getGoalTasks(projectId: string, goalId: string, dbOverride?: DatabaseSync): Task[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare("SELECT * FROM tasks WHERE goal_id = ? AND project_id = ? ORDER BY created_at ASC")
    .all(goalId, projectId) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

// --- Initiative budget helpers ---

/**
 * Walk up the goal hierarchy to find the root goal with an allocation > 0.
 * Returns null if no ancestor (including the goal itself) has an allocation.
 * Includes cycle protection via a visited set.
 */
export function findRootInitiative(projectId: string, goalId: string, dbOverride?: DatabaseSync): Goal | null {
  const db = dbOverride ?? getDb(projectId);
  const visited = new Set<string>();
  let currentId: string | undefined = goalId;

  while (currentId) {
    if (visited.has(currentId)) return null; // cycle detected
    visited.add(currentId);

    const goal = getGoal(projectId, currentId, db);
    if (!goal) return null;

    if (goal.allocation != null && goal.allocation > 0) return goal;

    currentId = goal.parentGoalId;
  }

  return null;
}

/**
 * Get today's total spend (in cents) for all tasks under a goal tree.
 * Collects all goal IDs recursively (BFS from rootGoalId down through children),
 * then sums cost_records for tasks linked to those goals created today.
 */
export function getInitiativeSpend(projectId: string, rootGoalId: string, dbOverride?: DatabaseSync): number {
  const db = dbOverride ?? getDb(projectId);

  // BFS to collect all goal IDs in the tree
  const goalIds: string[] = [];
  const queue: string[] = [rootGoalId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    goalIds.push(id);

    const children = db.prepare(
      "SELECT id FROM goals WHERE parent_goal_id = ? AND project_id = ?",
    ).all(id, projectId) as Record<string, unknown>[];

    for (const child of children) {
      queue.push(child.id as string);
    }
  }

  if (goalIds.length === 0) return 0;

  // Today's start timestamp (midnight local time)
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  // Build parameterized IN clause
  const placeholders = goalIds.map(() => "?").join(", ");

  const row = db.prepare(`
    SELECT COALESCE(SUM(cr.cost_cents), 0) as total
    FROM cost_records cr
    INNER JOIN tasks t ON cr.task_id = t.id AND t.project_id = cr.project_id
    WHERE t.goal_id IN (${placeholders})
      AND cr.project_id = ?
      AND cr.created_at >= ?
  `).get(...goalIds, projectId, todayStart) as Record<string, unknown> | undefined;

  return (row?.total as number) ?? 0;
}
