/**
 * Clawforce — Dashboard action status tracking
 *
 * Tracks the lifecycle of async dashboard actions (kill, config save, budget allocate)
 * so the SPA can show real status instead of relying on optimistic assumptions.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActionStatus = "accepted" | "in_progress" | "completed" | "failed";

export type ActionRecord = {
  id: string;
  projectId: string;
  action: string;
  status: ActionStatus;
  actor: string;
  detail?: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function ensureActionStatusTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      error TEXT
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_action_records_project
      ON action_records (project_id, started_at DESC)
  `);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value == null ? undefined : value;
}

function rowToRecord(row: Record<string, unknown>): ActionRecord {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    action: row.action as string,
    status: row.status as ActionStatus,
    actor: row.actor as string,
    detail: nullToUndefined(row.detail as string | null | undefined),
    startedAt: row.started_at as number,
    completedAt: nullToUndefined(row.completed_at as number | null | undefined),
    error: nullToUndefined(row.error as string | null | undefined),
  };
}

function resolveDb(projectId: string, db?: DatabaseSync): DatabaseSync {
  const resolved = db ?? getDb(projectId);
  ensureActionStatusTable(resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new action record with status "accepted".
 * Returns the generated action ID.
 */
export function createActionRecord(
  projectId: string,
  action: string,
  actor: string,
  detail?: string,
  db?: DatabaseSync,
): string {
  const resolved = resolveDb(projectId, db);
  const id = crypto.randomUUID();
  const now = Date.now();

  resolved.prepare(
    `INSERT INTO action_records (id, project_id, action, status, actor, detail, started_at)
     VALUES (?, ?, ?, 'accepted', ?, ?, ?)`,
  ).run(id, projectId, action, actor, detail ?? null, now);

  return id;
}

/**
 * Transition an action to a new status.
 * Optionally records an error message for "failed" transitions.
 */
export function updateActionStatus(
  actionId: string,
  status: ActionStatus,
  error?: string,
  db?: DatabaseSync,
): void {
  // We need the projectId to resolve the db. Look it up from the record first
  // if db is provided; otherwise we fall back to a raw update on the given db.
  if (db) {
    ensureActionStatusTable(db);
    const now = Date.now();
    const isTerminal = status === "completed" || status === "failed";
    db.prepare(
      `UPDATE action_records
       SET status = ?, completed_at = ?, error = ?
       WHERE id = ?`,
    ).run(
      status,
      isTerminal ? now : null,
      error ?? null,
      actionId,
    );
    return;
  }

  // Without a db hint we need to find which project this action belongs to.
  // This path is used when callers don't track the db (rare in practice).
  throw new Error(
    "updateActionStatus requires a db argument when called without a bound database. " +
    "Pass the same db used with createActionRecord.",
  );
}

/**
 * Retrieve a single action record by ID.
 */
export function getActionRecord(
  actionId: string,
  db: DatabaseSync,
): ActionRecord | undefined {
  ensureActionStatusTable(db);
  const row = db.prepare(
    "SELECT * FROM action_records WHERE id = ?",
  ).get(actionId) as Record<string, unknown> | undefined;

  return row ? rowToRecord(row) : undefined;
}

/**
 * List action records for a project with optional filtering.
 */
export function listActionRecords(
  projectId: string,
  opts?: {
    status?: ActionStatus;
    limit?: number;
    offset?: number;
  },
  db?: DatabaseSync,
): ActionRecord[] {
  const resolved = resolveDb(projectId, db);
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  let rows: Record<string, unknown>[];

  if (opts?.status) {
    rows = resolved.prepare(
      `SELECT * FROM action_records
       WHERE project_id = ? AND status = ?
       ORDER BY started_at DESC
       LIMIT ? OFFSET ?`,
    ).all(projectId, opts.status, limit, offset) as Record<string, unknown>[];
  } else {
    rows = resolved.prepare(
      `SELECT * FROM action_records
       WHERE project_id = ?
       ORDER BY started_at DESC
       LIMIT ? OFFSET ?`,
    ).all(projectId, limit, offset) as Record<string, unknown>[];
  }

  return rows.map(rowToRecord);
}

/**
 * Remove completed/failed action records older than maxAgeDays (default: 7).
 */
export function cleanupOldRecords(
  projectId: string,
  maxAgeDays = 7,
  db?: DatabaseSync,
): number {
  const resolved = resolveDb(projectId, db);
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const result = resolved.prepare(
    `DELETE FROM action_records
     WHERE project_id = ? AND status IN ('completed', 'failed') AND started_at < ?`,
  ).run(projectId, cutoff) as { changes?: number };

  return result.changes ?? 0;
}

/**
 * Wrap an async action with full status lifecycle tracking.
 *
 * Tracking is best-effort: if the DB is unavailable or the table setup fails,
 * the action still runs and the error is suppressed. This ensures action tracking
 * is pure observability and never breaks the guarded operation.
 *
 * 1. Creates an action record with status "accepted" (or reuses existingActionId)
 * 2. Transitions to "in_progress" immediately before running fn
 * 3. Transitions to "completed" on success or "failed" on error
 * 4. Returns { actionId, result } on success or re-throws on failure
 *
 * @param existingActionId - If provided, reuse this pre-created action record instead of creating a new one.
 *   Callers that need to return the actionId in a 202 response before background work runs should
 *   pre-create the record with createActionRecord and pass the ID here.
 */
export async function withActionTracking<T>(
  projectId: string,
  action: string,
  actor: string,
  fn: () => Promise<T>,
  db?: DatabaseSync,
  existingActionId?: string,
): Promise<{ actionId: string; result: T }> {
  let resolved: DatabaseSync | undefined;
  let actionId: string | undefined = existingActionId;

  // Tracking setup is non-fatal
  try {
    resolved = resolveDb(projectId, db);
    if (!actionId) {
      actionId = createActionRecord(projectId, action, actor, undefined, resolved);
    }
    updateActionStatus(actionId, "in_progress", undefined, resolved);
  } catch {
    /* tracking unavailable — proceed without it */
  }

  try {
    const result = await fn();
    if (resolved && actionId) {
      try { updateActionStatus(actionId, "completed", undefined, resolved); } catch { /* non-fatal */ }
    }
    return { actionId: actionId ?? crypto.randomUUID(), result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (resolved && actionId) {
      try { updateActionStatus(actionId, "failed", message, resolved); } catch { /* non-fatal */ }
    }
    throw err;
  }
}

/**
 * Synchronous variant of withActionTracking for use in sync action handlers.
 *
 * Tracking is best-effort: if the DB is unavailable, the action still runs.
 *
 * 1. Creates an action record with status "accepted" (or reuses existingActionId)
 * 2. Transitions to "in_progress" before running fn
 * 3. Transitions to "completed" on success or "failed" on error
 * 4. Returns { actionId, result } on success or re-throws on failure
 *
 * @param existingActionId - If provided, reuse this pre-created action record instead of creating a new one.
 */
export function withActionTrackingSync<T>(
  projectId: string,
  action: string,
  actor: string,
  fn: () => T,
  db?: DatabaseSync,
  existingActionId?: string,
): { actionId: string; result: T } {
  let resolved: DatabaseSync | undefined;
  let actionId: string | undefined = existingActionId;

  // Tracking setup is non-fatal
  try {
    resolved = resolveDb(projectId, db);
    if (!actionId) {
      actionId = createActionRecord(projectId, action, actor, undefined, resolved);
    }
    updateActionStatus(actionId, "in_progress", undefined, resolved);
  } catch {
    /* tracking unavailable — proceed without it */
  }

  try {
    const result = fn();
    if (resolved && actionId) {
      try { updateActionStatus(actionId, "completed", undefined, resolved); } catch { /* non-fatal */ }
    }
    return { actionId: actionId ?? crypto.randomUUID(), result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (resolved && actionId) {
      try { updateActionStatus(actionId, "failed", message, resolved); } catch { /* non-fatal */ }
    }
    throw err;
  }
}
