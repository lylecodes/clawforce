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
  updatedAt: number;
  reason?: string;
};

/**
 * Override policy for a lockable surface.
 *
 * - `autonomous_until_locked` (default): human changes apply immediately with
 *   no automatic lock. Agents may later modify the surface unless a lock exists.
 * - `manual_changes_lock`: any human dashboard edit automatically creates or
 *   refreshes a lock, blocking agents until the human explicitly unlocks.
 */
export type OverridePolicy = "autonomous_until_locked" | "manual_changes_lock";

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
      updated_at INTEGER NOT NULL,
      reason TEXT,
      PRIMARY KEY (id),
      UNIQUE (project_id, surface)
    )
  `);
  // Migration: add updated_at if it does not exist yet (for existing tables)
  try {
    db.exec(`ALTER TABLE locks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS lock_override_policies (
      project_id TEXT NOT NULL,
      surface TEXT NOT NULL,
      policy TEXT NOT NULL,
      PRIMARY KEY (project_id, surface)
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
    INSERT INTO locks (id, project_id, surface, locked_by, locked_at, updated_at, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, surface, lockedBy, now, now, reason ?? null);

  return { id, projectId, surface, lockedBy, lockedAt: now, updatedAt: now, reason };
}

/**
 * Release a lock on a surface.
 * Only the lock owner can release their own lock.
 * Throws if the lock is held by a different actor.
 * Does not throw if no lock exists.
 */
export function releaseLock(
  projectId: string,
  surface: string,
  actor: string,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  ensureLockTable(db);
  const existing = getLock(projectId, surface, db);
  if (existing && existing.lockedBy !== actor) {
    throw new Error(`Cannot release lock on "${surface}" — held by "${existing.lockedBy}", not "${actor}"`);
  }
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
    "SELECT id, project_id, surface, locked_by, locked_at, updated_at, reason FROM locks WHERE project_id = ? AND surface = ?",
  ).get(projectId, surface) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: row.id as string,
    projectId: row.project_id as string,
    surface: row.surface as string,
    lockedBy: row.locked_by as string,
    lockedAt: row.locked_at as number,
    updatedAt: (row.updated_at as number) || (row.locked_at as number),
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
    "SELECT id, project_id, surface, locked_by, locked_at, updated_at, reason FROM locks WHERE project_id = ? ORDER BY locked_at DESC",
  ).all(projectId) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    projectId: row.project_id as string,
    surface: row.surface as string,
    lockedBy: row.locked_by as string,
    lockedAt: row.locked_at as number,
    updatedAt: (row.updated_at as number) || (row.locked_at as number),
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

/**
 * Refresh an existing lock (update reason and updatedAt timestamp).
 * If no lock exists, creates one. If already locked by a different actor, throws.
 */
export function refreshLock(
  projectId: string,
  surface: string,
  lockedBy: string,
  reason?: string,
  dbOverride?: DatabaseSync,
): LockEntry {
  const db = dbOverride ?? getDb(projectId);
  ensureLockTable(db);

  const existing = getLock(projectId, surface, db);
  if (existing && existing.lockedBy !== lockedBy) {
    throw new Error(
      `Surface "${surface}" is already locked by "${existing.lockedBy}" in project "${projectId}"`,
    );
  }

  const now = Date.now();

  if (existing) {
    db.prepare(
      "UPDATE locks SET updated_at = ?, reason = ? WHERE project_id = ? AND surface = ?",
    ).run(now, reason ?? null, projectId, surface);
    return { ...existing, updatedAt: now, reason };
  }

  return acquireLock(projectId, surface, lockedBy, reason, db);
}

// ---------------------------------------------------------------------------
// Override policies
// ---------------------------------------------------------------------------

/**
 * Get the override policy for a surface in a project.
 * Defaults to `autonomous_until_locked` if not set.
 */
export function getOverridePolicy(
  projectId: string,
  surface: string,
  dbOverride?: DatabaseSync,
): OverridePolicy {
  const db = dbOverride ?? getDb(projectId);
  ensureLockTable(db);

  const row = db.prepare(
    "SELECT policy FROM lock_override_policies WHERE project_id = ? AND surface = ?",
  ).get(projectId, surface) as { policy: string } | undefined;

  if (!row) return "autonomous_until_locked";
  return row.policy as OverridePolicy;
}

/**
 * Set the override policy for a surface in a project.
 */
export function setOverridePolicy(
  projectId: string,
  surface: string,
  policy: OverridePolicy,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  ensureLockTable(db);

  db.prepare(
    `INSERT INTO lock_override_policies (project_id, surface, policy)
     VALUES (?, ?, ?)
     ON CONFLICT (project_id, surface) DO UPDATE SET policy = excluded.policy`,
  ).run(projectId, surface, policy);
}
