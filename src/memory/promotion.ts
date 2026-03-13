/**
 * Clawforce — Knowledge Promotion Pipeline
 *
 * Detects frequently-retrieved memories and creates promotion candidates.
 * Candidates are reviewed by the manager during reflection.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import type { PromotionCandidate, PromotionTarget } from "../types.js";

function rowToCandidate(row: Record<string, unknown>): PromotionCandidate {
  const c: PromotionCandidate = {
    id: row.id as string,
    projectId: row.project_id as string,
    contentHash: row.content_hash as string,
    contentSnippet: row.content_snippet as string,
    retrievalCount: row.retrieval_count as number,
    sessionCount: row.session_count as number,
    suggestedTarget: row.suggested_target as PromotionTarget,
    status: row.status as PromotionCandidate["status"],
    createdAt: row.created_at as number,
  };
  if (row.target_agent_id != null) c.targetAgentId = row.target_agent_id as string;
  if (row.reviewed_at != null) c.reviewedAt = row.reviewed_at as number;
  return c;
}

/**
 * Suggest a promotion target based on content heuristics.
 */
export function suggestTarget(snippet: string): PromotionTarget {
  const lower = snippet.toLowerCase();

  // Rule patterns: decision-like content that could be automated
  if (
    lower.includes("when") && (lower.includes("then") || lower.includes("always") || lower.includes("should")) ||
    lower.includes("every time") ||
    lower.includes("always assign") ||
    lower.includes("if") && lower.includes("should") ||
    lower.includes("whenever") && (lower.includes("do") || lower.includes("assign") || lower.includes("trigger"))
  ) {
    return "rule";
  }

  if (lower.includes("i prefer") || lower.includes("i always") || lower.includes("my approach") || lower.includes("my style")) {
    return "soul";
  }
  if (lower.includes("project") || lower.includes("deploy") || lower.includes("team") || lower.includes("process")) {
    return "project_doc";
  }
  return "skill";
}

export function checkPromotionCandidates(
  projectId: string,
  threshold: { minRetrievals: number; minSessions: number },
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);

  // Find stats above threshold that don't already have a pending/approved candidate
  const stats = db.prepare(`
    SELECT mrs.*
    FROM memory_retrieval_stats mrs
    WHERE mrs.project_id = ?
      AND mrs.retrieval_count >= ?
      AND mrs.session_count >= ?
      AND NOT EXISTS (
        SELECT 1 FROM promotion_candidates pc
        WHERE pc.project_id = mrs.project_id
          AND pc.content_hash = mrs.content_hash
          AND pc.status IN ('pending', 'approved')
      )
  `).all(projectId, threshold.minRetrievals, threshold.minSessions) as Record<string, unknown>[];

  let created = 0;
  for (const row of stats) {
    const snippet = row.content_snippet as string;
    db.prepare(`
      INSERT INTO promotion_candidates (id, project_id, content_hash, content_snippet, retrieval_count, session_count, suggested_target, target_agent_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      randomUUID(),
      projectId,
      row.content_hash as string,
      snippet,
      row.retrieval_count as number,
      row.session_count as number,
      suggestTarget(snippet),
      row.agent_id as string,
      Date.now(),
    );
    created++;
  }

  return created;
}

export function listCandidates(
  projectId: string,
  dbOverride?: DatabaseSync,
  statusFilter?: PromotionCandidate["status"],
): PromotionCandidate[] {
  const db = dbOverride ?? getDb(projectId);
  let query = "SELECT * FROM promotion_candidates WHERE project_id = ?";
  const params: (string | number)[] = [projectId];
  if (statusFilter) {
    query += " AND status = ?";
    params.push(statusFilter);
  }
  query += " ORDER BY retrieval_count DESC";
  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(rowToCandidate);
}

export function getCandidate(projectId: string, candidateId: string, dbOverride?: DatabaseSync): PromotionCandidate | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare("SELECT * FROM promotion_candidates WHERE id = ? AND project_id = ?")
    .get(candidateId, projectId) as Record<string, unknown> | undefined;
  return row ? rowToCandidate(row) : null;
}

export function approveCandidate(projectId: string, candidateId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare("UPDATE promotion_candidates SET status = 'approved', reviewed_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'")
    .run(Date.now(), candidateId, projectId);
}

export function dismissCandidate(projectId: string, candidateId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare("UPDATE promotion_candidates SET status = 'dismissed', reviewed_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'")
    .run(Date.now(), candidateId, projectId);
}
