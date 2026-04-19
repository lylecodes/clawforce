/**
 * Clawforce — Dispatch queue
 *
 * SQLite-backed work queue with lease-based claiming.
 * Deduplicates on taskId (skips if a non-terminal item already exists).
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";
import { ingestEvent } from "../events/store.js";
import { recordMetric } from "../metrics.js";
import { writeAuditEntry } from "../audit.js";
import { getAgentConfig, getExtendedProjectConfig } from "../project.js";
import { checkQueueDepth } from "../safety.js";
import type { DispatchQueueItem, DispatchQueueStatus } from "../types.js";
import { replayRecurringJobTask } from "../scheduling/recurring-jobs.js";
import { resolveEffectiveConfig } from "../jobs.js";

type QueueTaskRow = {
  state?: unknown;
  priority?: unknown;
  origin?: unknown;
  origin_id?: unknown;
  metadata?: unknown;
  assigned_to?: unknown;
};

function normalizeDispatchPayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!payload) return payload;
  const normalized = { ...payload };
  const rawModel = normalized.model;
  if (typeof rawModel === "object" && rawModel !== null && !Array.isArray(rawModel)) {
    const primary = (rawModel as Record<string, unknown>).primary;
    if (typeof primary === "string" && primary.trim()) {
      normalized.model = primary.trim();
    }
  }
  return normalized;
}

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
    dispatchedAt: (row.dispatched_at as number) ?? undefined,
    completedAt: (row.completed_at as number) ?? undefined,
  };
}

function parseTaskMetadata(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

function taskPriorityToQueuePriority(priority: unknown): number {
  switch (priority) {
    case "P0": return 0;
    case "P1": return 1;
    case "P3": return 3;
    case "P2":
    default:
      return 2;
  }
}

function deriveQueuePriorityFromTask(taskRow: QueueTaskRow | undefined): number {
  const base = taskPriorityToQueuePriority(taskRow?.priority);
  const metadata = parseTaskMetadata(taskRow?.metadata);
  const isRecurring = !!(
    metadata
    && typeof metadata.recurringJob === "object"
    && metadata.recurringJob !== null
    && !Array.isArray(metadata.recurringJob)
  );
  if (isRecurring) {
    return Math.min(3, base + 1);
  }

  const origin = typeof taskRow?.origin === "string" ? taskRow.origin : null;
  const originId = typeof taskRow?.origin_id === "string" ? taskRow.origin_id : null;
  if (origin === "reactive" && originId) {
    return Math.max(0, base - 1);
  }

  return base;
}

function buildRetryPayload(
  projectId: string,
  taskRow: Pick<QueueTaskRow, "assigned_to" | "metadata"> | undefined,
  previousPayload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const payload = previousPayload ? { ...previousPayload } : {};
  const metadata = parseTaskMetadata(taskRow?.metadata);
  const recurringJob = metadata?.recurringJob;
  const jobName = recurringJob
    && typeof recurringJob === "object"
    && !Array.isArray(recurringJob)
    && typeof (recurringJob as Record<string, unknown>).jobName === "string"
    ? ((recurringJob as Record<string, unknown>).jobName as string).trim()
    : "";
  const assignedTo = typeof taskRow?.assigned_to === "string" ? taskRow.assigned_to.trim() : "";

  if (jobName) {
    payload.jobName = jobName;
  }

  if (assignedTo) {
    const agentEntry = getAgentConfig(assignedTo, projectId);
    const effectiveConfig = jobName && agentEntry?.config
      ? resolveEffectiveConfig(agentEntry.config, jobName) ?? agentEntry.config
      : agentEntry?.config;
    if (typeof effectiveConfig?.model === "string" && effectiveConfig.model.trim()) {
      payload.model = effectiveConfig.model.trim();
    }
  }

  return Object.keys(payload).length > 0 ? payload : undefined;
}

export function getQueueItem(
  projectId: string,
  id: string,
  dbOverride?: DatabaseSync,
): DispatchQueueItem | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(
    "SELECT * FROM dispatch_queue WHERE project_id = ? AND id = ? LIMIT 1",
  ).get(projectId, id) as Record<string, unknown> | undefined;
  return row ? rowToQueueItem(row) : null;
}

export function retryFailedItem(
  projectId: string,
  params: {
    taskId?: string;
    queueItemId?: string;
    actor?: string;
  },
  dbOverride?: DatabaseSync,
): { ok: true; previousItem: DispatchQueueItem; queueItem: DispatchQueueItem } | { ok: false; reason: string; queueItem?: DispatchQueueItem } {
  const db = dbOverride ?? getDb(projectId);
  const actor = params.actor ?? "operator:cli";

  const failedRow = params.queueItemId
    ? db.prepare(
      `SELECT * FROM dispatch_queue
       WHERE project_id = ? AND id = ? AND status = 'failed'
       LIMIT 1`,
    ).get(projectId, params.queueItemId) as Record<string, unknown> | undefined
    : db.prepare(
      `SELECT * FROM dispatch_queue
       WHERE project_id = ? AND task_id = ? AND status = 'failed'
       ORDER BY completed_at DESC, created_at DESC
       LIMIT 1`,
    ).get(projectId, params.taskId ?? null) as Record<string, unknown> | undefined;

  if (!failedRow) {
    return { ok: false, reason: "No failed dispatch item found for retry" };
  }

  const previousItem = rowToQueueItem(failedRow);

  const taskRow = db.prepare(
    "SELECT state, assigned_to, metadata FROM tasks WHERE project_id = ? AND id = ? LIMIT 1",
  ).get(projectId, previousItem.taskId) as Record<string, unknown> | undefined;

  if (!taskRow) {
    return { ok: false, reason: `Task not found for failed queue item ${previousItem.id}` };
  }

  const refreshedPayload = buildRetryPayload(projectId, taskRow as QueueTaskRow | undefined, previousItem.payload);

  const taskState = String(taskRow.state ?? "");
  if (taskState !== "ASSIGNED" && taskState !== "IN_PROGRESS") {
    const replay = replayRecurringJobTask(projectId, previousItem.taskId, actor, db);
    if (replay.ok) {
      const replayPayload = buildRetryPayload(projectId, {
        assigned_to: replay.task.assignedTo,
        metadata: replay.task.metadata,
      }, previousItem.payload);
      const queueItem = enqueue(
        projectId,
        replay.task.id,
        replayPayload,
        previousItem.priority,
        db,
        undefined,
        false,
        true,
      );
      if (!queueItem) {
        return { ok: false, reason: `Failed to requeue replayed recurring task ${replay.task.id}` };
      }

      try {
        writeAuditEntry({
          projectId,
          actor,
          action: "queue.retry.recurring_replay",
          targetType: "dispatch_queue",
          targetId: queueItem.id,
          detail: JSON.stringify({
            previousTaskId: previousItem.taskId,
            replayTaskId: replay.task.id,
            previousQueueItemId: previousItem.id,
          }),
        }, db);
      } catch (err) {
        safeLog("queue.retry.recurring.audit", err);
      }

      return {
        ok: true,
        previousItem,
        queueItem,
      };
    }

    return {
      ok: false,
      reason: replay.reason,
    };
  }

  const existingRow = db.prepare(
    `SELECT * FROM dispatch_queue
     WHERE project_id = ? AND task_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
     LIMIT 1`,
  ).get(projectId, previousItem.taskId) as Record<string, unknown> | undefined;

  if (existingRow) {
    return {
      ok: false,
      reason: `Task ${previousItem.taskId} already has active queue item ${String(existingRow.id)} (${String(existingRow.status)})`,
      queueItem: rowToQueueItem(existingRow),
    };
  }

  const queueItem = enqueue(
    projectId,
    previousItem.taskId,
    refreshedPayload,
    previousItem.priority,
    db,
    undefined,
    false,
    true,
  );

  if (!queueItem) {
    return { ok: false, reason: `Failed to requeue task ${previousItem.taskId}` };
  }

  try {
    writeAuditEntry({
      projectId,
      actor,
      action: "queue.retry",
      targetType: "dispatch_queue",
      targetId: queueItem.id,
      detail: JSON.stringify({
        taskId: previousItem.taskId,
        previousQueueItemId: previousItem.id,
      }),
    }, db);
  } catch (err) {
    safeLog("queue.retry.audit", err);
  }

  return {
    ok: true,
    previousItem,
    queueItem,
  };
}

export function releaseActiveItem(
  projectId: string,
  params: {
    taskId?: string;
    queueItemId?: string;
    actor?: string;
    reason?: string;
  },
  dbOverride?: DatabaseSync,
): {
  ok: true;
  previousItem: DispatchQueueItem;
  queueItem: DispatchQueueItem;
} | {
  ok: false;
  reason: string;
  queueItem?: DispatchQueueItem;
} {
  const db = dbOverride ?? getDb(projectId);
  const actor = params.actor ?? "operator:cli";

  const activeRow = params.queueItemId
    ? db.prepare(
      `SELECT * FROM dispatch_queue
       WHERE project_id = ? AND id = ? AND status IN ('leased', 'dispatched')
       LIMIT 1`,
    ).get(projectId, params.queueItemId) as Record<string, unknown> | undefined
    : db.prepare(
      `SELECT * FROM dispatch_queue
       WHERE project_id = ? AND task_id = ? AND status IN ('leased', 'dispatched')
       ORDER BY leased_at DESC, dispatched_at DESC, created_at DESC
       LIMIT 1`,
    ).get(projectId, params.taskId ?? null) as Record<string, unknown> | undefined;

  if (!activeRow) {
    return { ok: false, reason: "No active leased/dispatched queue item found for release" };
  }

  const previousItem = rowToQueueItem(activeRow);
  const taskRow = db.prepare(
    "SELECT state FROM tasks WHERE project_id = ? AND id = ? LIMIT 1",
  ).get(projectId, previousItem.taskId) as Record<string, unknown> | undefined;

  if (!taskRow) {
    return { ok: false, reason: `Task not found for active queue item ${previousItem.id}` };
  }

  const taskState = String(taskRow.state ?? "");
  if (taskState !== "ASSIGNED" && taskState !== "IN_PROGRESS") {
    return {
      ok: false,
      reason: `Task ${previousItem.taskId} is in ${taskState}, not releasable through queue release`,
      queueItem: previousItem,
    };
  }

  const reason = params.reason
    ?? `Operator released active queue item ${previousItem.id} back to queued`;
  releaseToQueued(previousItem.id, reason, db, projectId, { undoDispatchAttempt: false });
  const queueItem = getQueueItem(projectId, previousItem.id, db);
  if (!queueItem) {
    return { ok: false, reason: `Failed to reload queue item ${previousItem.id} after release` };
  }

  try {
    writeAuditEntry({
      projectId,
      actor,
      action: "queue.release",
      targetType: "dispatch_queue",
      targetId: queueItem.id,
      detail: JSON.stringify({
        taskId: previousItem.taskId,
        previousStatus: previousItem.status,
        reason,
      }),
    }, db);
  } catch (err) {
    safeLog("queue.release.audit", err);
  }

  return {
    ok: true,
    previousItem,
    queueItem,
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
  /** Skip the task-state guard (e.g. when dispatching a verifier for a REVIEW task). */
  skipStateCheck?: boolean,
  /** Skip the recent-failure dedup check (e.g. when re-enqueueing from sweep recovery). */
  skipFailedDedup?: boolean,
  /** Skip nested audit transactions when caller already holds a transaction. */
  withinTransaction?: boolean,
): DispatchQueueItem | null {
  const db = dbOverride ?? getDb(projectId);

  // Queue depth safety check — prevent runaway task creation from flooding the queue
  const depthCheck = checkQueueDepth(projectId, db);
  if (!depthCheck.ok) {
    return null;
  }

  // Skip tasks in non-dispatchable states — unless caller explicitly opts out
  let taskRow: QueueTaskRow | undefined;
  if (!skipStateCheck) {
    taskRow = db.prepare(
      "SELECT state, priority, origin, origin_id, metadata FROM tasks WHERE id = ? AND project_id = ?",
    ).get(taskId, projectId) as Record<string, unknown> | undefined;

    if (taskRow && ["DONE", "CANCELLED", "FAILED", "REVIEW", "BLOCKED"].includes(taskRow.state as string)) {
      return null;
    }
  } else {
    taskRow = db.prepare(
      "SELECT state, priority, origin, origin_id, metadata FROM tasks WHERE id = ? AND project_id = ?",
    ).get(taskId, projectId) as Record<string, unknown> | undefined;
  }

  // Dedup: check for existing non-terminal item
  const existing = db.prepare(
    `SELECT id FROM dispatch_queue
     WHERE project_id = ? AND task_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
     LIMIT 1`,
  ).get(projectId, taskId) as Record<string, unknown> | undefined;

  if (existing) return null;

  const id = crypto.randomUUID();
  const now = Date.now();

  // Dedup failed items: skip if there's a recent failed item for this task (within 5 minutes).
  // Apply exponential backoff — each consecutive failure doubles the cooldown (5m, 10m, 20m, ...).
  // Skipped when caller explicitly opts out (e.g. sweep recovery re-enqueue).
  if (!skipFailedDedup) {
    const FAILED_DEDUP_BASE_MS = 5 * 60 * 1000; // 5 minutes
    const recentFailed = db.prepare(
      `SELECT completed_at, dispatch_attempts FROM dispatch_queue
       WHERE project_id = ? AND task_id = ? AND status = 'failed'
       ORDER BY completed_at DESC LIMIT 1`,
    ).get(projectId, taskId) as Record<string, unknown> | undefined;

    if (recentFailed) {
      const failedAt = recentFailed.completed_at as number;
      const attempts = (recentFailed.dispatch_attempts as number) ?? 1;
      // Exponential backoff: 5m * 2^(attempts-1), capped at 60 minutes
      const backoffMs = Math.min(FAILED_DEDUP_BASE_MS * Math.pow(2, Math.max(0, attempts - 1)), 60 * 60 * 1000);
      if (now - failedAt < backoffMs) {
        return null;
      }
    }
  }

  const prio = priority ?? deriveQueuePriorityFromTask(taskRow);

  // Read max dispatch attempts from config, fall back to default 3
  let effectiveMaxDispatchAttempts = 3;
  try {
    const extConfig = getExtendedProjectConfig(projectId);
    if (extConfig?.dispatch?.maxDispatchAttempts != null) {
      effectiveMaxDispatchAttempts = extConfig.dispatch.maxDispatchAttempts;
    }
  } catch { /* project module may not be available during bootstrap */ }

  const normalizedPayload = normalizeDispatchPayload(payload);

  db.prepare(`
    INSERT INTO dispatch_queue (id, project_id, task_id, priority, payload, status, dispatch_attempts, max_dispatch_attempts, risk_tier, created_at)
    VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
  `).run(id, projectId, taskId, prio, normalizedPayload ? JSON.stringify(normalizedPayload) : null, effectiveMaxDispatchAttempts, riskTier ?? null, now);

  try {
    recordMetric({ projectId, type: "dispatch", subject: taskId, key: "queue_enqueue", value: 1, tags: { priority: prio, queueItemId: id } }, db);
  } catch (err) { safeLog("queue.enqueue.metric", err); }

  try {
    writeAuditEntry({
      projectId,
      actor: "system:dispatch",
      action: "queue.enqueue",
      targetType: "dispatch_queue",
      targetId: id,
      detail: JSON.stringify({ taskId, priority: prio }),
      withinTransaction,
    }, db);
  } catch (err) { safeLog("queue.enqueue.audit", err); }

  try {
    emitDiagnosticEvent({ type: "clawforce.queue.enqueue", projectId, taskId, queueItemId: id, priority: prio });
  } catch (err) { safeLog("queue.enqueue.diagnostic", err); }

  return rowToQueueItem(
    db.prepare("SELECT * FROM dispatch_queue WHERE id = ?").get(id) as Record<string, unknown>,
  );
}

const DEFAULT_LEASE_DURATION_MS = 15 * 60 * 1000; // 15 minutes

/** How long a dispatched item can sit before being considered stale (orphaned session). */
export const STALE_DISPATCHED_MS = 20 * 60 * 1000; // 20 minutes

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

  // Read queue lease from config, fall back to parameter, then default
  let effectiveLeaseDuration = leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  try {
    const extConfig = getExtendedProjectConfig(projectId);
    if (extConfig?.dispatch?.queueLeaseMs != null && leaseDurationMs == null) {
      effectiveLeaseDuration = extConfig.dispatch.queueLeaseMs;
    }
  } catch { /* project module may not be available during bootstrap */ }
  const expiresAt = now + effectiveLeaseDuration;
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
  options?: { withinTransaction?: boolean },
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
      writeAuditEntry({
        projectId,
        actor: "system:dispatch",
        action: "queue.lease_expired",
        targetType: "dispatch_queue",
        targetId: itemId,
        detail: JSON.stringify({ taskId, attempts, maxAttempts, outcome: exhausted ? "dead_letter" : "requeued" }),
        withinTransaction: options?.withinTransaction,
      }, db);
    } catch (err) { safeLog("queue.leaseExpired.audit", err); }

    reclaimed++;
  }

  // Also clean up stale dispatched items (sessions that never completed)
  const staleDispatched = db.prepare(
    `SELECT id, task_id FROM dispatch_queue
     WHERE project_id = ? AND status = 'dispatched'
       AND dispatched_at IS NOT NULL AND dispatched_at < ?`,
  ).all(projectId, now - STALE_DISPATCHED_MS) as Record<string, unknown>[];

  for (const row of staleDispatched) {
    const itemId = row.id as string;
    const taskId = row.task_id as string;

    db.prepare(
      `UPDATE dispatch_queue SET status = 'failed', last_error = 'Dispatched session never completed', completed_at = ?
       WHERE id = ?`,
    ).run(now, itemId);

    try {
      ingestEvent(projectId, "dispatch_dead_letter", "internal", {
        taskId, queueItemId: itemId, lastError: "Dispatched session never completed",
      }, `dead-letter:${itemId}`, db);
    } catch (err) { safeLog("queue.staleDispatch.deadLetter", err); }

    try {
      recordMetric({ projectId, type: "dispatch", subject: taskId, key: "queue_stale_dispatch", value: 1, tags: { queueItemId: itemId } }, db);
    } catch (err) { safeLog("queue.staleDispatch.metric", err); }

    reclaimed++;
  }

  return reclaimed;
}

/**
 * Mark a queue item as dispatched (cron job created, awaiting agent_end).
 * Clears lease fields — the item is no longer leased, but not yet completed.
 */
export function markDispatched(
  id: string,
  dbOverride?: DatabaseSync,
  projectId?: string,
): void {
  const db = dbOverride ?? getDb(projectId ?? "");
  const now = Date.now();
  db.prepare(
    `UPDATE dispatch_queue
     SET status = 'dispatched', leased_by = NULL, leased_at = NULL, lease_expires_at = NULL, dispatched_at = ?
     WHERE id = ?`,
  ).run(now, id);

  if (projectId) {
    try {
      writeAuditEntry({ projectId, actor: "system:dispatch", action: "queue.dispatched", targetType: "dispatch_queue", targetId: id }, db);
    } catch (err) { safeLog("queue.dispatched.audit", err); }
  }
}

/** Mark a queue item as completed. */
export function completeItem(
  id: string,
  dbOverride?: DatabaseSync,
  projectId?: string,
  options?: { withinTransaction?: boolean },
): void {
  const db = dbOverride ?? getDb(projectId ?? "");
  db.prepare(
    "UPDATE dispatch_queue SET status = 'completed', completed_at = ? WHERE id = ?",
  ).run(Date.now(), id);

  if (projectId) {
    try {
      writeAuditEntry({
        projectId,
        actor: "system:dispatch",
        action: "queue.complete",
        targetType: "dispatch_queue",
        targetId: id,
        withinTransaction: options?.withinTransaction,
      }, db);
    } catch (err) { safeLog("queue.complete.audit", err); }
  }
}

/** Mark a queue item as failed with an error. */
export function failItem(
  id: string,
  error: string,
  dbOverride?: DatabaseSync,
  projectId?: string,
  options?: { withinTransaction?: boolean },
): void {
  const db = dbOverride ?? getDb(projectId ?? "");
  db.prepare(
    "UPDATE dispatch_queue SET status = 'failed', last_error = ?, completed_at = ? WHERE id = ?",
  ).run(error, Date.now(), id);

  if (projectId) {
    try {
      writeAuditEntry({
        projectId,
        actor: "system:dispatch",
        action: "queue.fail",
        targetType: "dispatch_queue",
        targetId: id,
        detail: error.slice(0, 500),
        withinTransaction: options?.withinTransaction,
      }, db);
    } catch (err) { safeLog("queue.fail.audit", err); }
  }
}

/**
 * Release a leased item back to 'queued' status without incrementing attempts
 * or marking as failed. Used for transient infrastructure issues (e.g. cron
 * service not yet available) where the item should be retried on the next pass.
 *
 * Decrements dispatch_attempts to undo the increment from claimNext(),
 * ensuring the transient failure doesn't consume a retry slot.
 */
export function releaseToQueued(
  id: string,
  reason: string,
  dbOverride?: DatabaseSync,
  projectId?: string,
  options?: {
    withinTransaction?: boolean;
    undoDispatchAttempt?: boolean;
  },
): void {
  const db = dbOverride ?? getDb(projectId ?? "");
  const undoDispatchAttempt = options?.undoDispatchAttempt ?? true;
  if (undoDispatchAttempt) {
    db.prepare(
      `UPDATE dispatch_queue
       SET status = 'queued', leased_by = NULL, leased_at = NULL, lease_expires_at = NULL,
           last_error = ?, dispatch_attempts = MAX(0, dispatch_attempts - 1)
       WHERE id = ?`,
    ).run(reason, id);
  } else {
    db.prepare(
      `UPDATE dispatch_queue
       SET status = 'queued', leased_by = NULL, leased_at = NULL, lease_expires_at = NULL,
           last_error = ?
       WHERE id = ?`,
    ).run(reason, id);
  }

  if (projectId) {
    try {
      writeAuditEntry({
        projectId,
        actor: "system:dispatch",
        action: "queue.release_to_queued",
        targetType: "dispatch_queue",
        targetId: id,
        detail: reason.slice(0, 500),
        withinTransaction: options?.withinTransaction,
      }, db);
    } catch (err) { safeLog("queue.releaseToQueued.audit", err); }
  }
}

/** Cancel a queue item. */
export function cancelItem(
  id: string,
  dbOverride?: DatabaseSync,
  projectId?: string,
): void {
  const db = dbOverride ?? getDb(projectId ?? "");
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
  dispatched: number;
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
    // "dispatched" is items that have been handed to an agent session and are
    // actively running. Previously this was miscounted as 0 since the DB uses
    // "dispatched" but the return type only had "leased".
    dispatched: countMap["dispatched"] ?? 0,
    completed: countMap["completed"] ?? 0,
    failed: countMap["failed"] ?? 0,
    cancelled: countMap["cancelled"] ?? 0,
    recentItems: recentRows.map(rowToQueueItem),
  };
}
