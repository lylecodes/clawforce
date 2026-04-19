import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createTask, transitionTask, attachEvidence, acquireTaskLease } = await import("../../src/tasks/ops.js");
const { enqueue } = await import("../../src/dispatch/queue.js");
const {
  releaseStaleInProgressTasks,
  failStaleDispatchItems,
  releaseExpiredAssignedLeases,
  recoverProject,
} = await import("../../src/dispatch/restart-recovery.js");

describe("restart-recovery", () => {
  let db: DatabaseSync;
  const PROJECT = "test-recovery";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  describe("releaseStaleInProgressTasks", () => {
    it("transitions IN_PROGRESS tasks back to ASSIGNED", () => {
      const task = createTask({
        projectId: PROJECT,
        title: "Orphaned task",
        createdBy: "agent:pm",
        assignedTo: "agent:worker",
      }, db);
      transitionTask({
        projectId: PROJECT,
        taskId: task.id,
        toState: "IN_PROGRESS",
        actor: "agent:worker",
      }, db);

      const released = releaseStaleInProgressTasks(PROJECT, db);
      expect(released).toBe(1);

      // Verify task is back to ASSIGNED
      const rows = db.prepare(
        "SELECT state FROM tasks WHERE id = ?",
      ).all(task.id) as { state: string }[];
      expect(rows[0]!.state).toBe("ASSIGNED");
    });

    it("releases task lease before transitioning", () => {
      const task = createTask({
        projectId: PROJECT,
        title: "Leased orphan",
        createdBy: "agent:pm",
        assignedTo: "agent:worker",
      }, db);
      transitionTask({
        projectId: PROJECT,
        taskId: task.id,
        toState: "IN_PROGRESS",
        actor: "agent:worker",
      }, db);

      // Simulate a lease
      acquireTaskLease(PROJECT, task.id, "dispatch:abc", 300_000, db);

      const released = releaseStaleInProgressTasks(PROJECT, db);
      expect(released).toBe(1);

      // Verify lease is cleared
      const rows = db.prepare(
        "SELECT lease_holder FROM tasks WHERE id = ?",
      ).all(task.id) as { lease_holder: string | null }[];
      expect(rows[0]!.lease_holder).toBeNull();
    });

    it("skips tasks not in IN_PROGRESS", () => {
      createTask({
        projectId: PROJECT,
        title: "Open task",
        createdBy: "agent:pm",
      }, db);

      const released = releaseStaleInProgressTasks(PROJECT, db);
      expect(released).toBe(0);
    });
  });

  describe("failStaleDispatchItems", () => {
    it("fails leased dispatch queue items", () => {
      const task = createTask({
        projectId: PROJECT,
        title: "Dispatched task",
        createdBy: "agent:pm",
      }, db);

      const item = enqueue(PROJECT, task.id, undefined, undefined, db);
      expect(item).not.toBeNull();

      // Simulate a lease on the queue item
      db.prepare(
        "UPDATE dispatch_queue SET leased_at = ?, leased_by = ? WHERE id = ?",
      ).run(Date.now() - 60_000, "agent:worker", item!.id);

      const failed = failStaleDispatchItems(PROJECT, db);
      expect(failed).toBe(1);

      // Verify item is failed
      const rows = db.prepare(
        "SELECT status FROM dispatch_queue WHERE id = ?",
      ).all(item!.id) as { status: string }[];
      expect(rows[0]!.status).toBe("failed");
    });

    it("skips non-leased queued items", () => {
      const task = createTask({
        projectId: PROJECT,
        title: "Queued task",
        createdBy: "agent:pm",
      }, db);
      enqueue(PROJECT, task.id, undefined, undefined, db);

      const failed = failStaleDispatchItems(PROJECT, db);
      expect(failed).toBe(0);
    });
  });

  describe("releaseExpiredAssignedLeases", () => {
    it("releases expired leases on ASSIGNED tasks", () => {
      const task = createTask({
        projectId: PROJECT,
        title: "Expired lease",
        createdBy: "agent:pm",
        assignedTo: "agent:worker",
      }, db);

      // Simulate an expired lease
      db.prepare(
        "UPDATE tasks SET lease_holder = ?, lease_acquired_at = ?, lease_expires_at = ? WHERE id = ?",
      ).run("dispatch:old", Date.now() - 600_000, Date.now() - 300_000, task.id);

      const released = releaseExpiredAssignedLeases(PROJECT, db);
      expect(released).toBe(1);

      // Verify lease is cleared
      const rows = db.prepare(
        "SELECT lease_holder FROM tasks WHERE id = ?",
      ).all(task.id) as { lease_holder: string | null }[];
      expect(rows[0]!.lease_holder).toBeNull();
    });

    it("does not release non-expired leases", () => {
      const task = createTask({
        projectId: PROJECT,
        title: "Active lease",
        createdBy: "agent:pm",
        assignedTo: "agent:worker",
      }, db);

      // Simulate an active (not expired) lease
      db.prepare(
        "UPDATE tasks SET lease_holder = ?, lease_acquired_at = ?, lease_expires_at = ? WHERE id = ?",
      ).run("dispatch:active", Date.now(), Date.now() + 300_000, task.id);

      const released = releaseExpiredAssignedLeases(PROJECT, db);
      expect(released).toBe(0);
    });
  });

  describe("recoverProject", () => {
    it("runs all recovery steps and returns combined results", () => {
      // Create an IN_PROGRESS task (will be released)
      const task1 = createTask({
        projectId: PROJECT,
        title: "Stale in-progress",
        createdBy: "agent:pm",
        assignedTo: "agent:worker",
      }, db);
      transitionTask({
        projectId: PROJECT,
        taskId: task1.id,
        toState: "IN_PROGRESS",
        actor: "agent:worker",
      }, db);

      // Create a task with expired lease (will be released)
      const task2 = createTask({
        projectId: PROJECT,
        title: "Expired lease task",
        createdBy: "agent:pm",
        assignedTo: "agent:worker2",
      }, db);
      db.prepare(
        "UPDATE tasks SET lease_holder = ?, lease_acquired_at = ?, lease_expires_at = ? WHERE id = ?",
      ).run("dispatch:old2", Date.now() - 600_000, Date.now() - 300_000, task2.id);

      const result = recoverProject(PROJECT, db);
      expect(result.staleTasks).toBe(1);
      expect(result.releasedLeases).toBe(1);
      // failedDispatches may be 0 since we didn't set up a leased queue item
      expect(result.failedDispatches).toBeGreaterThanOrEqual(0);
    });
  });
});
