/**
 * Clawforce — Trust score history
 *
 * Snapshots trust scores over time for trend analysis.
 * Each snapshot records the overall score, tier, and per-category breakdown.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";

// --- Types ---

export type TrustSnapshotParams = {
  projectId: string;
  agentId?: string;
  score: number;
  tier: string;
  triggerType: string;
  triggerId?: string;
  categoryScores?: Record<string, number>;
};

export type TrustSnapshot = TrustSnapshotParams & {
  id: string;
  createdAt: number;
};

// --- Core functions ---

/**
 * Insert a trust score snapshot.
 */
export function snapshotTrustScore(
  params: TrustSnapshotParams,
  dbOverride?: DatabaseSync,
): TrustSnapshot {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const now = Date.now();

  try {
    db.prepare(`
      INSERT INTO trust_score_history (
        id, project_id, agent_id, score, tier,
        trigger_type, trigger_id, category_scores, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.projectId,
      params.agentId ?? null,
      params.score,
      params.tier,
      params.triggerType,
      params.triggerId ?? null,
      params.categoryScores ? JSON.stringify(params.categoryScores) : null,
      now,
    );
  } catch (err) {
    safeLog("telemetry.trust-snapshot", err);
    throw err;
  }

  return { ...params, id, createdAt: now };
}

/**
 * Get trust score timeline for a project, optionally filtered by agent.
 */
export function getTrustTimeline(
  projectId: string,
  agentId?: string,
  since?: number,
  dbOverride?: DatabaseSync,
): TrustSnapshot[] {
  const db = dbOverride ?? getDb(projectId);
  const sinceMs = since ?? 0;

  let sql: string;
  let params: unknown[];

  if (agentId) {
    sql = `
      SELECT * FROM trust_score_history
      WHERE project_id = ? AND agent_id = ? AND created_at >= ?
      ORDER BY created_at ASC
    `;
    params = [projectId, agentId, sinceMs];
  } else {
    sql = `
      SELECT * FROM trust_score_history
      WHERE project_id = ? AND created_at >= ?
      ORDER BY created_at ASC
    `;
    params = [projectId, sinceMs];
  }

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(mapSnapshotRow);
}

// --- Helpers ---

function mapSnapshotRow(row: Record<string, unknown>): TrustSnapshot {
  let categoryScores: Record<string, number> | undefined;
  if (row.category_scores) {
    try {
      categoryScores = JSON.parse(row.category_scores as string);
    } catch { /* empty */ }
  }

  return {
    id: row.id as string,
    projectId: row.project_id as string,
    agentId: (row.agent_id as string) ?? undefined,
    score: row.score as number,
    tier: row.tier as string,
    triggerType: row.trigger_type as string,
    triggerId: (row.trigger_id as string) ?? undefined,
    categoryScores,
    createdAt: row.created_at as number,
  };
}
