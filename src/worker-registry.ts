/**
 * Clawforce — Worker assignment registry
 *
 * Tracks which agents have active task assignments. Used by the bootstrap
 * hook to detect worker sessions and inject task context + compliance tracking.
 *
 * Flow:
 * 1. createTask(assignedTo) or transitionTask(→ASSIGNED) → registerWorkerAssignment()
 * 2. agent:bootstrap fires → getWorkerAssignment() detects worker → injects context
 * 3. transitionTask(→DONE/FAILED) → clearWorkerAssignment()
 *
 * Assignments are persisted to SQLite (worker_assignments table) and cached
 * in-memory for fast lookups. On cache miss, the DB is consulted.
 */

import type { DatabaseSync } from "./sqlite-driver.js";
import { getDb } from "./db.js";
import { safeLog } from "./diagnostics.js";
import { getActiveProjectIds } from "./lifecycle.js";
import { getDefaultRuntimeState } from "./runtime/default-runtime.js";

type WorkerAssignment = {
  projectId: string;
  taskId: string;
  assignedAt: number;
};

type LeaseAcquirer = (
  projectId: string,
  taskId: string,
  holder: string,
  durationMs: number,
  db?: DatabaseSync,
) => boolean;

type WorkerRegistryRuntimeState = {
  assignments: Map<string, WorkerAssignment>;
  acquireLease: LeaseAcquirer | null;
};

const runtime = getDefaultRuntimeState();

function getWorkerRegistryState(): WorkerRegistryRuntimeState {
  return runtime.workerRegistry as WorkerRegistryRuntimeState;
}

/** Set the lease acquisition function. Called during init to break circular imports. */
export function setLeaseAcquirer(fn: LeaseAcquirer | null): void {
  getWorkerRegistryState().acquireLease = fn;
}

const DEFAULT_WORKER_LEASE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Register that an agent has been assigned a task.
 * Called automatically from createTask/transitionTask when a task gets an assignee.
 * Also acquires a task lease for durability across process restarts.
 */
export function registerWorkerAssignment(
  assignedTo: string,
  projectId: string,
  taskId: string,
  dbOverride?: DatabaseSync,
): void {
  const now = Date.now();
  const state = getWorkerRegistryState();
  state.assignments.set(assignedTo, { projectId, taskId, assignedAt: now });

  // Persist to DB
  try {
    const db = dbOverride ?? getDb(projectId);
    db.prepare(
      `INSERT OR REPLACE INTO worker_assignments (agent_id, project_id, task_id, assigned_at)
       VALUES (?, ?, ?, ?)`,
    ).run(assignedTo, projectId, taskId, now);
  } catch (err) {
    safeLog("worker-registry.persist", err);
  }

  // Also acquire a task lease for durability
  if (state.acquireLease) {
    try {
      state.acquireLease(projectId, taskId, assignedTo, DEFAULT_WORKER_LEASE_MS, dbOverride);
    } catch (err) {
      safeLog("worker-registry.lease", err);
    }
  }
}

/**
 * Look up the active task assignment for an agent.
 * Returns null if the agent has no active assignment.
 * On cache miss, queries DB across active projects and verifies
 * the task is still in a non-terminal state.
 */
export function getWorkerAssignment(
  agentId: string,
  dbOverride?: DatabaseSync,
): { projectId: string; taskId: string } | null {
  // Check in-memory cache first
  const state = getWorkerRegistryState();
  const entry = state.assignments.get(agentId);
  if (entry) return { projectId: entry.projectId, taskId: entry.taskId };

  // Cache miss — try DB recovery
  try {
    const projectIds = getActiveProjectIds();
    for (const projectId of projectIds) {
      const db = dbOverride ?? getDb(projectId);
      const row = db.prepare(
        "SELECT project_id, task_id, assigned_at FROM worker_assignments WHERE agent_id = ?",
      ).get(agentId) as Record<string, unknown> | undefined;

      if (row) {
        const taskId = row.task_id as string;
        // Verify task is still active (not terminal)
        const taskRow = db.prepare(
          "SELECT state FROM tasks WHERE id = ?",
        ).get(taskId) as Record<string, unknown> | undefined;

        const taskState = taskRow?.state as string | undefined;
        if (taskState && taskState !== "DONE" && taskState !== "FAILED" && taskState !== "CANCELLED") {
          // Re-populate cache
          state.assignments.set(agentId, {
            projectId: row.project_id as string,
            taskId,
            assignedAt: row.assigned_at as number,
          });
          return { projectId: row.project_id as string, taskId };
        }

        // Task is terminal — clean up stale assignment
        try {
          db.prepare("DELETE FROM worker_assignments WHERE agent_id = ?").run(agentId);
        } catch (err) { safeLog("worker-registry.staleCleanup", err); }
        return null;
      }
    }
  } catch (err) {
    safeLog("worker-registry.dbLookup", err);
  }

  return null;
}

/**
 * Clear the assignment for an agent (task completed or failed).
 */
export function clearWorkerAssignment(assignedTo: string, dbOverride?: DatabaseSync): void {
  const state = getWorkerRegistryState();
  const entry = state.assignments.get(assignedTo);
  state.assignments.delete(assignedTo);

  // Remove from DB
  try {
    if (entry) {
      const db = dbOverride ?? getDb(entry.projectId);
      db.prepare("DELETE FROM worker_assignments WHERE agent_id = ?").run(assignedTo);
    } else {
      // No cache entry — try all active projects
      const projectIds = getActiveProjectIds();
      for (const projectId of projectIds) {
        const db = dbOverride ?? getDb(projectId);
        const result = db.prepare("DELETE FROM worker_assignments WHERE agent_id = ?").run(assignedTo);
        if (result.changes > 0) break;
      }
    }
  } catch (err) {
    safeLog("worker-registry.clearDb", err);
  }
}

/**
 * List all current worker assignments.
 * Used by the ops tool for runtime visibility.
 */
export function listAllAssignments(): Array<{
  agentId: string; projectId: string; taskId: string; assignedAt: number;
}> {
  return [...getWorkerRegistryState().assignments.entries()].map(([agentId, entry]) => ({
    agentId, ...entry,
  }));
}

/**
 * Clear all assignments (for testing).
 */
export function resetWorkerRegistryForTest(): void {
  const state = getWorkerRegistryState();
  state.assignments.clear();
  state.acquireLease = null;
}
