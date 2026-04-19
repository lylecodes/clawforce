import { writeAuditEntry } from "../../audit.js";
import { getDb } from "../../db.js";
import { disableAgent, enableAgent } from "../../enforcement/disabled-store.js";
import { getChange, recordChange } from "../../history/store.js";
import { revertChange } from "../../history/revert.js";
import { acquireLock, getLock, releaseLock, type LockEntry } from "../../locks/store.js";
import { runSaveConfigCommand } from "./config-saves.js";

type CommandError = {
  ok: false;
  status: number;
  error: string;
};

export type AcquireLockCommandResult =
  | { ok: true; status: 201; lock: LockEntry }
  | CommandError;

export type ReleaseLockCommandResult =
  | { ok: true; status: 200; surface: string }
  | CommandError;

export type RevertHistoryChangeCommandResult =
  | {
      ok: true;
      status: 200;
      changeId: string;
      revertChangeId: string;
      applied: boolean;
      applyReason?: string;
    }
  | CommandError;

export function runAcquireLockCommand(
  projectId: string,
  surface: string,
  actor = "dashboard",
  reason?: string,
): AcquireLockCommandResult {
  try {
    const lock = acquireLock(projectId, surface, actor, reason);
    try {
      writeAuditEntry({
        projectId,
        actor,
        action: "lock_acquire",
        targetType: "lock",
        targetId: surface,
        detail: JSON.stringify({ surface, reason: lock.reason }),
      });
    } catch {
      // non-fatal
    }
    try {
      recordChange(projectId, {
        resourceType: "lock",
        resourceId: surface,
        action: "create",
        provenance: "human",
        actor,
        before: null,
        after: {
          surface,
          lockedBy: lock.lockedBy,
          lockedAt: lock.lockedAt,
          reason: lock.reason,
        },
        reversible: true,
      });
    } catch {
      // non-fatal
    }
    return { ok: true, status: 201, lock };
  } catch (err) {
    return {
      ok: false,
      status: 409,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function runReleaseLockCommand(
  projectId: string,
  surface: string,
  actor = "dashboard",
): ReleaseLockCommandResult {
  try {
    const existing = getLock(projectId, surface);
    releaseLock(projectId, surface, actor);
    try {
      writeAuditEntry({
        projectId,
        actor,
        action: "lock_release",
        targetType: "lock",
        targetId: surface,
        detail: JSON.stringify({ surface }),
      });
    } catch {
      // non-fatal
    }
    try {
      recordChange(projectId, {
        resourceType: "lock",
        resourceId: surface,
        action: "delete",
        provenance: "human",
        actor,
        before: existing
          ? {
              surface,
              lockedBy: existing.lockedBy,
              lockedAt: existing.lockedAt,
              reason: existing.reason,
            }
          : { surface, lockedBy: actor },
        after: null,
        reversible: true,
      });
    } catch {
      // non-fatal
    }
    return { ok: true, status: 200, surface };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function runRevertHistoryChangeCommand(
  projectId: string,
  changeId: string,
  actor = "dashboard",
): RevertHistoryChangeCommandResult {
  const result = revertChange(projectId, changeId, actor);
  if (!result.ok) {
    return { ok: false, status: 400, error: result.reason };
  }

  let applied = false;
  let applyReason: string | undefined;

  try {
    const db = getDb(projectId);
    const original = getChange(changeId, db);
    if (original?.before) {
      const beforeState = JSON.parse(original.before);
      switch (original.resourceType) {
        case "config": {
          const restore = runSaveConfigCommand(projectId, {
            section: original.resourceId,
            data: beforeState,
            actor,
          });
          if (restore.ok) {
            applied = true;
          } else {
            applyReason = restore.error;
          }
          break;
        }
        case "budget": {
          applyReason = "Budget revert recorded — apply manually via budget allocation UI";
          break;
        }
        case "agent": {
          if (beforeState.disabled === true) {
            disableAgent(projectId, original.resourceId, "Reverted to previous state");
          } else {
            enableAgent(projectId, original.resourceId);
          }
          applied = true;
          break;
        }
        case "lock": {
          if (beforeState.locked) {
            acquireLock(projectId, original.resourceId, beforeState.lockedBy ?? actor, beforeState.reason, db);
          } else {
            const currentLock = getLock(projectId, original.resourceId, db);
            releaseLock(projectId, original.resourceId, currentLock?.lockedBy ?? actor, db);
          }
          applied = true;
          break;
        }
        default:
          applyReason = `Automatic revert not supported for resource type "${original.resourceType}"`;
      }
    } else {
      applyReason = "No before snapshot available";
    }
  } catch (err) {
    applyReason = err instanceof Error ? err.message : String(err);
  }

  try {
    writeAuditEntry({
      projectId,
      actor,
      action: "history_revert",
      targetType: "change_record",
      targetId: changeId,
      detail: JSON.stringify({ changeId, revertChangeId: result.revertChangeId, applied }),
    });
  } catch {
    // non-fatal
  }

  return {
    ok: true,
    status: 200,
    changeId: result.changeId,
    revertChangeId: result.revertChangeId,
    applied,
    ...(applyReason ? { applyReason } : {}),
  };
}
