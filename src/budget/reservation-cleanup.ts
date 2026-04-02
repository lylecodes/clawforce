/**
 * Clawforce — Stale Reservation Cleanup
 *
 * Releases reserved_cents from queue items stuck in 'leased' status
 * for longer than the stale threshold (default 4 hours).
 * Prevents budget being held indefinitely by crashed/abandoned sessions.
 */

import type { DatabaseSync } from "node:sqlite";
import { safeLog } from "../diagnostics.js";
import { recordMetric } from "../metrics.js";
import { writeAuditEntry } from "../audit.js";

/** Default timeout before a leased item's reservation is considered stale: 4 hours. */
const STALE_RESERVATION_MS = 4 * 3600_000;

/**
 * Find queue items in 'leased' status that haven't been updated for longer
 * than the stale threshold, release their reserved budget, and mark them
 * as failed with reason "reservation_timeout".
 *
 * Returns the number of stale reservations released.
 */
export function releaseStaleReservations(
  db: DatabaseSync,
  projectId: string,
  staleMs: number = STALE_RESERVATION_MS,
): number {
  const cutoff = Date.now() - staleMs;
  const now = Date.now();

  // Find leased items where leased_at is older than the cutoff.
  // These are sessions that were claimed but never completed or failed.
  const staleItems = db.prepare(
    `SELECT id, task_id, leased_at FROM dispatch_queue
     WHERE project_id = ? AND status = 'leased' AND leased_at IS NOT NULL AND leased_at < ?`,
  ).all(projectId, cutoff) as Array<{ id: string; task_id: string; leased_at: number }>;

  if (staleItems.length === 0) return 0;

  let released = 0;

  for (const item of staleItems) {
    // Mark the queue item as failed with reservation_timeout reason
    db.prepare(
      `UPDATE dispatch_queue
       SET status = 'failed', last_error = 'reservation_timeout', completed_at = ?,
           leased_by = NULL, leased_at = NULL, lease_expires_at = NULL
       WHERE id = ? AND status = 'leased'`,
    ).run(now, item.id);

    released++;

    safeLog("reservation-cleanup", `Released stale reservation: queue item ${item.id} (task ${item.task_id}), leased ${Math.round((now - item.leased_at) / 3600_000)}h ago`);

    try {
      recordMetric({
        projectId,
        type: "dispatch",
        subject: item.task_id,
        key: "reservation_timeout",
        value: 1,
        tags: { queueItemId: item.id, staleDurationMs: now - item.leased_at },
      }, db);
    } catch (err) { safeLog("reservation-cleanup.metric", err); }

    try {
      writeAuditEntry({
        projectId,
        actor: "system:sweep",
        action: "queue.reservation_timeout",
        targetType: "dispatch_queue",
        targetId: item.id,
        detail: JSON.stringify({
          taskId: item.task_id,
          leasedAt: item.leased_at,
          staleDurationMs: now - item.leased_at,
        }),
      }, db);
    } catch (err) { safeLog("reservation-cleanup.audit", err); }
  }

  // Release any project-level reserved_cents that may be held.
  // We zero out all reservations for this project since stale leased items
  // indicate the reservation tracking is out of sync. The budget check-v2
  // will recalculate from active plans on the next pass.
  if (released > 0) {
    try {
      db.prepare(
        `UPDATE budgets SET
           reserved_cents = MAX(0, reserved_cents - (SELECT COUNT(*) FROM dispatch_queue WHERE project_id = ? AND status = 'failed' AND last_error = 'reservation_timeout' AND completed_at = ?)),
           updated_at = ?
         WHERE project_id = ? AND agent_id IS NULL`,
      ).run(projectId, now, now, projectId);
    } catch (err) {
      safeLog("reservation-cleanup.budgetRelease", err);
    }
  }

  return released;
}
