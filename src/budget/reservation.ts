/**
 * Clawforce — Budget Reservations
 *
 * Soft budget reservations for dispatch plans. When a plan transitions
 * to 'executing', budget is reserved (reserved_cents/tokens/requests).
 * On completion or abandonment, reservations are released.
 * Stale reservations from crashed plans are cleaned up via TTL.
 */

import type { DatabaseSync } from "../sqlite-driver.js";

/**
 * Reserve budget for an executing plan.
 * Increments reserved_cents, reserved_tokens, and reserved_requests
 * on the project-level budget row.
 */
export function reserveBudget(
  projectId: string,
  cents: number,
  tokens: number,
  requests: number,
  db: DatabaseSync,
): void {
  db.prepare(`
    UPDATE budgets SET
      reserved_cents = reserved_cents + ?,
      reserved_tokens = reserved_tokens + ?,
      reserved_requests = reserved_requests + ?,
      updated_at = ?
    WHERE project_id = ? AND agent_id IS NULL
  `).run(cents, tokens, requests, Date.now(), projectId);
}

/**
 * Settle a single plan item: decrement reservation by the item's estimate.
 * Uses MAX(0, ...) to prevent negative reservations.
 */
export function settlePlanItem(
  projectId: string,
  estimatedCents: number,
  estimatedTokens: number,
  estimatedRequests: number,
  db: DatabaseSync,
): void {
  db.prepare(`
    UPDATE budgets SET
      reserved_cents = MAX(0, reserved_cents - ?),
      reserved_tokens = MAX(0, reserved_tokens - ?),
      reserved_requests = MAX(0, reserved_requests - ?),
      updated_at = ?
    WHERE project_id = ? AND agent_id IS NULL
  `).run(estimatedCents, estimatedTokens, estimatedRequests, Date.now(), projectId);
}

/**
 * Release remaining reservation when a plan completes or is abandoned.
 * Decrements by the remaining reservation amount (MAX 0).
 */
export function releasePlanReservation(
  projectId: string,
  remainingCents: number,
  remainingTokens: number,
  remainingRequests: number,
  db: DatabaseSync,
): void {
  db.prepare(`
    UPDATE budgets SET
      reserved_cents = MAX(0, reserved_cents - ?),
      reserved_tokens = MAX(0, reserved_tokens - ?),
      reserved_requests = MAX(0, reserved_requests - ?),
      updated_at = ?
    WHERE project_id = ? AND agent_id IS NULL
  `).run(remainingCents, remainingTokens, remainingRequests, Date.now(), projectId);
}

/**
 * Clean up stale reservations from plans stuck in 'executing' state.
 * Finds plans with started_at older than now - ttlMs, force-abandons them,
 * and releases their reservations.
 */
export function cleanupStaleReservations(
  projectId: string,
  ttlMs: number,
  db: DatabaseSync,
): number {
  const cutoff = Date.now() - ttlMs;
  const now = Date.now();

  // Find stale executing plans
  const stalePlans = db.prepare(`
    SELECT id, estimated_cost_cents, planned_items
    FROM dispatch_plans
    WHERE project_id = ? AND status = 'executing' AND started_at IS NOT NULL AND started_at < ?
  `).all(projectId, cutoff) as Array<{
    id: string;
    estimated_cost_cents: number;
    planned_items: string;
  }>;

  for (const plan of stalePlans) {
    // Parse planned items to calculate total estimated tokens and requests
    let totalTokens = 0;
    let totalRequests = 0;
    try {
      const items = JSON.parse(plan.planned_items) as Array<{
        estimatedTokens?: number;
        estimatedCostCents: number;
      }>;
      totalRequests = items.length;
      totalTokens = items.reduce((sum, item) => sum + (item.estimatedTokens ?? 0), 0);
    } catch {
      // If parse fails, just release cents
    }

    // Force-abandon the plan
    db.prepare(`
      UPDATE dispatch_plans SET status = 'abandoned', completed_at = ?
      WHERE id = ? AND project_id = ? AND status = 'executing'
    `).run(now, plan.id, projectId);

    // Release its reservation
    releasePlanReservation(
      projectId,
      plan.estimated_cost_cents,
      totalTokens,
      totalRequests,
      db,
    );
  }

  return stalePlans.length;
}
