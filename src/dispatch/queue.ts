/**
 * Clawforce — Dispatch queue
 *
 * SQLite-backed work queue with lease-based claiming.
 * Deduplicates on taskId (skips if a non-terminal item already exists).
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";
import { ingestEvent } from "../events/store.js";
import { recordMetric } from "../metrics.js";
import { writeAuditEntry } from "../audit.js";
import type { DispatchQueueItem, DispatchQueueStatus } from "../types.js";

function rowToQueueItem(row: Record<string, unknown>): DispatchQueueItem {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    taskId: row.task_id as string,
    priority: row.priority as number,
    payload: row.payload ? JSON.parse(row.payload as string) : undefined,
    status: row.status as DispatchQueueStatus,
    leasedBy: (row.leased_by as string) ?? undefined,
    leasedAt: (row.leased_at as number) ?? undefined,
    leaseExpiresAt: (row.lease_expires_at as number) ?? undefined,
    dispatchAttempts: row.dispatch_attempts as number,
    maxDispatchAttempts: row.max_dispatch_attempts as number,
    lastError: (row.last_error as string) ?? undefined,
    createdAt: row.created_at as number,
    completedAt: (row.completed_at as number) ?? undefined,
  };
}

const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];

/**
 * Enqueue a task for dispatch. Deduplicates: skips if a non-terminal
 * queue item already exists for this taskId.
 */
export function enqueue(
  projectId: string,
  taskId: string,
  payload?: Record<string, unknown>,
  priority?: number,
  dbOverride?: DatabaseSync,
  riskTier?: string,
): DispatchQueueItem | null {
  const db = dbOverride ?? getDb(projectId);

  // Dedup: check for existing non-terminal item
  const existing = db.prepare(
    `SELECT id FROM dispatch_queue
     WHERE project_id = ? AND task_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
     LIMIT 1`,
  ).get(projectId, taskId) as Record<string, unknown> | undefined;

  if (existing) return null;

  const id = crypto.randomUUID();
  const now = Date.now();

  const prio = priority ?? 2;
  db.prepare(`
    INSERT INTO dispatch_queue (id, project_id, task_id, priority, payload, status, dispatch_attempts, max_dispatch_attempts, risk_tier, created_at)
    VALUES (?, ?, ?, ?, ?, 'queued', 0, 3, ?, ?)
  `).run(id, projectId, taskId, prio, payload ? JSON.stringify(payload) : null, riskTier ?? null, now);

  try {
    recordMetric({ projectId, type: "dispatch", subject: taskId, key: "queue_enqueue", value: 1, tags: { priority: prio, queueItemId: id } }, db);
  } catch (err) { safeLog("queue.enqueue.metric", err); }

  try {
    writeAuditEntry({ projectId, actor: "system:dispatch", action: "queue.enqueue", targetType: "dispatch_queue", targetId: id, detail: JSON.stringify({ taskId, priority: prio }) }, db);
  } catch (err) { safeLog("queue.enqueue.audit", err); }

  try {
    emitDiagnosticEvent({ type: "clawforce.queue.enqueue", projectId, taskId, queueItemId: id, priority: prio });
  } catch (err) { safeLog("queue.enqueue.diagnostic", err); }

  return rowToQueueItem(
    db.prepare("SELECT * FROM dispatch_queue WHERE id = ?").get(id) as Record<string, unknown>,
  );
}

const DEFAULT_LEASE_DURATION_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Atomically claim the next queued item, ordered by priority (ascending) then FIFO.
 * Sets status='leased' and assigns a lease expiration.
 */
export function claimNext(
  projectId: string,
  leaseDurationMs?: number,
  leasedBy?: string,
  dbOverride?: DatabaseSync,
): DispatchQueueItem | null {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const expiresAt = now + (leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS);
  const holder = leasedBy ?? `dispatcher:${process.pid}`;

  // Find the next queued item
  const candidate = db.prepare(
    `SELECT id FROM dispatch_queue
     WHERE project_id = ? AND status = 'queued'
     ORDER BY priority ASC, created_at ASC
     LIMIT 1`,
  ).get(projectId) as Record<string, unknown> | undefined;

  if (!candidate) return null;

  const candidateId = candidate.id as string;

  // Atomic claim: only succeeds if still queued
  const result = db.prepare(
    `UPDATE dispatch_queue
     SET status = 'leased', leased_by = ?, leased_at = ?, lease_expires_at = ?, dispatch_attempts = dispatch_attempts + 1
     WHERE id = ? AND status = 'queued'`,
  ).run(holder, now, expiresAt, candidateId);

  if (result.changes === 0) return null;

  const claimed = rowToQueueItem(
    db.prepare("SELECT * FROM dispatch_queue WHERE id = ?").get(candidateId) as Record<string, unknown>,
  );

  try {
    const waitTimeMs = now - claimed.createdAt;
    recordMetric({ projectId, type: "dispatch", subject: claimed.taskId, key: "queue_wait_time", value: waitTimeMs, unit: "ms", tags: { queueItemId: candidateId, attempt: claimed.dispatchAttempts } }, db);
  } catch (err) { safeLog("queue.claim.metric", err); }

  try {
    writeAuditEntry({ projectId, actor: holder, action: "queue.claim", targetType: "dispatch_queue", targetId: candidateId, detail: JSON.stringify({ taskId: claimed.taskId, attempt: claimed.dispatchAttempts, leaseExpiresAt: expiresAt }) }, db);
  } catch (err) { safeLog("queue.claim.audit", err); }

  return claimed;
}

/**
 * Reclaim expired leases: reset to 'queued' if attempts remain,
 * or 'failed' if max attempts exhausted.
 * Returns the number of items reclaimed.
 */
export function reclaimExpiredLeases(
  projectId: string,
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();

  // Find expired leases
  const expired = db.prepare(
    `SELECT id, task_id, dispatch_attempts, max_dispatch_attempts FROM dispatch_queue
     WHERE project_id = ? AND status = 'leased' AND lease_expires_at < ?`,
  ).all(projectId, now) as Record<string, unknown>[];

  let reclaimed = 0;

  for (const row of expired) {
    const itemId = row.id as string;
    const taskId = row.task_id as string;
    const attempts = row.dispatch_attempts as number;
    const maxAttempts = row.max_dispatch_attempts as number;
    const exhausted = attempts >= maxAttempts;

    if (exhausted) {
      // Exhausted — mark as failed
      db.prepare(
        `UPDATE dispatch_queue SET status = 'failed', last_error = 'Lease expired after max attempts', completed_at = ?
         WHERE id = ?`,
      ).run(now, itemId);

      // Emit dead letter event
      try {
        ingestEvent(projectId, "dispatch_dead_letter", "internal", {
          taskId,
          queueItemId: itemId,
          attempts: maxAttempts,
          lastError: "Lease expired after max attempts",
        }, `dead-letter:${itemId}`, db);
      } catch (err) {
        safeLog("queue.deadLetter", err);
      }
    } else {
      // Reset to queued
      db.prepare(
        `UPDATE dispatch_queue SET status = 'queued', leased_by = NULL, leased_at = NULL, lease_expires_at = NULL
         WHERE id = ?`,
      ).run(itemId);
    }

    try {
      recordMetric({ projectId, type: "dispatch", subject: taskId, key: "queue_lease_expired", value: 1, tags: { queueItemId: itemId, exhausted, attempts } }, db);
    } catch (err) { safeLog("queue.leaseExpired.metric", err); }

    try {
      writeAuditEntry({ projectId, actor: "system:dispatch", action: "queue.lease_expired", targetType: "dispatch_queue", targetId: itemId, detail: JSON.stringify({ taskId, attempts, maxAttempts, outcome: exhausted ? "dead_letter" : "requeued" }) }, db);
    } catch (err) { safeLog("queue.leaseExpired.audit", err); }

    reclaimed++;
  }

  return reclaimed;
}

/** Mark a queue item as completed. */
export function completeItem(
  id: string,
  dbOverride?: DatabaseSync,
  projectId?: string,
): void {
  const db = dbOverride ?? getDb("");
  db.prepare(
    "UPDATE dispatch_queue SET status = 'completed', completed_at = ? WHERE id = ?",
  ).run(Date.now(), id);

  if (projectId) {
    try {
      writeAuditEntry({ projectId, actor: "system:dispatch", action: "queue.complete", targetType: "dispatch_queue", targetId: id }, db);
    } catch (err) { safeLog("queue.complete.audit", err); }
  }
}

/** Mark a queue item as failed with an error. */
export function failItem(
  id: string,
  error: string,
  dbOverride?: DatabaseSync,
  projectId?: string,
): void {
  const db = dbOverride ?? getDb("");
  db.prepare(
    "UPDATE dispatch_queue SET status = 'failed', last_error = ?, completed_at = ? WHERE id = ?",
  ).run(error, Date.now(), id);

  if (projectId) {
    try {
      writeAuditEntry({ projectId, actor: "system:dispatch", action: "queue.fail", targetType: "dispatch_queue", targetId: id, detail: error.slice(0, 500) }, db);
    } catch (err) { safeLog("queue.fail.audit", err); }
  }
}

/** Cancel a queue item. */
export function cancelItem(
  id: string,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb("");
  db.prepare(
    "UPDATE dispatch_queue SET status = 'cancelled', completed_at = ? WHERE id = ?",
  ).run(Date.now(), id);
}

/** Get queue status summary for a project. */
export function getQueueStatus(
  projectId: string,
  dbOverride?: DatabaseSync,
): {
  queued: number;
  leased: number;
  completed: number;
  failed: number;
  cancelled: number;
  recentItems: DispatchQueueItem[];
} {
  const db = dbOverride ?? getDb(projectId);

  const counts = db.prepare(
    `SELECT status, COUNT(*) as cnt FROM dispatch_queue
     WHERE project_id = ? GROUP BY status`,
  ).all(projectId) as Record<string, unknown>[];

  const countMap: Record<string, number> = {};
  for (const row of counts) {
    countMap[row.status as string] = row.cnt as number;
  }

  const recentRows = db.prepare(
    `SELECT * FROM dispatch_queue WHERE project_id = ?
     ORDER BY created_at DESC LIMIT 10`,
  ).all(projectId) as Record<string, unknown>[];

  return {
    queued: countMap["queued"] ?? 0,
    leased: countMap["leased"] ?? 0,
    completed: countMap["completed"] ?? 0,
    failed: countMap["failed"] ?? 0,
    cancelled: countMap["cancelled"] ?? 0,
    recentItems: recentRows.map(rowToQueueItem),
  };
}
