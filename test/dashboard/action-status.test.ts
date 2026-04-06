import { describe, it, expect, beforeEach } from "vitest";
import { getMemoryDb } from "../../src/db.js";
import {
  createActionRecord,
  updateActionStatus,
  getActionRecord,
  listActionRecords,
  cleanupOldRecords,
  withActionTracking,
  withActionTrackingSync,
  ensureActionStatusTable,
} from "../../src/dashboard/action-status.js";
import type { DatabaseSync } from "node:sqlite";

function makeDb(): DatabaseSync {
  const db = getMemoryDb();
  ensureActionStatusTable(db);
  return db;
}

describe("createActionRecord", () => {
  it("returns an ID and inserts an accepted record", () => {
    const db = makeDb();
    const id = createActionRecord("proj1", "domain_kill", "dashboard", "some detail", db);
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");

    const record = getActionRecord(id, db);
    expect(record).toBeDefined();
    expect(record!.status).toBe("accepted");
    expect(record!.projectId).toBe("proj1");
    expect(record!.action).toBe("domain_kill");
    expect(record!.actor).toBe("dashboard");
    expect(record!.detail).toBe("some detail");
    expect(record!.startedAt).toBeGreaterThan(0);
    expect(record!.completedAt).toBeUndefined();
  });

  it("generates unique IDs for multiple calls", () => {
    const db = makeDb();
    const id1 = createActionRecord("proj1", "domain_kill", "dashboard", undefined, db);
    const id2 = createActionRecord("proj1", "domain_kill", "dashboard", undefined, db);
    expect(id1).not.toBe(id2);
  });
});

describe("updateActionStatus", () => {
  it("transitions accepted -> in_progress correctly", () => {
    const db = makeDb();
    const id = createActionRecord("proj1", "agent_kill", "user1", undefined, db);
    updateActionStatus(id, "in_progress", undefined, db);

    const record = getActionRecord(id, db);
    expect(record!.status).toBe("in_progress");
    expect(record!.completedAt).toBeUndefined();
  });

  it("transitions in_progress -> completed and sets completedAt", () => {
    const db = makeDb();
    const id = createActionRecord("proj1", "agent_kill", "user1", undefined, db);
    updateActionStatus(id, "in_progress", undefined, db);
    updateActionStatus(id, "completed", undefined, db);

    const record = getActionRecord(id, db);
    expect(record!.status).toBe("completed");
    expect(record!.completedAt).toBeGreaterThan(0);
    expect(record!.error).toBeUndefined();
  });

  it("transitions in_progress -> failed and stores error message", () => {
    const db = makeDb();
    const id = createActionRecord("proj1", "config_save", "user1", undefined, db);
    updateActionStatus(id, "in_progress", undefined, db);
    updateActionStatus(id, "failed", "Something went wrong", db);

    const record = getActionRecord(id, db);
    expect(record!.status).toBe("failed");
    expect(record!.completedAt).toBeGreaterThan(0);
    expect(record!.error).toBe("Something went wrong");
  });
});

describe("getActionRecord", () => {
  it("retrieves a record by ID", () => {
    const db = makeDb();
    const id = createActionRecord("proj1", "budget_allocate", "admin", "allocating", db);
    const record = getActionRecord(id, db);

    expect(record).toBeDefined();
    expect(record!.id).toBe(id);
    expect(record!.action).toBe("budget_allocate");
  });

  it("returns undefined for unknown ID", () => {
    const db = makeDb();
    const record = getActionRecord("nonexistent-id", db);
    expect(record).toBeUndefined();
  });
});

describe("listActionRecords", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeDb();
    // Create a mix of records with different statuses
    const id1 = createActionRecord("proj1", "domain_kill", "user1", undefined, db);
    updateActionStatus(id1, "in_progress", undefined, db);
    updateActionStatus(id1, "completed", undefined, db);

    const id2 = createActionRecord("proj1", "agent_kill", "user1", undefined, db);
    updateActionStatus(id2, "in_progress", undefined, db);
    updateActionStatus(id2, "failed", "Timeout", db);

    createActionRecord("proj1", "config_save", "user2", undefined, db); // stays accepted

    // Different project — should not appear in proj1 queries
    createActionRecord("proj2", "domain_kill", "user1", undefined, db);
  });

  it("returns all records for a project", () => {
    const records = listActionRecords("proj1", undefined, db);
    expect(records).toHaveLength(3);
    for (const r of records) {
      expect(r.projectId).toBe("proj1");
    }
  });

  it("filters by status=completed", () => {
    const records = listActionRecords("proj1", { status: "completed" }, db);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("completed");
    expect(records[0]!.action).toBe("domain_kill");
  });

  it("filters by status=failed", () => {
    const records = listActionRecords("proj1", { status: "failed" }, db);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("failed");
    expect(records[0]!.error).toBe("Timeout");
  });

  it("filters by status=accepted", () => {
    const records = listActionRecords("proj1", { status: "accepted" }, db);
    expect(records).toHaveLength(1);
    expect(records[0]!.action).toBe("config_save");
  });

  it("respects limit", () => {
    const records = listActionRecords("proj1", { limit: 2 }, db);
    expect(records).toHaveLength(2);
  });

  it("respects offset for pagination", () => {
    const page1 = listActionRecords("proj1", { limit: 2, offset: 0 }, db);
    const page2 = listActionRecords("proj1", { limit: 2, offset: 2 }, db);

    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(1);

    const allIds = new Set([...page1.map((r) => r.id), ...page2.map((r) => r.id)]);
    expect(allIds.size).toBe(3);
  });

  it("does not return records from other projects", () => {
    const records = listActionRecords("proj2", undefined, db);
    expect(records).toHaveLength(1);
    expect(records[0]!.projectId).toBe("proj2");
  });
});

describe("cleanupOldRecords", () => {
  it("removes old completed and failed records", () => {
    const db = makeDb();
    const now = Date.now();
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

    // Insert an old completed record manually
    db.prepare(
      `INSERT INTO action_records (id, project_id, action, status, actor, started_at, completed_at)
       VALUES (?, 'proj1', 'domain_kill', 'completed', 'user1', ?, ?)`,
    ).run("old-completed-id", tenDaysAgo, tenDaysAgo + 1000);

    // Insert a recent completed record
    const recentId = createActionRecord("proj1", "agent_kill", "user1", undefined, db);
    updateActionStatus(recentId, "in_progress", undefined, db);
    updateActionStatus(recentId, "completed", undefined, db);

    const removed = cleanupOldRecords("proj1", 7, db);
    expect(removed).toBe(1);

    const remaining = listActionRecords("proj1", undefined, db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(recentId);
  });

  it("does not remove accepted or in_progress records even if old", () => {
    const db = makeDb();
    const now = Date.now();
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

    db.prepare(
      `INSERT INTO action_records (id, project_id, action, status, actor, started_at)
       VALUES (?, 'proj1', 'domain_kill', 'accepted', 'user1', ?)`,
    ).run("old-accepted-id", tenDaysAgo);

    const removed = cleanupOldRecords("proj1", 7, db);
    expect(removed).toBe(0);

    const remaining = listActionRecords("proj1", undefined, db);
    expect(remaining).toHaveLength(1);
  });
});

describe("withActionTracking", () => {
  it("wraps a successful async action and returns completed status", async () => {
    const db = makeDb();
    const { actionId, result } = await withActionTracking(
      "proj1",
      "domain_kill",
      "user1",
      async () => "success-value",
      db,
    );

    expect(actionId).toBeTruthy();
    expect(result).toBe("success-value");

    const record = getActionRecord(actionId, db);
    expect(record!.status).toBe("completed");
    expect(record!.completedAt).toBeGreaterThan(0);
    expect(record!.error).toBeUndefined();
  });

  it("marks failed action as failed with error message", async () => {
    const db = makeDb();

    let capturedActionId: string | undefined;
    await expect(
      withActionTracking(
        "proj1",
        "agent_kill",
        "user1",
        async () => {
          // We can't get the actionId from inside fn, so test the record after
          throw new Error("kill failed");
        },
        db,
      ),
    ).rejects.toThrow("kill failed");

    // Find the failed record
    const records = listActionRecords("proj1", { status: "failed" }, db);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("failed");
    expect(records[0]!.error).toBe("kill failed");
    expect(records[0]!.completedAt).toBeGreaterThan(0);
  });

  it("transitions through accepted -> in_progress -> completed", async () => {
    const db = makeDb();
    let statusDuringExecution: string | undefined;

    const { actionId } = await withActionTracking(
      "proj1",
      "config_save",
      "user1",
      async () => {
        // Capture status while fn is running (should be in_progress)
        const allRecords = listActionRecords("proj1", undefined, db);
        statusDuringExecution = allRecords[0]?.status;
        return "done";
      },
      db,
    );

    expect(statusDuringExecution).toBe("in_progress");
    const record = getActionRecord(actionId, db);
    expect(record!.status).toBe("completed");
  });
});

describe("withActionTrackingSync", () => {
  it("wraps a successful sync action and returns completed status", () => {
    const db = makeDb();
    const { actionId, result } = withActionTrackingSync(
      "proj1",
      "config_save",
      "user1",
      () => 42,
      db,
    );

    expect(actionId).toBeTruthy();
    expect(result).toBe(42);

    const record = getActionRecord(actionId, db);
    expect(record!.status).toBe("completed");
  });

  it("marks failed sync action as failed", () => {
    const db = makeDb();

    expect(() =>
      withActionTrackingSync(
        "proj1",
        "budget_allocate",
        "user1",
        () => { throw new Error("sync error"); },
        db,
      ),
    ).toThrow("sync error");

    const records = listActionRecords("proj1", { status: "failed" }, db);
    expect(records).toHaveLength(1);
    expect(records[0]!.error).toBe("sync error");
  });
});
