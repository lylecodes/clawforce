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
const { ingestEvent, listEvents } = await import("../../src/events/store.js");
const { processEvents } = await import("../../src/events/router.js");
const { createTask, transitionTask, getTask } = await import("../../src/tasks/ops.js");
const { getQueueStatus } = await import("../../src/dispatch/queue.js");
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");

describe("auto-dispatch on task_assigned", () => {
  let db: DatabaseSync;
  const PROJECT = "auto-dispatch-test";

  beforeEach(() => {
    db = getMemoryDb();
    resetEnforcementConfigForTest();
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
    try { db.close(); } catch { /* already closed */ }
  });

  it("task_assigned event triggers auto-enqueue", () => {
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: { "worker-1": { role: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" } } },
    });

    // Create an ASSIGNED task (emits task_assigned event)
    const task = createTask({
      projectId: PROJECT,
      title: "Auto dispatch test",
      createdBy: "pm",
      assignedTo: "worker-1",
    }, db);

    // Process events — task_assigned should trigger auto-enqueue
    const processed = processEvents(PROJECT, db);
    expect(processed).toBeGreaterThan(0);

    // Check dispatch queue
    const queueStatus = getQueueStatus(PROJECT, db);
    expect(queueStatus.queued).toBeGreaterThanOrEqual(1);
  });

  it("transitionTask to ASSIGNED emits task_assigned event", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Transition test",
      createdBy: "pm",
    }, db);

    // Transition to ASSIGNED
    transitionTask({
      projectId: PROJECT,
      taskId: task.id,
      toState: "ASSIGNED",
      actor: "pm",
      assignedTo: "worker-1",
      verificationRequired: false,
    }, db);

    // Check events — should have task_created + task_assigned
    const events = listEvents(PROJECT, { status: "pending" }, db);
    const assignedEvents = events.filter((e) => e.type === "task_assigned");
    expect(assignedEvents.length).toBeGreaterThanOrEqual(1);
    expect(assignedEvents[0]!.payload.taskId).toBe(task.id);
  });

  it("createTask with assignedTo emits both task_created and task_assigned", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Dual event test",
      createdBy: "pm",
      assignedTo: "worker-1",
    }, db);

    const events = listEvents(PROJECT, { status: "pending" }, db);
    const createdEvents = events.filter((e) => e.type === "task_created");
    const assignedEvents = events.filter((e) => e.type === "task_assigned");

    expect(createdEvents.length).toBe(1);
    expect(assignedEvents.length).toBe(1);
    expect(createdEvents[0]!.payload.taskId).toBe(task.id);
    expect(assignedEvents[0]!.payload.taskId).toBe(task.id);
  });

  it("dedup prevents double-enqueue for same task", () => {
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: { "worker-1": { role: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" } } },
    });

    const task = createTask({
      projectId: PROJECT,
      title: "Dedup test",
      createdBy: "pm",
      assignedTo: "worker-1",
    }, db);

    // Process events (first pass)
    processEvents(PROJECT, db);

    // Ingest another task_assigned event for the same task
    ingestEvent(PROJECT, "task_assigned", "internal", {
      taskId: task.id,
      assignedTo: "worker-1",
      fromState: "OPEN",
    }, `task-assigned:${task.id}:duplicate`, db);

    processEvents(PROJECT, db);

    // Queue should still only have 1 item (dedup in enqueue)
    const queueStatus = getQueueStatus(PROJECT, db);
    // Non-terminal items for this task should be exactly 1
    const items = db.prepare(
      "SELECT * FROM dispatch_queue WHERE project_id = ? AND task_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')",
    ).all(PROJECT, task.id) as Record<string, unknown>[];
    expect(items.length).toBe(1);
  });

  it("auto-dispatch respects autoDispatchOnAssign: false config", () => {
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: { "worker-1": { role: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" } } },
      assignment: { enabled: true, strategy: "workload_balanced", autoDispatchOnAssign: false },
    });

    const task = createTask({
      projectId: PROJECT,
      title: "No auto-dispatch",
      createdBy: "pm",
      assignedTo: "worker-1",
    }, db);

    processEvents(PROJECT, db);

    // Queue should be empty — auto-dispatch was disabled
    const queueStatus = getQueueStatus(PROJECT, db);
    expect(queueStatus.queued).toBe(0);
  });

  it("task_created event for OPEN task does NOT auto-enqueue (no assignment config)", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Open task no dispatch",
      createdBy: "pm",
    }, db);

    processEvents(PROJECT, db);

    // No assignment config → task_created is handled but doesn't enqueue
    const queueStatus = getQueueStatus(PROJECT, db);
    expect(queueStatus.queued).toBe(0);
  });
});
