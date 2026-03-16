/**
 * Clawforce — Event store
 *
 * Pure CRUD + atomic claim for the events table.
 * Handles idempotent ingestion via dedup_key.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import type { ClawforceEvent, EventSource, EventStatus } from "../types.js";

function rowToEvent(row: Record<string, unknown>): ClawforceEvent {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    type: row.type as string,
    source: row.source as EventSource,
    payload: JSON.parse(row.payload as string),
    dedupKey: (row.dedup_key as string) ?? undefined,
    status: row.status as EventStatus,
    error: (row.error as string) ?? undefined,
    handledBy: (row.handled_by as string) ?? undefined,
    createdAt: row.created_at as number,
    processedAt: (row.processed_at as number) ?? undefined,
  };
}

/**
 * Ingest an event. If dedupKey is provided and an event with the same
 * (projectId, dedupKey) already exists, returns {id, deduplicated: true}.
 */
export function ingestEvent(
  projectId: string,
  type: string,
  source: EventSource,
  payload: Record<string, unknown>,
  dedupKey?: string,
  dbOverride?: DatabaseSync,
): { id: string; deduplicated: boolean } {
  const db = dbOverride ?? getDb(projectId);
  const id = crypto.randomUUID();
  const now = Date.now();

  // Use INSERT OR IGNORE with the unique index on (project_id, dedup_key) for atomic dedup
  if (dedupKey) {
    const result = db.prepare(`
      INSERT OR IGNORE INTO events (id, project_id, type, source, payload, dedup_key, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, projectId, type, source, JSON.stringify(payload), dedupKey, now);

    if (result.changes === 0) {
      // Row already exists — fetch existing ID
      const existing = db.prepare(
        "SELECT id FROM events WHERE project_id = ? AND dedup_key = ?",
      ).get(projectId, dedupKey) as Record<string, unknown>;
      return { id: existing.id as string, deduplicated: true };
    }
    return { id, deduplicated: false };
  }

  db.prepare(`
    INSERT INTO events (id, project_id, type, source, payload, dedup_key, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, projectId, type, source, JSON.stringify(payload), null, now);

  return { id, deduplicated: false };
}

/**
 * Atomically claim up to `limit` pending events for processing.
 * Sets status='processing' and returns the claimed events.
 */
export function claimPendingEvents(
  projectId: string,
  limit: number,
  dbOverride?: DatabaseSync,
  withinTransaction?: boolean,
): ClawforceEvent[] {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();

  // D2: Wrap SELECT + UPDATE in BEGIN IMMEDIATE to prevent double-claiming
  if (!withinTransaction) db.prepare("BEGIN IMMEDIATE").run();
  try {
    const pending = db.prepare(
      "SELECT id FROM events WHERE project_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT ?",
    ).all(projectId, limit) as Record<string, unknown>[];

    if (pending.length === 0) {
      if (!withinTransaction) db.prepare("ROLLBACK").run();
      return [];
    }

    const ids = pending.map((r) => r.id as string);
    const placeholders = ids.map(() => "?").join(", ");

    db.prepare(
      `UPDATE events SET status = 'processing', processed_at = ? WHERE id IN (${placeholders})`,
    ).run(now, ...ids);

    const rows = db.prepare(
      `SELECT * FROM events WHERE id IN (${placeholders})`,
    ).all(...ids) as Record<string, unknown>[];

    if (!withinTransaction) db.prepare("COMMIT").run();
    return rows.map(rowToEvent);
  } catch (err) {
    if (!withinTransaction) {
      try { db.prepare("ROLLBACK").run(); } catch { /* already rolled back */ }
    }
    throw err;
  }
}

/** Mark an event as handled. Requires a db instance (always called from the event router). */
export function markHandled(
  id: string,
  handledBy: string,
  db: DatabaseSync,
): void {
  db.prepare(
    "UPDATE events SET status = 'handled', handled_by = ?, processed_at = ? WHERE id = ?",
  ).run(handledBy, Date.now(), id);
}

/** Mark an event as failed. Requires a db instance (always called from the event router). */
export function markFailed(
  id: string,
  error: string,
  db: DatabaseSync,
): void {
  db.prepare(
    "UPDATE events SET status = 'failed', error = ?, processed_at = ? WHERE id = ?",
  ).run(error, Date.now(), id);
}

/** Mark an event as ignored. Requires a db instance (always called from the event router). */
export function markIgnored(
  id: string,
  db: DatabaseSync,
): void {
  db.prepare(
    "UPDATE events SET status = 'ignored', processed_at = ? WHERE id = ?",
  ).run(Date.now(), id);
}

/** Default threshold for considering a processing event stale. */
export const STALE_EVENT_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Reclaim events stuck in 'processing' state for longer than the threshold.
 * Returns the number of events reclaimed back to 'pending'.
 */
export function reclaimStaleEvents(
  projectId: string,
  staleThresholdMs: number = STALE_EVENT_THRESHOLD_MS,
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);
  const cutoff = Date.now() - staleThresholdMs;
  const result = db.prepare(
    "UPDATE events SET status = 'pending', processed_at = NULL WHERE project_id = ? AND status = 'processing' AND processed_at < ?",
  ).run(projectId, cutoff);
  return Number(result.changes);
}

/** Build WHERE clause and parameter values for event queries. */
function buildEventFilter(
  projectId: string,
  filter?: { status?: EventStatus; type?: string },
): { where: string; values: (string | number)[] } {
  const conditions: string[] = ["project_id = ?"];
  const values: (string | number)[] = [projectId];

  if (filter?.status) {
    conditions.push("status = ?");
    values.push(filter.status);
  }
  if (filter?.type) {
    conditions.push("type = ?");
    values.push(filter.type);
  }

  return { where: conditions.join(" AND "), values };
}

/** List events with optional filtering. */
export function listEvents(
  projectId: string,
  filter?: { status?: EventStatus; type?: string; limit?: number; offset?: number },
  dbOverride?: DatabaseSync,
): ClawforceEvent[] {
  const db = dbOverride ?? getDb(projectId);
  const { where, values } = buildEventFilter(projectId, filter);

  const limit = filter?.limit ?? 50;
  const offset = filter?.offset ?? 0;
  const sql = `SELECT * FROM events WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  values.push(limit, offset);

  const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

/** Count total events matching the given filters (ignoring pagination). */
export function countEvents(
  projectId: string,
  filter?: { status?: EventStatus; type?: string },
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);
  const { where, values } = buildEventFilter(projectId, filter);

  const sql = `SELECT COUNT(*) as total FROM events WHERE ${where}`;
  const row = db.prepare(sql).get(...values) as { total: number };
  return row.total;
}
