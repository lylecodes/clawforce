/**
 * Clawforce — Gateway restart recovery
 *
 * Recovers orphaned state after a gateway restart:
 * - Releases stale IN_PROGRESS tasks back to ASSIGNED
 * - Fails dispatch queue items stuck in "dispatched" state
 * - Releases expired task leases on ASSIGNED tasks
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { transitionTask, releaseTaskLease } from "../tasks/ops.js";
import { failItem } from "./queue.js";

export type RecoveryResult = {
  staleTasks: number;
  failedDispatches: number;
  releasedLeases: number;
};

/**
 * Release tasks stuck in IN_PROGRESS with no backing session.
 * After a restart, all sessions are dead — any IN_PROGRESS task is orphaned.
 */
export function releaseStaleInProgressTasks(
  projectId: string,
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);
  let released = 0;

  try {
    const staleTasks = db.prepare(
      `SELECT id, assigned_to, lease_holder FROM tasks
       WHERE project_id = ? AND state = 'IN_PROGRESS'`,
    ).all(projectId) as { id: string; assigned_to: string | null; lease_holder: string | null }[];

    for (const task of staleTasks) {
      try {
        // Release lease first if held
        if (task.lease_holder) {
          releaseTaskLease(projectId, task.id, task.lease_holder, db);
        }
        // Transition back to ASSIGNED so it can be re-dispatched
        const result = transitionTask({
          projectId,
          taskId: task.id,
          toState: "ASSIGNED",
          actor: "system:restart-recovery",
          reason: "Released after gateway restart — no active session",
        }, db);
        if (result.ok) released++;
      } catch (err) {
        safeLog("restart-recovery.releaseTask", err);
      }
    }
  } catch (err) {
    safeLog("restart-recovery.staleTasks", err);
  }

  return released;
}

/**
 * Fail dispatch queue items that were in "dispatched" or "leased" state
 * before the gateway restart. These items will never receive a response.
 */
export function failStaleDispatchItems(
  projectId: string,
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);
  let failed = 0;

  try {
    // Items that were leased (dispatched) but not completed
    const staleItems = db.prepare(
      `SELECT id FROM dispatch_queue
       WHERE project_id = ? AND status IN ('queued', 'dispatched')
       AND leased_at IS NOT NULL`,
    ).all(projectId) as { id: string }[];

    for (const item of staleItems) {
      try {
        failItem(item.id, "Stale after gateway restart — session no longer exists", db, projectId);
        failed++;
      } catch (err) {
        safeLog("restart-recovery.failDispatch", err);
      }
    }
  } catch (err) {
    safeLog("restart-recovery.staleDispatches", err);
  }

  return failed;
}

/**
 * Release expired leases on ASSIGNED tasks.
 * These tasks were leased to an agent that never started working.
 */
export function releaseExpiredAssignedLeases(
  projectId: string,
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  let released = 0;

  try {
    const expiredTasks = db.prepare(
      `SELECT id, lease_holder FROM tasks
       WHERE project_id = ? AND state = 'ASSIGNED'
       AND lease_holder IS NOT NULL
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < ?`,
    ).all(projectId, now) as { id: string; lease_holder: string }[];

    for (const task of expiredTasks) {
      try {
        releaseTaskLease(projectId, task.id, task.lease_holder, db);
        released++;
      } catch (err) {
        safeLog("restart-recovery.releaseLease", err);
      }
    }
  } catch (err) {
    safeLog("restart-recovery.expiredLeases", err);
  }

  return released;
}

/**
 * Run all recovery steps for a project after gateway restart.
 */
export function recoverProject(
  projectId: string,
  dbOverride?: DatabaseSync,
): RecoveryResult {
  const staleTasks = releaseStaleInProgressTasks(projectId, dbOverride);
  const failedDispatches = failStaleDispatchItems(projectId, dbOverride);
  const releasedLeases = releaseExpiredAssignedLeases(projectId, dbOverride);

  return { staleTasks, failedDispatches, releasedLeases };
}
