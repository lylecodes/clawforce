/**
 * Clawforce — Lazy Budget Reset
 *
 * Self-healing window resets. Every budget read checks if windows have elapsed.
 * Serialized via conditional UPDATE to prevent race conditions.
 * Reservations are NOT reset — they persist until plan completion.
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

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
