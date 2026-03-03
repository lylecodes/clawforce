/**
 * Clawforce — Durable retry counter
 *
 * Persists enforcement retry attempts in SQLite so the counter
 * survives across session boundaries. A time window prevents
 * ancient retries from counting against the current burst.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";

/** Hard cap on retries regardless of config. */
export const MAX_ENFORCEMENT_RETRIES = 10;

/** Only count retries within this window (4 hours). */
const RETRY_WINDOW_MS = 4 * 60 * 60 * 1000;

export type RetryOutcome = "retry" | "exhausted" | "escalated";

/**
 * Record a retry attempt.
 */
export function recordRetryAttempt(
  projectId: string,
  agentId: string,
  sessionKey: string,
  outcome: RetryOutcome,
): void {
  try {
    const db = getDb(projectId);
    db.prepare(`
      INSERT INTO enforcement_retries (id, project_id, agent_id, session_key, attempted_at, outcome)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), projectId, agentId, sessionKey, Date.now(), outcome);
  } catch (err) {
    safeLog("retry-store.record", err);
  }
}

/**
 * Count recent retry attempts for an agent within the time window.
 */
export function countRecentRetries(projectId: string, agentId: string): number {
  try {
    const db = getDb(projectId);
    const cutoff = Date.now() - RETRY_WINDOW_MS;
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM enforcement_retries
      WHERE project_id = ? AND agent_id = ? AND attempted_at > ?
    `).get(projectId, agentId, cutoff) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch (err) {
    safeLog("retry-store.count", err);
    return 0;
  }
}

/**
 * Resolve effective max retries: min(configMax, hard cap).
 */
export function resolveMaxRetries(configMax?: number): number {
  const configured = configMax ?? 1;
  return Math.min(Math.max(1, configured), MAX_ENFORCEMENT_RETRIES);
}
