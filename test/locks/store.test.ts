import { describe, it, expect, beforeEach } from "vitest";
import { getMemoryDb } from "../../src/db.js";
import {
  acquireLock,
  releaseLock,
  getLock,
  listLocks,
  isLocked,
  ensureLockTable,
} from "../../src/locks/store.js";
import type { DatabaseSync } from "node:sqlite";

describe("locks/store", () => {
  let db: DatabaseSync;
  const projectId = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
    ensureLockTable(db);
  });

  describe("acquireLock", () => {
    it("creates a lock", () => {
      const lock = acquireLock(projectId, "budget", "human-1", "protect budget", db);

      expect(lock.projectId).toBe(projectId);
      expect(lock.surface).toBe("budget");
      expect(lock.lockedBy).toBe("human-1");
      expect(lock.reason).toBe("protect budget");
      expect(typeof lock.lockedAt).toBe("number");
      expect(typeof lock.id).toBe("string");
    });

    it("creates a lock without a reason", () => {
      const lock = acquireLock(projectId, "budget", "human-1", undefined, db);
      expect(lock.reason).toBeUndefined();
    });

    it("throws when surface is already locked by another actor", () => {
      acquireLock(projectId, "budget", "human-1", "first lock", db);

      expect(() => {
        acquireLock(projectId, "budget", "human-2", "second lock", db);
      }).toThrow(/already locked/i);
    });

    it("throws when surface is already locked by the same actor", () => {
      acquireLock(projectId, "budget", "human-1", "first lock", db);

      expect(() => {
        acquireLock(projectId, "budget", "human-1", "again", db);
      }).toThrow(/already locked/i);
    });

    it("allows locking different surfaces independently", () => {
      const lock1 = acquireLock(projectId, "budget", "human-1", undefined, db);
      const lock2 = acquireLock(projectId, "jobs", "human-1", undefined, db);

      expect(lock1.surface).toBe("budget");
      expect(lock2.surface).toBe("jobs");
    });

    it("allows locking same surface in different projects", () => {
      const lock1 = acquireLock("project-a", "budget", "human-1", undefined, db);
      const lock2 = acquireLock("project-b", "budget", "human-1", undefined, db);

      expect(lock1.projectId).toBe("project-a");
      expect(lock2.projectId).toBe("project-b");
    });
  });

  describe("releaseLock", () => {
    it("removes the lock", () => {
      acquireLock(projectId, "budget", "human-1", undefined, db);
      expect(isLocked(projectId, "budget", db)).toBe(true);

      releaseLock(projectId, "budget", "human-1", db);
      expect(isLocked(projectId, "budget", db)).toBe(false);
    });

    it("does not throw when surface is not locked", () => {
      expect(() => {
        releaseLock(projectId, "budget", "human-1", db);
      }).not.toThrow();
    });

    it("allows re-locking after release", () => {
      acquireLock(projectId, "budget", "human-1", undefined, db);
      releaseLock(projectId, "budget", "human-1", db);

      const lock = acquireLock(projectId, "budget", "human-2", "new lock", db);
      expect(lock.lockedBy).toBe("human-2");
    });
  });

  describe("getLock", () => {
    it("returns null when surface is not locked", () => {
      const lock = getLock(projectId, "budget", db);
      expect(lock).toBeNull();
    });

    it("returns the lock entry when locked", () => {
      acquireLock(projectId, "budget", "human-1", "test reason", db);
      const lock = getLock(projectId, "budget", db);

      expect(lock).not.toBeNull();
      expect(lock!.surface).toBe("budget");
      expect(lock!.lockedBy).toBe("human-1");
      expect(lock!.reason).toBe("test reason");
    });

    it("returns null after release", () => {
      acquireLock(projectId, "budget", "human-1", undefined, db);
      releaseLock(projectId, "budget", "human-1", db);

      expect(getLock(projectId, "budget", db)).toBeNull();
    });
  });

  describe("listLocks", () => {
    it("returns empty array when no locks", () => {
      const locks = listLocks(projectId, db);
      expect(locks).toEqual([]);
    });

    it("returns all active locks for the project", () => {
      acquireLock(projectId, "budget", "human-1", undefined, db);
      acquireLock(projectId, "jobs", "human-2", "protect jobs", db);

      const locks = listLocks(projectId, db);
      expect(locks).toHaveLength(2);

      const surfaces = locks.map((l) => l.surface);
      expect(surfaces).toContain("budget");
      expect(surfaces).toContain("jobs");
    });

    it("only returns locks for the specified project", () => {
      acquireLock("project-a", "budget", "human-1", undefined, db);
      acquireLock("project-b", "budget", "human-2", undefined, db);

      const locksA = listLocks("project-a", db);
      expect(locksA).toHaveLength(1);
      expect(locksA[0]!.projectId).toBe("project-a");
    });

    it("does not include released locks", () => {
      acquireLock(projectId, "budget", "human-1", undefined, db);
      acquireLock(projectId, "jobs", "human-1", undefined, db);
      releaseLock(projectId, "budget", "human-1", db);

      const locks = listLocks(projectId, db);
      expect(locks).toHaveLength(1);
      expect(locks[0]!.surface).toBe("jobs");
    });
  });

  describe("isLocked", () => {
    it("returns false when not locked", () => {
      expect(isLocked(projectId, "budget", db)).toBe(false);
    });

    it("returns true when locked", () => {
      acquireLock(projectId, "budget", "human-1", undefined, db);
      expect(isLocked(projectId, "budget", db)).toBe(true);
    });

    it("returns false after release", () => {
      acquireLock(projectId, "budget", "human-1", undefined, db);
      releaseLock(projectId, "budget", "human-1", db);
      expect(isLocked(projectId, "budget", db)).toBe(false);
    });
  });
});
