/**
 * Clawforce — Lock enforcement
 *
 * Checks whether a surface is locked before allowing mutations.
 * Owners (the actor who placed the lock) can modify their own locked surfaces.
 *
 * Also handles override policy: if `manual_changes_lock` is set for a surface,
 * a human dashboard edit will automatically create or refresh a lock.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import { getLock, getOverridePolicy, refreshLock, type LockEntry } from "./store.js";
import { writeAuditEntry } from "../audit.js";

export type CheckLockResult = {
  locked: boolean;
  entry?: LockEntry;
};

/**
 * Check if a surface is locked for the given actor.
 *
 * Returns `{ locked: false }` when:
 * - No lock exists, OR
 * - The surface is locked by the same actor (owner bypass)
 *
 * Returns `{ locked: true, entry }` when locked by a different actor.
 */
export function checkLock(
  projectId: string,
  surface: string,
  actor: string,
  dbOverride?: DatabaseSync,
): CheckLockResult {
  const entry = getLock(projectId, surface, dbOverride);

  if (!entry) {
    return { locked: false };
  }

  // Owner bypass: the actor who placed the lock can still modify it
  if (entry.lockedBy === actor) {
    return { locked: false };
  }

  return { locked: true, entry };
}

/**
 * Throws an error if the surface is locked for the given actor.
 * Use this as a gate before mutating a config surface.
 */
export function requireUnlocked(
  projectId: string,
  surface: string,
  actor: string,
  dbOverride?: DatabaseSync,
): void {
  const result = checkLock(projectId, surface, actor, dbOverride);
  if (result.locked && result.entry) {
    throw new Error(
      `Surface "${surface}" is locked by "${result.entry.lockedBy}" in project "${projectId}"` +
        (result.entry.reason ? `: ${result.entry.reason}` : ""),
    );
  }
}

/**
 * Check a lock on behalf of an agent mutation. If blocked, writes a
 * `lock_blocked_mutation` audit entry and returns the lock entry.
 *
 * Returns `null` if the mutation is allowed.
 */
export function checkAgentMutation(
  projectId: string,
  surface: string,
  actor: string,
  dbOverride?: DatabaseSync,
): LockEntry | null {
  const result = checkLock(projectId, surface, actor, dbOverride);
  if (!result.locked || !result.entry) return null;

  try {
    writeAuditEntry(
      {
        projectId,
        actor,
        action: "lock_blocked_mutation",
        targetType: "lock",
        targetId: surface,
        detail: JSON.stringify({
          surface,
          blockedActor: actor,
          lockedBy: result.entry.lockedBy,
          reason: result.entry.reason,
        }),
      },
      dbOverride,
    );
  } catch { /* non-fatal */ }

  return result.entry;
}

/**
 * Apply the override policy for a human dashboard edit.
 *
 * If the surface policy is `manual_changes_lock`, this creates or refreshes
 * a lock for the surface, encoded as a human authority claim.
 *
 * If the policy is `autonomous_until_locked` (default), this is a no-op.
 */
export function applyOverridePolicy(
  projectId: string,
  surface: string,
  actor: string,
  reason?: string,
  dbOverride?: DatabaseSync,
): void {
  const policy = getOverridePolicy(projectId, surface, dbOverride);
  if (policy !== "manual_changes_lock") return;

  try {
    refreshLock(projectId, surface, actor, reason, dbOverride);
  } catch { /* non-fatal if lock already exists by a different actor */ }
}
