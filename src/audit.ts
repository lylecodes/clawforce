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

  // Use BEGIN IMMEDIATE to acquire a write lock upfront, preventing
  // concurrent writes from getting the same prevHash (fork in the chain).
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    // Get previous entry hash for chain (ROWID guarantees deterministic order
    // even when two entries share the same created_at timestamp)
    const prevRow = db
      .prepare("SELECT entry_hash FROM audit_log WHERE project_id = ? ORDER BY ROWID DESC LIMIT 1")
      .get(params.projectId) as Record<string, unknown> | undefined;
    const prevHash = (prevRow?.entry_hash as string) ?? null;

    // Compute entry hash — v2 format includes detail + projectId for tamper resistance
    const hashData = `${id}:${params.actor}:${params.action}:${params.targetType}:${params.targetId}:${now}:${prevHash ?? "genesis"}:${params.detail ?? ""}:${params.projectId}`;
    const entryHash = crypto.createHash("sha256").update(hashData).digest("hex");

    // Sign the entry
    let signature: string | undefined;
    try {
      signature = signAction(params.actor, hashData);
    } catch (err) {
      safeLog("audit.sign", err);
    }

    db.prepare(`
      INSERT INTO audit_log (id, project_id, actor, action, target_type, target_id, detail, signature, prev_hash, entry_hash, created_at, hash_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2)
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

    db.prepare("COMMIT").run();

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
  } catch (err) {
    try { db.prepare("ROLLBACK").run(); } catch { /* ROLLBACK may fail if already rolled back */ }
    throw err;
  }
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
): { intact: boolean; signatureIntact: boolean; brokenAt?: string; entries: number; signatureFailures: string[]; unsignedCount: number } {
  const db = dbOverride ?? getDb(projectId);
  const rows = db
    .prepare("SELECT * FROM audit_log WHERE project_id = ? ORDER BY ROWID ASC")
    .all(projectId) as Record<string, unknown>[];

  let prevHash: string | null = null;
  const signatureFailures: string[] = [];
  let unsignedCount = 0;

  for (const row of rows) {
    const entry = rowToAuditEntry(row);
    const hashVersion = (row.hash_version as number) ?? 1;

    // Verify prev_hash matches
    if (entry.prevHash !== (prevHash ?? undefined)) {
      // First entry should have no prev_hash
      if (prevHash !== null || entry.prevHash !== undefined) {
        return { intact: false, signatureIntact: false, brokenAt: entry.id, entries: rows.length, signatureFailures, unsignedCount };
      }
    }

    // Reconstruct hash based on version (v1 = original, v2 = includes detail + projectId)
    let hashData: string;
    if (hashVersion >= 2) {
      hashData = `${entry.id}:${entry.actor}:${entry.action}:${entry.targetType}:${entry.targetId}:${entry.createdAt}:${prevHash ?? "genesis"}:${entry.detail ?? ""}:${entry.projectId}`;
    } else {
      hashData = `${entry.id}:${entry.actor}:${entry.action}:${entry.targetType}:${entry.targetId}:${entry.createdAt}:${prevHash ?? "genesis"}`;
    }
    const expectedHash: string = crypto.createHash("sha256").update(hashData).digest("hex");

    if (entry.entryHash !== expectedHash) {
      return { intact: false, signatureIntact: false, brokenAt: entry.id, entries: rows.length, signatureFailures, unsignedCount };
    }

    // Verify signature if present; count unsigned entries
    if (entry.signature) {
      try {
        if (!verifyAction(entry.actor, hashData, entry.signature)) {
          signatureFailures.push(entry.id);
        }
      } catch {
        signatureFailures.push(entry.id);
      }
    } else {
      unsignedCount++;
    }

    prevHash = entry.entryHash;
  }

  return { intact: true, signatureIntact: signatureFailures.length === 0, entries: rows.length, signatureFailures, unsignedCount };
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
