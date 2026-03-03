/**
 * Clawforce — Audit log with signed entries and tamper detection
 *
 * Every significant action gets logged with:
 * - Agent identity signature
 * - Hash chain (each entry includes hash of previous entry)
 * - Both successful and rejected actions
 */

import crypto from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getDb } from "./db.js";
import { safeLog } from "./diagnostics.js";
import { signAction, verifyAction } from "./identity.js";

export type AuditEntry = {
  id: string;
  projectId: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  detail?: string;
  signature?: string;
  prevHash?: string;
  entryHash: string;
  createdAt: number;
};

export function writeAuditEntry(
  params: {
    projectId: string;
    actor: string;
    action: string;
    targetType: string;
    targetId: string;
    detail?: string;
  },
  dbOverride?: DatabaseSync,
): AuditEntry {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const now = Date.now();

  // Get previous entry hash for chain (ROWID guarantees deterministic order
  // even when two entries share the same created_at timestamp)
  const prevRow = db
    .prepare("SELECT entry_hash FROM audit_log WHERE project_id = ? ORDER BY ROWID DESC LIMIT 1")
    .get(params.projectId) as Record<string, unknown> | undefined;
  const prevHash = (prevRow?.entry_hash as string) ?? null;

  // Compute entry hash (includes previous hash for chain integrity)
  const hashData = `${id}:${params.actor}:${params.action}:${params.targetType}:${params.targetId}:${now}:${prevHash ?? "genesis"}`;
  const entryHash = crypto.createHash("sha256").update(hashData).digest("hex");

  // Sign the entry
  let signature: string | undefined;
  try {
    signature = signAction(params.actor, hashData);
  } catch (err) {
    safeLog("audit.sign", err);
  }

  db.prepare(`
    INSERT INTO audit_log (id, project_id, actor, action, target_type, target_id, detail, signature, prev_hash, entry_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.projectId,
    params.actor,
    params.action,
    params.targetType,
    params.targetId,
    params.detail ?? null,
    signature ?? null,
    prevHash,
    entryHash,
    now,
  );

  return {
    id,
    projectId: params.projectId,
    actor: params.actor,
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId,
    detail: params.detail,
    signature,
    prevHash: prevHash ?? undefined,
    entryHash,
    createdAt: now,
  };
}

export type AuditQuery = {
  projectId: string;
  actor?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  since?: number;
  until?: number;
  limit?: number;
};

export function queryAuditLog(query: AuditQuery, dbOverride?: DatabaseSync): AuditEntry[] {
  const db = dbOverride ?? getDb(query.projectId);
  const conditions: string[] = ["project_id = ?"];
  const values: SQLInputValue[] = [query.projectId];

  if (query.actor) {
    conditions.push("actor = ?");
    values.push(query.actor);
  }
  if (query.action) {
    conditions.push("action = ?");
    values.push(query.action);
  }
  if (query.targetType) {
    conditions.push("target_type = ?");
    values.push(query.targetType);
  }
  if (query.targetId) {
    conditions.push("target_id = ?");
    values.push(query.targetId);
  }
  if (query.since) {
    conditions.push("created_at >= ?");
    values.push(query.since);
  }
  if (query.until) {
    conditions.push("created_at <= ?");
    values.push(query.until);
  }

  const limit = query.limit ?? 100;
  values.push(limit);

  const sql = `SELECT * FROM audit_log WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];

  return rows.map(rowToAuditEntry);
}

/**
 * Verify the integrity of the audit log hash chain.
 * Returns the first broken link, or null if chain is intact.
 */
export function verifyAuditChain(
  projectId: string,
  dbOverride?: DatabaseSync,
): { intact: boolean; brokenAt?: string; entries: number; signatureFailures: string[] } {
  const db = dbOverride ?? getDb(projectId);
  const rows = db
    .prepare("SELECT * FROM audit_log WHERE project_id = ? ORDER BY ROWID ASC")
    .all(projectId) as Record<string, unknown>[];

  let prevHash: string | null = null;
  const signatureFailures: string[] = [];

  for (const row of rows) {
    const entry = rowToAuditEntry(row);

    // Verify prev_hash matches
    if (entry.prevHash !== (prevHash ?? undefined)) {
      // First entry should have no prev_hash
      if (prevHash !== null || entry.prevHash !== undefined) {
        return { intact: false, brokenAt: entry.id, entries: rows.length, signatureFailures };
      }
    }

    // Verify entry hash
    const hashData: string = `${entry.id}:${entry.actor}:${entry.action}:${entry.targetType}:${entry.targetId}:${entry.createdAt}:${prevHash ?? "genesis"}`;
    const expectedHash: string = crypto.createHash("sha256").update(hashData).digest("hex");

    if (entry.entryHash !== expectedHash) {
      return { intact: false, brokenAt: entry.id, entries: rows.length, signatureFailures };
    }

    // Verify signature if present (entries without signatures are system-generated)
    if (entry.signature) {
      try {
        if (!verifyAction(entry.actor, hashData, entry.signature)) {
          signatureFailures.push(entry.id);
        }
      } catch {
        signatureFailures.push(entry.id);
      }
    }

    prevHash = entry.entryHash;
  }

  return { intact: true, entries: rows.length, signatureFailures };
}

function rowToAuditEntry(row: Record<string, unknown>): AuditEntry {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    actor: row.actor as string,
    action: row.action as string,
    targetType: row.target_type as string,
    targetId: row.target_id as string,
    detail: (row.detail as string) ?? undefined,
    signature: (row.signature as string) ?? undefined,
    prevHash: (row.prev_hash as string) ?? undefined,
    entryHash: row.entry_hash as string,
    createdAt: row.created_at as number,
  };
}
