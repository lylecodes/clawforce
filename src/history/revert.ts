/**
 * Clawforce — Change revert logic
 *
 * Safe structural revert: applies the `before` snapshot of a reversible
 * change record to restore the previous state. Creates a new change record
 * with action "revert" and marks the original as reverted.
 *
 * Explicitly rejects operational revert attempts (task transitions, dispatches,
 * domain kills, etc.) with a clear reason.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import {
  ensureHistoryTable,
  getChange,
  recordChange,
  type ChangeRecord,
} from "./store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RevertResult =
  | { ok: true; changeId: string; revertChangeId: string }
  | { ok: false; reason: string };

export type CanRevertResult = {
  reversible: boolean;
  reason?: string;
};

// ---------------------------------------------------------------------------
// Structural resource types that are safe to revert
// ---------------------------------------------------------------------------

const STRUCTURAL_RESOURCE_TYPES = new Set([
  "config",
  "budget",
  "agent",
  "org",
  "doc",
  "rule",
  "job",
  "lock",
]);

// Operational action types that must never be reverted
const OPERATIONAL_ACTIONS = new Set([
  "task_transition",
  "task_dispatch",
  "domain_kill",
  "agent_kill",
  "emergency_stop",
  "dispatch",
  "event_ingest",
]);

// ---------------------------------------------------------------------------
// canRevert
// ---------------------------------------------------------------------------

/**
 * Check whether a change record can be reverted.
 *
 * Non-reversible cases:
 * - change.reversible === false (flagged at record time)
 * - already reverted (revertedBy is set)
 * - operational action type (task transitions, dispatches, kills, etc.)
 * - before snapshot is null (no state to restore)
 */
export function canRevert(
  changeId: string,
  dbOverride?: DatabaseSync,
  projectId?: string,
): CanRevertResult {
  const db = dbOverride ?? (projectId ? getDb(projectId) : null);
  if (!db) {
    return { reversible: false, reason: "No database available to check revert eligibility" };
  }

  let change: ChangeRecord | null;
  try {
    change = getChange(changeId, db);
  } catch {
    return { reversible: false, reason: "Change record not found" };
  }

  if (!change) {
    return { reversible: false, reason: "Change record not found" };
  }

  if (change.revertedBy) {
    return { reversible: false, reason: `Already reverted by change ${change.revertedBy}` };
  }

  if (!change.reversible) {
    return { reversible: false, reason: "Change was marked non-reversible at record time" };
  }

  if (OPERATIONAL_ACTIONS.has(change.action)) {
    return {
      reversible: false,
      reason: `Operational action "${change.action}" cannot be reverted. Only structural changes (config, budget, org, docs, rules, jobs) are revertable.`,
    };
  }

  if (!STRUCTURAL_RESOURCE_TYPES.has(change.resourceType)) {
    return {
      reversible: false,
      reason: `Resource type "${change.resourceType}" is operational, not structural. Only config, budget, agent, org, doc, rule, job, and lock changes can be reverted.`,
    };
  }

  if (change.before === null) {
    return {
      reversible: false,
      reason: "No before-snapshot available — this change cannot be restored (create action with no prior state).",
    };
  }

  return { reversible: true };
}

// ---------------------------------------------------------------------------
// revertChange
// ---------------------------------------------------------------------------

/**
 * Apply the before snapshot of a reversible change to restore prior state.
 *
 * Steps:
 * 1. Load and validate the original change record
 * 2. Validate revert eligibility via canRevert
 * 3. Insert a new change record with action="revert", after=before, before=after
 * 4. Mark the original record as reverted (set reverted_by)
 * 5. Return the result
 *
 * NOTE: The revert record captures the state transition in reverse. Callers
 * that own the config/budget/etc. service must apply the restored state
 * themselves — revertChange writes the history record but does NOT call
 * external services. For config and budget changes, the dashboard action
 * handler is responsible for calling the appropriate service after revert.
 *
 * For the v1 contract, the revert record is the canonical signal that a
 * revert was requested and approved by the history system.
 */
export function revertChange(
  projectId: string,
  changeId: string,
  actor: string,
  dbOverride?: DatabaseSync,
): RevertResult {
  const db = dbOverride ?? getDb(projectId);
  ensureHistoryTable(db);

  // Validate
  const eligibility = canRevert(changeId, db);
  if (!eligibility.reversible) {
    return { ok: false, reason: eligibility.reason ?? "Change cannot be reverted" };
  }

  const original = getChange(changeId, db);
  if (!original) {
    return { ok: false, reason: "Change record not found" };
  }

  // Double-check: before snapshot must exist
  if (original.before === null) {
    return { ok: false, reason: "No before-snapshot available to restore" };
  }

  const revertChangeId = crypto.randomUUID();
  const now = Date.now();

  // Insert the revert record
  db.prepare(`
    INSERT INTO change_history
      (id, project_id, resource_type, resource_id, action, provenance, actor,
       before_snapshot, after_snapshot, reversible, created_at)
    VALUES (?, ?, ?, ?, 'revert', ?, ?, ?, ?, 1, ?)
  `).run(
    revertChangeId,
    projectId,
    original.resourceType,
    original.resourceId,
    original.provenance,
    actor,
    original.after,       // before = what was applied
    original.before,      // after = what we restore to
    now,
  );

  // Mark the original as reverted
  db.prepare(`
    UPDATE change_history SET reverted_by = ? WHERE id = ?
  `).run(revertChangeId, changeId);

  return { ok: true, changeId, revertChangeId };
}
