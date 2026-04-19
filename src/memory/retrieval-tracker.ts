/**
 * Clawforce — Memory Retrieval Tracker
 *
 * Tracks which memory content gets retrieved via ghost turn,
 * using content hashes to identify unique memories.
 * Feeds the promotion pipeline with frequency data.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";

export type RetrievalStat = {
  contentHash: string;
  projectId: string;
  agentId: string;
  contentSnippet: string;
  retrievalCount: number;
  sessionCount: number;
  firstRetrievedAt: number;
  lastRetrievedAt: number;
};

function hashContent(content: string): string {
  return createHash("sha256").update(content.trim()).digest("hex").slice(0, 32);
}

function snippetize(content: string, maxLen: number = 200): string {
  const trimmed = content.trim().replace(/\s+/g, " ");
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + "..." : trimmed;
}

// Track which sessions have been counted for each content hash
const sessionTracker = new Map<string, Set<string>>();

function getSessionKey(contentHash: string, projectId: string, agentId: string): string {
  return `${contentHash}:${projectId}:${agentId}`;
}

export function trackRetrieval(
  projectId: string,
  agentId: string,
  sessionKey: string,
  content: string,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  const contentHash = hashContent(content);
  const snippet = snippetize(content);
  const now = Date.now();

  const trackerKey = getSessionKey(contentHash, projectId, agentId);
  let sessions = sessionTracker.get(trackerKey);
  if (!sessions) {
    sessions = new Set<string>();
    sessionTracker.set(trackerKey, sessions);
  }
  const isNewSession = !sessions.has(sessionKey);
  sessions.add(sessionKey);

  const existing = db.prepare(
    "SELECT retrieval_count, session_count FROM memory_retrieval_stats WHERE content_hash = ? AND project_id = ? AND agent_id = ?",
  ).get(contentHash, projectId, agentId) as { retrieval_count: number; session_count: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE memory_retrieval_stats
      SET retrieval_count = retrieval_count + 1,
          session_count = ?,
          last_retrieved_at = ?
      WHERE content_hash = ? AND project_id = ? AND agent_id = ?
    `).run(
      isNewSession ? existing.session_count + 1 : existing.session_count,
      now,
      contentHash, projectId, agentId,
    );
  } else {
    db.prepare(`
      INSERT INTO memory_retrieval_stats (content_hash, project_id, agent_id, content_snippet, retrieval_count, session_count, first_retrieved_at, last_retrieved_at)
      VALUES (?, ?, ?, ?, 1, 1, ?, ?)
    `).run(contentHash, projectId, agentId, snippet, now, now);
  }
}

function rowToStat(row: Record<string, unknown>): RetrievalStat {
  return {
    contentHash: row.content_hash as string,
    projectId: row.project_id as string,
    agentId: row.agent_id as string,
    contentSnippet: row.content_snippet as string,
    retrievalCount: row.retrieval_count as number,
    sessionCount: row.session_count as number,
    firstRetrievedAt: row.first_retrieved_at as number,
    lastRetrievedAt: row.last_retrieved_at as number,
  };
}

export function getRetrievalStats(projectId: string, dbOverride?: DatabaseSync): RetrievalStat[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM memory_retrieval_stats WHERE project_id = ? ORDER BY retrieval_count DESC",
  ).all(projectId) as Record<string, unknown>[];
  return rows.map(rowToStat);
}

export function getStatsAboveThreshold(
  projectId: string,
  minRetrievals: number,
  minSessions: number,
  dbOverride?: DatabaseSync,
): RetrievalStat[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM memory_retrieval_stats WHERE project_id = ? AND retrieval_count >= ? AND session_count >= ? ORDER BY retrieval_count DESC",
  ).all(projectId, minRetrievals, minSessions) as Record<string, unknown>[];
  return rows.map(rowToStat);
}

export function clearSessionTracker(): void {
  sessionTracker.clear();
}
