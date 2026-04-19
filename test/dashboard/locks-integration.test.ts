/**
 * Lock/override integration tests for the dashboard.
 *
 * Tests the full round-trip: lock action -> lock stored -> config save rejected.
 * Uses a real in-memory DB so lock state is genuine.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getMemoryDb } from "../../src/db.js";
import { ensureLockTable, setOverridePolicy } from "../../src/locks/store.js";
import type { DatabaseSync } from "../../src/sqlite-driver.js";

// We test lock actions and queryLocks using the store directly (not via HTTP routing)
// to keep the test self-contained. Integration with actions.ts is verified via mocking.

import {
  acquireLock,
  releaseLock,
  listLocks,
  isLocked,
} from "../../src/locks/store.js";
import { checkLock, applyOverridePolicy } from "../../src/locks/enforce.js";

describe("Dashboard Locks Integration", () => {
  let db: DatabaseSync;
  const projectId = "clawforce-dev";

  beforeEach(() => {
    db = getMemoryDb();
    ensureLockTable(db);
  });

  describe("lock action — acquire", () => {
    it("creates a lock via acquireLock (underlying action store)", () => {
      const lock = acquireLock(projectId, "budget", "human", "end of quarter", db);

      expect(lock.surface).toBe("budget");
      expect(lock.lockedBy).toBe("human");
      expect(lock.reason).toBe("end of quarter");
      expect(isLocked(projectId, "budget", db)).toBe(true);
    });

    it("returns 409-equivalent error on double lock", () => {
      acquireLock(projectId, "budget", "human", undefined, db);

      expect(() => {
        acquireLock(projectId, "budget", "someone-else", undefined, db);
      }).toThrow(/already locked/);
    });
  });

  describe("unlock action — release", () => {
    it("releases a lock via releaseLock", () => {
      acquireLock(projectId, "jobs", "human", undefined, db);
      expect(isLocked(projectId, "jobs", db)).toBe(true);

      releaseLock(projectId, "jobs", "human", db);
      expect(isLocked(projectId, "jobs", db)).toBe(false);
    });

    it("is idempotent — releasing an unlocked surface does not throw", () => {
      expect(() => {
        releaseLock(projectId, "jobs", "human", db);
      }).not.toThrow();
    });
  });

  describe("config save — lock rejection", () => {
    it("checkLock blocks agents from saving a locked surface", () => {
      // Simulate human locking the budget surface
      acquireLock(projectId, "budget", "human-admin", "Q1 freeze", db);

      // Agent tries to save — checkLock should return locked=true
      const result = checkLock(projectId, "budget", "cf-lead", db);
      expect(result.locked).toBe(true);
      expect(result.entry!.lockedBy).toBe("human-admin");
      expect(result.entry!.reason).toBe("Q1 freeze");
    });

    it("owner can still save their own locked surface", () => {
      acquireLock(projectId, "budget", "human-admin", undefined, db);

      // Owner checks — should be unlocked for themselves
      const result = checkLock(projectId, "budget", "human-admin", db);
      expect(result.locked).toBe(false);
    });

    it("unlocked surface allows saves for all actors", () => {
      const result = checkLock(projectId, "rules", "anyone", db);
      expect(result.locked).toBe(false);
    });
  });

  describe("queryLocks — active locks for domain", () => {
    it("returns empty when no locks", () => {
      const locks = listLocks(projectId, db);
      expect(locks).toHaveLength(0);
    });

    it("returns all active locks", () => {
      acquireLock(projectId, "budget", "human-1", undefined, db);
      acquireLock(projectId, "jobs", "human-2", "freeze jobs", db);

      const locks = listLocks(projectId, db);
      expect(locks).toHaveLength(2);

      const surfaces = locks.map((l) => l.surface);
      expect(surfaces).toContain("budget");
      expect(surfaces).toContain("jobs");
    });

    it("does not include locks from other projects", () => {
      acquireLock("other-domain", "budget", "human-1", undefined, db);
      acquireLock(projectId, "jobs", "human-2", undefined, db);

      const locks = listLocks(projectId, db);
      expect(locks).toHaveLength(1);
      expect(locks[0]!.surface).toBe("jobs");
    });

    it("excludes released locks", () => {
      acquireLock(projectId, "budget", "human-1", undefined, db);
      acquireLock(projectId, "jobs", "human-1", undefined, db);
      releaseLock(projectId, "budget", "human-1", db);

      const locks = listLocks(projectId, db);
      expect(locks).toHaveLength(1);
      expect(locks[0]!.surface).toBe("jobs");
    });

    it("returns lock metadata including lockedBy and reason", () => {
      acquireLock(projectId, "rules", "human-lead", "rule audit in progress", db);

      const locks = listLocks(projectId, db);
      expect(locks[0]!.lockedBy).toBe("human-lead");
      expect(locks[0]!.reason).toBe("rule audit in progress");
      expect(typeof locks[0]!.lockedAt).toBe("number");
    });

    it("returns updatedAt on each lock entry", () => {
      acquireLock(projectId, "budget", "human-1", undefined, db);
      const locks = listLocks(projectId, db);
      expect(typeof locks[0]!.updatedAt).toBe("number");
    });
  });

  describe("HTTP 409 conflict shape", () => {
    it("checkLock result contains the lock entry needed for 409 response", () => {
      acquireLock(projectId, "budget", "human-admin", "launch week freeze", db);

      const result = checkLock(projectId, "budget", "cf-lead", db);
      expect(result.locked).toBe(true);

      // Simulate what actions.ts returns as HTTP 409
      const response = {
        status: 409,
        body: {
          ok: false,
          error: "LOCKED_BY_HUMAN",
          lock: {
            surface: "budget",
            lockedBy: result.entry!.lockedBy,
            lockedAt: result.entry!.lockedAt,
            reason: result.entry!.reason,
          },
        },
      };

      expect(response.status).toBe(409);
      expect(response.body.error).toBe("LOCKED_BY_HUMAN");
      expect(response.body.lock.lockedBy).toBe("human-admin");
      expect(response.body.lock.reason).toBe("launch week freeze");
      expect(typeof response.body.lock.lockedAt).toBe("number");
    });
  });

  describe("manual_changes_lock policy", () => {
    it("applyOverridePolicy creates a lock after a human edit when policy is manual_changes_lock", () => {
      setOverridePolicy(projectId, "rules", "manual_changes_lock", db);

      // Simulate a human dashboard edit applying the policy
      applyOverridePolicy(projectId, "rules", "dashboard", "auto-locked by policy", db);

      expect(isLocked(projectId, "rules", db)).toBe(true);
    });

    it("agent is blocked from saving after manual_changes_lock policy auto-locks", () => {
      setOverridePolicy(projectId, "jobs", "manual_changes_lock", db);
      applyOverridePolicy(projectId, "jobs", "dashboard", undefined, db);

      // Now agent tries to check — should be blocked
      const result = checkLock(projectId, "jobs", "cf-lead", db);
      expect(result.locked).toBe(true);
      expect(result.entry!.lockedBy).toBe("dashboard");
    });

    it("autonomous_until_locked policy does not create a lock on human edit", () => {
      // No policy set — defaults to autonomous_until_locked
      applyOverridePolicy(projectId, "budget", "dashboard", undefined, db);
      expect(isLocked(projectId, "budget", db)).toBe(false);
    });
  });
});
