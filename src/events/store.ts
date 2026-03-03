/**
 * Clawforce — Event store
 *
 * Pure CRUD + atomic claim for the events table.
 * Handles idempotent ingestion via dedup_key.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import type { ClawforceEvent, EventSource, EventStatus, EventType } from "../types.js";

function rowToEvent(row: Record<string, unknown>): ClawforceEvent {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    type: row.type as EventType,
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
  type: EventType,
  source: EventSource,
  payload: Record<string, unknown>,
  dedupKey?: string,
  dbOverride?: DatabaseSync,
): { id: string; deduplicated: boolean } {
  const db = dbOverride ?? getDb(projectId);

  // Check dedup
  if (dedupKey) {
    const existing = db.prepare(
      "SELECT id FROM events WHERE project_id = ? AND dedup_key = ?",
    ).get(projectId, dedupKey) as Record<string, unknown> | undefined;
    if (existing) {
      return { id: existing.id as string, deduplicated: true };
    }
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO events (id, project_id, type, source, payload, dedup_key, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, projectId, type, source, JSON.stringify(payload), dedupKey ?? null, now);

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
): ClawforceEvent[] {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();

  // Select pending events ordered by creation time
  const pending = db.prepare(
    "SELECT id FROM events WHERE project_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT ?",
  ).all(projectId, limit) as Record<string, unknown>[];

  if (pending.length === 0) return [];

  const ids = pending.map((r) => r.id as string);
  const placeholders = ids.map(() => "?").join(", ");

  // Atomically update to processing
  db.prepare(
    `UPDATE events SET status = 'processing', processed_at = ? WHERE id IN (${placeholders})`,
  ).run(now, ...ids);

  // Return the claimed events
  const rows = db.prepare(
    `SELECT * FROM events WHERE id IN (${placeholders})`,
  ).all(...ids) as Record<string, unknown>[];

  return rows.map(rowToEvent);
}

/** Mark an event as handled. */
export function markHandled(
  id: string,
  handledBy: string,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb("");
  db.prepare(
    "UPDATE events SET status = 'handled', handled_by = ?, processed_at = ? WHERE id = ?",
  ).run(handledBy, Date.now(), id);
}

/** Mark an event as failed. */
export function markFailed(
  id: string,
  error: string,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb("");
  db.prepare(
    "UPDATE events SET status = 'failed', error = ?, processed_at = ? WHERE id = ?",
  ).run(error, Date.now(), id);
}

/** Mark an event as ignored. */
export function markIgnored(
  id: string,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb("");
  db.prepare(
    "UPDATE events SET status = 'ignored', processed_at = ? WHERE id = ?",
  ).run(Date.now(), id);
}

/** List events with optional filtering. */
export function listEvents(
  projectId: string,
  filter?: { status?: EventStatus; type?: EventType; limit?: number },
  dbOverride?: DatabaseSync,
): ClawforceEvent[] {
  const db = dbOverride ?? getDb(projectId);
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

  const limit = filter?.limit ?? 50;
  const sql = `SELECT * FROM events WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;
  values.push(limit);

  const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}
