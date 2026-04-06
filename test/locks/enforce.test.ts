import { describe, it, expect, beforeEach } from "vitest";
import { getMemoryDb } from "../../src/db.js";
import { acquireLock, ensureLockTable } from "../../src/locks/store.js";
import { checkLock, requireUnlocked } from "../../src/locks/enforce.js";
import type { DatabaseSync } from "node:sqlite";

describe("locks/enforce", () => {
  let db: DatabaseSync;
  const projectId = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
    ensureLockTable(db);
  });

  describe("checkLock", () => {
    it("returns locked=false when no lock exists", () => {
      const result = checkLock(projectId, "budget", "anyone", db);
      expect(result.locked).toBe(false);
      expect(result.entry).toBeUndefined();
    });

    it("returns locked=true when locked by a different actor", () => {
      acquireLock(projectId, "budget", "human-1", "protecting budget", db);

      const result = checkLock(projectId, "budget", "agent-a", db);
      expect(result.locked).toBe(true);
      expect(result.entry).toBeDefined();
      expect(result.entry!.lockedBy).toBe("human-1");
      expect(result.entry!.surface).toBe("budget");
    });

    it("returns locked=false when locked by the same actor (owner bypass)", () => {
      acquireLock(projectId, "budget", "human-1", undefined, db);

      const result = checkLock(projectId, "budget", "human-1", db);
      expect(result.locked).toBe(false);
    });

    it("returns locked=true for one actor but not the owner", () => {
      acquireLock(projectId, "jobs", "human-admin", "freeze jobs", db);

      const ownerResult = checkLock(projectId, "jobs", "human-admin", db);
      expect(ownerResult.locked).toBe(false);

      const agentResult = checkLock(projectId, "jobs", "cf-lead", db);
      expect(agentResult.locked).toBe(true);
      expect(agentResult.entry!.reason).toBe("freeze jobs");
    });

    it("is not locked for a different surface", () => {
      acquireLock(projectId, "budget", "human-1", undefined, db);

      const result = checkLock(projectId, "jobs", "agent-a", db);
      expect(result.locked).toBe(false);
    });
  });

  describe("requireUnlocked", () => {
    it("does not throw when no lock exists", () => {
      expect(() => {
        requireUnlocked(projectId, "budget", "agent-a", db);
      }).not.toThrow();
    });

    it("does not throw when locked by the same actor (owner bypass)", () => {
      acquireLock(projectId, "budget", "human-1", undefined, db);

      expect(() => {
        requireUnlocked(projectId, "budget", "human-1", db);
      }).not.toThrow();
    });

    it("throws when surface is locked by a different actor", () => {
      acquireLock(projectId, "budget", "human-1", "protecting budget", db);

      expect(() => {
        requireUnlocked(projectId, "budget", "agent-x", db);
      }).toThrow(/locked by "human-1"/);
    });

    it("includes reason in thrown error when present", () => {
      acquireLock(projectId, "budget", "human-1", "quarterly freeze", db);

      expect(() => {
        requireUnlocked(projectId, "budget", "agent-x", db);
      }).toThrow(/quarterly freeze/);
    });

    it("throws with surface name in error", () => {
      acquireLock(projectId, "rules", "human-1", undefined, db);

      expect(() => {
        requireUnlocked(projectId, "rules", "agent-x", db);
      }).toThrow(/rules/);
    });
  });
});
