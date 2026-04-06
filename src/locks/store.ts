/**
 * Clawforce — Lock store
 *
 * Persistent lock storage for config surfaces. Humans can lock surfaces
 * to prevent agents from modifying them, encoding the product stance that
 * humans can intervene at any level.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The set of surfaces that can be locked. */
export type LockSurface =
  | "budget"
  | "agent-enabled"
  | "org-structure"
  | "rules"
  | "jobs"
  | "tool-gates"
  | "direction"
  | "standards"
  | "policies";

export type LockEntry = {
  id: string;
  projectId: string;
  surface: string;
  lockedBy: string;
  lockedAt: number;
  reason?: string;
};

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

export function ensureLockTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS locks (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      surface TEXT NOT NULL,
      locked_by TEXT NOT NULL,
      locked_at INTEGER NOT NULL,
      reason TEXT,
      PRIMARY KEY (id),
      UNIQUE (project_id, surface)
    )
  `);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Acquire a lock on a surface for a project.
 * Throws if the surface is already locked by a different actor.
 */
export function acquireLock(
  projectId: string,
  surface: string,
  lockedBy: string,
  reason?: string,
  dbOverride?: DatabaseSync,
): LockEntry {
  const db = dbOverride ?? getDb(projectId);
  ensureLockTable(db);

  const existing = getLock(projectId, surface, db);
  if (existing) {
    throw new Error(
      `Surface "${surface}" is already locked by "${existing.lockedBy}" in project "${projectId}"`,
    );
  }

  const id = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO locks (id, project_id, surface, locked_by, locked_at, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, projectId, surface, lockedBy, now, reason ?? null);

  return { id, projectId, surface, lockedBy, lockedAt: now, reason };
}

/**
 * Release a lock on a surface.
 * Only the actor who owns the lock (or a human/admin) should call this.
 * Does not throw if no lock exists.
 */
export function releaseLock(
  projectId: string,
  surface: string,
  _actor: string,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  ensureLockTable(db);
  db.prepare(
    "DELETE FROM locks WHERE project_id = ? AND surface = ?",
  ).run(projectId, surface);
}

/**
 * Get the current lock entry for a surface, or null if unlocked.
 */
export function getLock(
  projectId: string,
  surface: string,
  dbOverride?: DatabaseSync,
): LockEntry | null {
  const db = dbOverride ?? getDb(projectId);
  ensureLockTable(db);

  const row = db.prepare(
    "SELECT id, project_id, surface, locked_by, locked_at, reason FROM locks WHERE project_id = ? AND surface = ?",
  ).get(projectId, surface) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: row.id as string,
    projectId: row.project_id as string,
    surface: row.surface as string,
    lockedBy: row.locked_by as string,
    lockedAt: row.locked_at as number,
    reason: (row.reason as string) ?? undefined,
  };
}

/**
 * List all active locks for a project.
 */
export function listLocks(
  projectId: string,
  dbOverride?: DatabaseSync,
): LockEntry[] {
  const db = dbOverride ?? getDb(projectId);
  ensureLockTable(db);

  const rows = db.prepare(
    "SELECT id, project_id, surface, locked_by, locked_at, reason FROM locks WHERE project_id = ? ORDER BY locked_at DESC",
  ).all(projectId) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    projectId: row.project_id as string,
    surface: row.surface as string,
    lockedBy: row.locked_by as string,
    lockedAt: row.locked_at as number,
    reason: (row.reason as string) ?? undefined,
  }));
}

/**
 * Returns true if the surface is currently locked.
 */
export function isLocked(
  projectId: string,
  surface: string,
  dbOverride?: DatabaseSync,
): boolean {
  return getLock(projectId, surface, dbOverride) !== null;
}
