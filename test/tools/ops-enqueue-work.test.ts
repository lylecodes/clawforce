/**
 * Tests for enqueue_work auto-transition: OPEN → ASSIGNED.
 *
 * Regression guard for: "Task in non-dispatchable state: OPEN"
 * (was causing 8,000+ dispatch failures when tasks were enqueued while OPEN).
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");
const { createClawforceOpsTool } = await import("../../src/tools/ops-tool.js");
const workerRegistryModule = await import("../../src/worker-registry.js");
const trackerModule = await import("../../src/enforcement/tracker.js");
const { createTask, getTask } = await import("../../src/tasks/ops.js");

describe("enqueue_work — auto-transition OPEN → ASSIGNED", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    vi.restoreAllMocks();
    workerRegistryModule.resetWorkerRegistryForTest();
    trackerModule.resetTrackerForTest();
  });

  async function execute(params: Record<string, unknown>) {
    const tool = createClawforceOpsTool({ agentSessionKey: "test-lead" });
    const result = await tool.execute("call-1", params);
    return JSON.parse(result.content[0]!.text);
  }

  it("auto-transitions OPEN task to ASSIGNED and enqueues successfully", async () => {
    const task = createTask(
      { projectId: PROJECT, title: "Do something", createdBy: "agent:lead" },
      db,
    );
    expect(task.state).toBe("OPEN");

    const result = await execute({
      action: "enqueue_work",
      project_id: PROJECT,
      enqueue_task_id: task.id,
      enqueue_priority: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.autoTransitioned).toBe(true);
    expect(result.taskId).toBe(task.id);
    expect(result.queueItemId).toBeTruthy();

    // The task should now be ASSIGNED in the DB
    const updatedTask = getTask(PROJECT, task.id, db);
    expect(updatedTask?.state).toBe("ASSIGNED");
  });

  it("does NOT auto-transition tasks already in ASSIGNED state", async () => {
    const { transitionTask } = await import("../../src/tasks/ops.js");
    const task = createTask(
      { projectId: PROJECT, title: "Already assigned", createdBy: "agent:lead" },
      db,
    );
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:lead" }, db);

    const result = await execute({
      action: "enqueue_work",
      project_id: PROJECT,
      enqueue_task_id: task.id,
    });

    expect(result.ok).toBe(true);
    expect(result.autoTransitioned).toBe(false);

    const updatedTask = getTask(PROJECT, task.id, db);
    expect(updatedTask?.state).toBe("ASSIGNED");
  });

  it("does NOT auto-transition tasks in IN_PROGRESS state", async () => {
    const { transitionTask } = await import("../../src/tasks/ops.js");
    const task = createTask(
      { projectId: PROJECT, title: "In progress task", createdBy: "agent:lead" },
      db,
    );
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:lead" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:lead" }, db);

    const result = await execute({
      action: "enqueue_work",
      project_id: PROJECT,
      enqueue_task_id: task.id,
    });

    expect(result.ok).toBe(true);
    expect(result.autoTransitioned).toBe(false);

    const updatedTask = getTask(PROJECT, task.id, db);
    expect(updatedTask?.state).toBe("IN_PROGRESS");
  });

  it("returns error for non-existent task", async () => {
    const result = await execute({
      action: "enqueue_work",
      project_id: PROJECT,
      enqueue_task_id: "00000000-0000-0000-0000-000000000000",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });

  it("returns ok:false (already queued) when enqueuing the same ASSIGNED task twice", async () => {
    const task = createTask(
      { projectId: PROJECT, title: "Duplicate enqueue", createdBy: "agent:lead" },
      db,
    );

    // First enqueue — OPEN → ASSIGNED
    const first = await execute({
      action: "enqueue_work",
      project_id: PROJECT,
      enqueue_task_id: task.id,
    });
    expect(first.ok).toBe(true);

    // Second enqueue — should fail dedup check
    const second = await execute({
      action: "enqueue_work",
      project_id: PROJECT,
      enqueue_task_id: task.id,
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/non-terminal queue item/i);
  });
});
