/**
 * Clawforce — Lazy Budget Reset
 *
 * Self-healing window resets. Every budget read checks if windows have elapsed.
 * Serialized via conditional UPDATE to prevent race conditions.
 * Reservations are NOT reset — they persist until plan completion.
 *
 * Reset semantics:
 * - Each budget row stores `hourly_reset_at`, `daily_reset_at`, and `monthly_reset_at`
 *   timestamps marking the END of the current window (i.e., when the window expires).
 * - `ensureWindowsCurrent()` is called before every budget check. If `now >= *_reset_at`,
 *   the spent counters for that window are zeroed and `*_reset_at` is advanced to the
 *   NEXT boundary (next hour, next midnight UTC, next month start).
 * - The conditional UPDATE (`WHERE id = ? AND daily_reset_at = ?`) ensures only one
 *   process performs the reset if multiple readers hit the same stale window.
 * - Windows where `*_reset_at` is NULL are skipped (no limit configured for that window).
 */

import type { DatabaseSync, SQLInputValue } from "../sqlite-driver.js";

export function getNextHourBoundary(now: number): number {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.getTime();
}

export function getNextMidnightUTC(now: number): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

export function getNextMonthBoundaryUTC(now: number): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  return d.getTime();
}

export function ensureWindowsCurrent(
  projectId: string,
  agentId: string | undefined,
  db: DatabaseSync,
): void {
  const now = Date.now();
  const whereClause = agentId
    ? "project_id = ? AND agent_id = ?"
    : "project_id = ? AND agent_id IS NULL";
  const whereParams = agentId ? [projectId, agentId] : [projectId];

  const row = db.prepare(
    `SELECT id, hourly_reset_at, daily_reset_at, monthly_reset_at FROM budgets WHERE ${whereClause}`,
  ).get(...whereParams) as {
    id: string;
    hourly_reset_at: number | null;
    daily_reset_at: number;
    monthly_reset_at: number | null;
  } | undefined;

  if (!row) return;

  const resets: string[] = [];
  const params: SQLInputValue[] = [];

  // Hourly reset
  if (row.hourly_reset_at && now >= row.hourly_reset_at) {
    resets.push(
      "hourly_spent_cents = 0, hourly_spent_tokens = 0, hourly_spent_requests = 0, hourly_reset_at = ?",
    );
    params.push(getNextHourBoundary(now));
  }

  // Daily reset
  if (now >= row.daily_reset_at) {
    resets.push(
      "daily_spent_cents = 0, daily_spent_tokens = 0, daily_spent_requests = 0, daily_reset_at = ?",
    );
    params.push(getNextMidnightUTC(now));
  }

  // Monthly reset
  if (row.monthly_reset_at && now >= row.monthly_reset_at) {
    resets.push(
      "monthly_spent_cents = 0, monthly_spent_tokens = 0, monthly_spent_requests = 0, monthly_reset_at = ?",
    );
    params.push(getNextMonthBoundaryUTC(now));
  }

  if (resets.length === 0) return;

  // Conditional UPDATE — serialized so only one process wins the reset
  resets.push("updated_at = ?");
  params.push(now);
  params.push(row.id);
  params.push(row.daily_reset_at); // original value for conditional check

  db.prepare(
    `UPDATE budgets SET ${resets.join(", ")} WHERE id = ? AND daily_reset_at = ?`,
  ).run(...params);
}
