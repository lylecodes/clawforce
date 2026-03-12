/**
 * Clawforce — Memory Search Dedup
 *
 * Prevents redundant memory searches within the same session.
 * Uses query text hashing to detect duplicates.
 */

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";

function hashQuery(query: string): string {
  return createHash("sha256").update(query.trim().toLowerCase()).digest("hex").slice(0, 32);
}

export function isDuplicateQuery(
  projectId: string,
  sessionKey: string,
  query: string,
  dbOverride?: DatabaseSync,
): boolean {
  const db = dbOverride ?? getDb(projectId);
  const qHash = hashQuery(query);

  const existing = db.prepare(
    "SELECT id FROM memory_search_log WHERE session_key = ? AND query_hash = ?",
  ).get(sessionKey, qHash) as Record<string, unknown> | undefined;

  return !!existing;
}

export function logSearchQuery(
  projectId: string,
  agentId: string,
  sessionKey: string,
  query: string,
  resultCount: number,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  const id = randomUUID();
  const qHash = hashQuery(query);

  db.prepare(`
    INSERT INTO memory_search_log (id, project_id, agent_id, session_key, query_hash, query_text, result_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, agentId, sessionKey, qHash, query, resultCount, Date.now());
}
