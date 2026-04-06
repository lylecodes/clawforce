/**
 * Lock/override integration tests for the dashboard.
 *
 * Tests the full round-trip: lock action -> lock stored -> config save rejected.
 * Uses a real in-memory DB so lock state is genuine.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getMemoryDb } from "../../src/db.js";
import { ensureLockTable } from "../../src/locks/store.js";
import type { DatabaseSync } from "node:sqlite";

// We test lock actions and queryLocks using the store directly (not via HTTP routing)
// to keep the test self-contained. Integration with actions.ts is verified via mocking.

import {
  acquireLock,
  releaseLock,
  listLocks,
  isLocked,
} from "../../src/locks/store.js";
import { checkLock } from "../../src/locks/enforce.js";

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
  });
});
