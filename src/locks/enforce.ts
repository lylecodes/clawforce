/**
 * Clawforce — Lock enforcement
 *
 * Checks whether a surface is locked before allowing mutations.
 * Owners (the actor who placed the lock) can modify their own locked surfaces.
 */

import type { DatabaseSync } from "node:sqlite";
import { getLock, type LockEntry } from "./store.js";

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
