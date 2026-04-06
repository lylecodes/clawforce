/**
 * Clawforce — Change history store
 *
 * Canonical change record model for structural mutations. Enables operators
 * to see what changed, who changed it, and safely undo reversible changes.
 *
 * Separate from the audit log (compliance + hash chain). History is operator-
 * facing confidence: readable diffs, provenance, and revert state.
 */

import crypto from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChangeProvenance = "human" | "agent" | "system";

export type ChangeRecord = {
  id: string;
  projectId: string;
  resourceType: string;   // "config", "budget", "agent", "org", "doc", "rule", "job"
  resourceId: string;     // e.g. agent ID, section name, doc path
  action: string;         // "create", "update", "delete", "revert"
  provenance: ChangeProvenance;
  actor: string;
  before: string | null;  // JSON snapshot before change
  after: string | null;   // JSON snapshot after change
  reversible: boolean;    // can this change be reverted?
  revertedBy?: string;    // ID of the change record that reverted this one
  createdAt: number;
};

// ---------------------------------------------------------------------------
// Table setup
// ---------------------------------------------------------------------------

export function ensureHistoryTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS change_history (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      action TEXT NOT NULL,
      provenance TEXT NOT NULL DEFAULT 'human',
      actor TEXT NOT NULL,
      before_snapshot TEXT,
      after_snapshot TEXT,
      reversible INTEGER NOT NULL DEFAULT 1,
      reverted_by TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_change_history_project
      ON change_history(project_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_change_history_resource
      ON change_history(project_id, resource_type, resource_id, created_at DESC);
  `);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export type RecordChangeParams = {
  resourceType: string;
  resourceId: string;
  action: string;
  provenance: ChangeProvenance;
  actor: string;
  before?: unknown;
  after?: unknown;
  reversible?: boolean;
};

/**
 * Insert a new change record. Returns the persisted ChangeRecord.
 * Non-fatal callers should wrap in try/catch.
 */
export function recordChange(
  projectId: string,
  params: RecordChangeParams,
  dbOverride?: DatabaseSync,
): ChangeRecord {
  const db = dbOverride ?? getDb(projectId);
  ensureHistoryTable(db);

  const id = crypto.randomUUID();
  const now = Date.now();
  const before = params.before !== undefined ? JSON.stringify(params.before) : null;
  const after = params.after !== undefined ? JSON.stringify(params.after) : null;
  const reversible = params.reversible !== false ? 1 : 0;

  db.prepare(`
    INSERT INTO change_history
      (id, project_id, resource_type, resource_id, action, provenance, actor,
       before_snapshot, after_snapshot, reversible, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    params.resourceType,
    params.resourceId,
    params.action,
    params.provenance,
    params.actor,
    before,
    after,
    reversible,
    now,
  );

  return {
    id,
    projectId,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    action: params.action,
    provenance: params.provenance,
    actor: params.actor,
    before,
    after,
    reversible: reversible === 1,
    createdAt: now,
  };
}

// ---------------------------------------------------------------------------
// Read — single record
// ---------------------------------------------------------------------------

export function getChange(changeId: string, dbOverride?: DatabaseSync, projectId?: string): ChangeRecord | null {
  // We need a DB — use projectId if provided, otherwise fall back to a project-
  // scoped lookup isn't possible without projectId. Callers that have a db can
  // pass it directly.
  if (!dbOverride && !projectId) {
    throw new Error("getChange: either dbOverride or projectId must be provided");
  }
  const db = dbOverride ?? getDb(projectId!);
  ensureHistoryTable(db);

  const row = db.prepare(`SELECT * FROM change_history WHERE id = ?`).get(changeId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToChangeRecord(row);
}

// ---------------------------------------------------------------------------
// Read — resource history
// ---------------------------------------------------------------------------

export type ResourceHistoryOpts = {
  limit?: number;
  offset?: number;
  provenance?: ChangeProvenance;
};

/**
 * List changes for a specific resource, newest first.
 */
export function getResourceHistory(
  projectId: string,
  resourceType: string,
  resourceId: string,
  opts?: ResourceHistoryOpts,
  dbOverride?: DatabaseSync,
): ChangeRecord[] {
  const db = dbOverride ?? getDb(projectId);
  ensureHistoryTable(db);

  const conditions: string[] = [
    "project_id = ?",
    "resource_type = ?",
    "resource_id = ?",
  ];
  const values: SQLInputValue[] = [projectId, resourceType, resourceId];

  if (opts?.provenance) {
    conditions.push("provenance = ?");
    values.push(opts.provenance);
  }

  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;
  values.push(limit, offset);

  const sql = `
    SELECT * FROM change_history
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];
  return rows.map(rowToChangeRecord);
}

// ---------------------------------------------------------------------------
// Read — recent changes (all resources)
// ---------------------------------------------------------------------------

export type RecentChangesOpts = {
  limit?: number;
  offset?: number;
  resourceType?: string;
  provenance?: ChangeProvenance;
};

/**
 * List all recent changes for a project, newest first.
 */
export function listRecentChanges(
  projectId: string,
  opts?: RecentChangesOpts,
  dbOverride?: DatabaseSync,
): ChangeRecord[] {
  const db = dbOverride ?? getDb(projectId);
  ensureHistoryTable(db);

  const conditions: string[] = ["project_id = ?"];
  const values: SQLInputValue[] = [projectId];

  if (opts?.resourceType) {
    conditions.push("resource_type = ?");
    values.push(opts.resourceType);
  }
  if (opts?.provenance) {
    conditions.push("provenance = ?");
    values.push(opts.provenance);
  }

  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;
  values.push(limit, offset);

  const sql = `
    SELECT * FROM change_history
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];
  return rows.map(rowToChangeRecord);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rowToChangeRecord(row: Record<string, unknown>): ChangeRecord {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    resourceType: row.resource_type as string,
    resourceId: row.resource_id as string,
    action: row.action as string,
    provenance: row.provenance as ChangeProvenance,
    actor: row.actor as string,
    before: (row.before_snapshot as string) ?? null,
    after: (row.after_snapshot as string) ?? null,
    reversible: (row.reversible as number) === 1,
    revertedBy: (row.reverted_by as string) ?? undefined,
    createdAt: row.created_at as number,
  };
}
