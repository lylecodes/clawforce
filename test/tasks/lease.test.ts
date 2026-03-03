import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createTask, transitionTask, acquireTaskLease, releaseTaskLease, renewTaskLease } =
  await import("../../src/tasks/ops.js");

describe("task leases", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("acquires a lease on a task", () => {
    const task = createTask({ projectId: PROJECT, title: "Test", createdBy: "agent:pm" }, db);

    const acquired = acquireTaskLease(PROJECT, task.id, "agent:worker", 60000, db);
    expect(acquired).toBe(true);

    // Verify lease data in DB
    const row = db.prepare("SELECT lease_holder, lease_expires_at FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(row.lease_holder).toBe("agent:worker");
    expect(row.lease_expires_at).toBeGreaterThan(Date.now());
  });

  it("rejects competing lease acquisition", () => {
    const task = createTask({ projectId: PROJECT, title: "Test", createdBy: "agent:pm" }, db);

    const a1 = acquireTaskLease(PROJECT, task.id, "agent:worker1", 60000, db);
    expect(a1).toBe(true);

    const a2 = acquireTaskLease(PROJECT, task.id, "agent:worker2", 60000, db);
    expect(a2).toBe(false);
  });

  it("allows acquisition after lease expires", () => {
    const task = createTask({ projectId: PROJECT, title: "Test", createdBy: "agent:pm" }, db);

    // Acquire with already-expired lease
    acquireTaskLease(PROJECT, task.id, "agent:worker1", -1000, db);

    // Should succeed because previous lease has expired
    const a2 = acquireTaskLease(PROJECT, task.id, "agent:worker2", 60000, db);
    expect(a2).toBe(true);
  });

  it("allows same holder to re-acquire", () => {
    const task = createTask({ projectId: PROJECT, title: "Test", createdBy: "agent:pm" }, db);

    acquireTaskLease(PROJECT, task.id, "agent:worker", -1000, db);
    const a2 = acquireTaskLease(PROJECT, task.id, "agent:worker", 60000, db);
    expect(a2).toBe(true);
  });

  it("releases a lease", () => {
    const task = createTask({ projectId: PROJECT, title: "Test", createdBy: "agent:pm" }, db);

    acquireTaskLease(PROJECT, task.id, "agent:worker", 60000, db);
    const released = releaseTaskLease(PROJECT, task.id, "agent:worker", db);
    expect(released).toBe(true);

    // Verify cleared
    const row = db.prepare("SELECT lease_holder FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(row.lease_holder).toBeNull();
  });

  it("only holder can release lease", () => {
    const task = createTask({ projectId: PROJECT, title: "Test", createdBy: "agent:pm" }, db);

    acquireTaskLease(PROJECT, task.id, "agent:worker1", 60000, db);
    const released = releaseTaskLease(PROJECT, task.id, "agent:worker2", db);
    expect(released).toBe(false);
  });

  it("renews a lease", () => {
    const task = createTask({ projectId: PROJECT, title: "Test", createdBy: "agent:pm" }, db);

    acquireTaskLease(PROJECT, task.id, "agent:worker", 1000, db);
    const renewed = renewTaskLease(PROJECT, task.id, "agent:worker", 120000, db);
    expect(renewed).toBe(true);

    const row = db.prepare("SELECT lease_expires_at FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown>;
    expect((row.lease_expires_at as number)).toBeGreaterThan(Date.now() + 60000);
  });

  it("only holder can renew lease", () => {
    const task = createTask({ projectId: PROJECT, title: "Test", createdBy: "agent:pm" }, db);

    acquireTaskLease(PROJECT, task.id, "agent:worker1", 60000, db);
    const renewed = renewTaskLease(PROJECT, task.id, "agent:worker2", 120000, db);
    expect(renewed).toBe(false);
  });

  it("blocks transition when conflicting lease exists", () => {
    const task = createTask({ projectId: PROJECT, title: "Test", createdBy: "agent:pm" }, db);

    // Agent 1 acquires lease
    acquireTaskLease(PROJECT, task.id, "agent:leaser", 60000, db);

    // Agent 2 tries to transition OPEN → ASSIGNED
    const result = transitionTask({
      projectId: PROJECT,
      taskId: task.id,
      toState: "ASSIGNED",
      actor: "agent:other",
    }, db);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("leased");
  });

  it("allows transition by lease holder", () => {
    const task = createTask({ projectId: PROJECT, title: "Test", createdBy: "agent:pm" }, db);

    acquireTaskLease(PROJECT, task.id, "agent:worker", 60000, db);

    const result = transitionTask({
      projectId: PROJECT,
      taskId: task.id,
      toState: "ASSIGNED",
      actor: "agent:worker",
    }, db);

    expect(result.ok).toBe(true);
  });

  it("allows transition when lease is expired", () => {
    const task = createTask({ projectId: PROJECT, title: "Test", createdBy: "agent:pm" }, db);

    acquireTaskLease(PROJECT, task.id, "agent:old", -1000, db);

    const result = transitionTask({
      projectId: PROJECT,
      taskId: task.id,
      toState: "ASSIGNED",
      actor: "agent:new",
    }, db);

    expect(result.ok).toBe(true);
  });
});
