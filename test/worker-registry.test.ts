import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { getMemoryDb } = await import("../src/db.js");
const dbModule = await import("../src/db.js");
const lifecycleModule = await import("../src/lifecycle.js");
const {
  registerWorkerAssignment,
  getWorkerAssignment,
  clearWorkerAssignment,
  listAllAssignments,
  resetWorkerRegistryForTest,
} = await import("../src/worker-registry.js");

describe("worker-registry", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    vi.spyOn(lifecycleModule, "getActiveProjectIds").mockReturnValue(["proj1", "proj2"]);
    resetWorkerRegistryForTest();
  });

  afterEach(() => {
    try { db.close(); } catch {}
    vi.restoreAllMocks();
  });

  it("registers and retrieves a worker assignment", () => {
    registerWorkerAssignment("agent:bob", "proj1", "task-1", db);
    const assignment = getWorkerAssignment("agent:bob", db);
    expect(assignment).not.toBeNull();
    expect(assignment!.projectId).toBe("proj1");
    expect(assignment!.taskId).toBe("task-1");
  });

  it("returns null for unknown agent", () => {
    const assignment = getWorkerAssignment("agent:unknown", db);
    expect(assignment).toBeNull();
  });

  it("clears a worker assignment", () => {
    registerWorkerAssignment("agent:bob", "proj1", "task-1", db);
    clearWorkerAssignment("agent:bob", db);
    expect(getWorkerAssignment("agent:bob", db)).toBeNull();
  });

  it("overwrites existing assignment on re-register", () => {
    registerWorkerAssignment("agent:bob", "proj1", "task-1", db);
    registerWorkerAssignment("agent:bob", "proj2", "task-2", db);
    const assignment = getWorkerAssignment("agent:bob", db);
    expect(assignment!.projectId).toBe("proj2");
    expect(assignment!.taskId).toBe("task-2");
  });

  it("resetWorkerRegistryForTest clears all assignments", () => {
    registerWorkerAssignment("agent:a", "proj1", "t1", db);
    registerWorkerAssignment("agent:b", "proj2", "t2", db);
    resetWorkerRegistryForTest();
    expect(getWorkerAssignment("agent:a", db)).toBeNull();
    expect(getWorkerAssignment("agent:b", db)).toBeNull();
  });

  describe("listAllAssignments", () => {
    it("returns empty array when no assignments", () => {
      const all = listAllAssignments();
      expect(all).toEqual([]);
    });

    it("returns all registered assignments", () => {
      registerWorkerAssignment("agent:a", "proj1", "t1", db);
      registerWorkerAssignment("agent:b", "proj2", "t2", db);
      const all = listAllAssignments();
      expect(all).toHaveLength(2);

      const ids = all.map((a) => a.agentId).sort();
      expect(ids).toEqual(["agent:a", "agent:b"]);

      const entryA = all.find((a) => a.agentId === "agent:a")!;
      expect(entryA.projectId).toBe("proj1");
      expect(entryA.taskId).toBe("t1");
      expect(entryA.assignedAt).toBeGreaterThan(0);
    });

    it("reflects cleared assignments", () => {
      registerWorkerAssignment("agent:a", "proj1", "t1", db);
      registerWorkerAssignment("agent:b", "proj2", "t2", db);
      clearWorkerAssignment("agent:a", db);
      const all = listAllAssignments();
      expect(all).toHaveLength(1);
      expect(all[0]!.agentId).toBe("agent:b");
    });
  });

  describe("DB persistence", () => {
    it("persists assignment to DB", () => {
      registerWorkerAssignment("agent:bob", "proj1", "task-1", db);

      const row = db.prepare("SELECT * FROM worker_assignments WHERE agent_id = ?")
        .get("agent:bob") as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row!.project_id).toBe("proj1");
      expect(row!.task_id).toBe("task-1");
    });

    it("recovers assignment from DB on cache miss", () => {
      // Register, then clear in-memory only
      registerWorkerAssignment("agent:bob", "proj1", "task-1", db);
      resetWorkerRegistryForTest(); // clears in-memory cache only

      // Create the task so getWorkerAssignment can verify it's still active
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries)
        VALUES (?, ?, ?, 'ASSIGNED', 'P2', 'agent:pm', ?, ?, 0, 3)
      `).run("task-1", "proj1", "Test task", Date.now(), Date.now());

      // Should recover from DB
      const assignment = getWorkerAssignment("agent:bob", db);
      expect(assignment).not.toBeNull();
      expect(assignment!.projectId).toBe("proj1");
      expect(assignment!.taskId).toBe("task-1");
    });

    it("cleans up stale assignment for DONE task on DB lookup", () => {
      registerWorkerAssignment("agent:bob", "proj1", "task-1", db);
      resetWorkerRegistryForTest();

      // Create the task in DONE state
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries)
        VALUES (?, ?, ?, 'DONE', 'P2', 'agent:pm', ?, ?, 0, 3)
      `).run("task-1", "proj1", "Test task", Date.now(), Date.now());

      // Should NOT recover — task is terminal
      const assignment = getWorkerAssignment("agent:bob", db);
      expect(assignment).toBeNull();

      // DB row should be cleaned up
      const row = db.prepare("SELECT * FROM worker_assignments WHERE agent_id = ?")
        .get("agent:bob") as Record<string, unknown> | undefined;
      expect(row).toBeUndefined();
    });

    it("cleans up stale assignment for FAILED task on DB lookup", () => {
      registerWorkerAssignment("agent:bob", "proj1", "task-1", db);
      resetWorkerRegistryForTest();

      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries)
        VALUES (?, ?, ?, 'FAILED', 'P2', 'agent:pm', ?, ?, 0, 3)
      `).run("task-1", "proj1", "Test task", Date.now(), Date.now());

      const assignment = getWorkerAssignment("agent:bob", db);
      expect(assignment).toBeNull();
    });

    it("clearWorkerAssignment removes from DB", () => {
      registerWorkerAssignment("agent:bob", "proj1", "task-1", db);
      clearWorkerAssignment("agent:bob", db);

      const row = db.prepare("SELECT * FROM worker_assignments WHERE agent_id = ?")
        .get("agent:bob") as Record<string, unknown> | undefined;
      expect(row).toBeUndefined();
    });
  });
});
