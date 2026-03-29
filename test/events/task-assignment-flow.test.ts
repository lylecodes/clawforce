/**
 * Tests for the canonical task assignment flow.
 *
 * The ONLY path from task creation to dispatch is:
 *   createTask() -> task_created event -> handleTaskCreated() -> task_assigned event -> handleTaskAssigned() -> enqueue
 *
 * These tests verify:
 * 1. Creating a task with assignedTo produces exactly ONE task_assigned event
 * 2. Creating an OPEN task with auto-assignment produces exactly one ASSIGNED transition
 * 3. reassignTask to same agent produces NO transition
 * 4. reassignTask to different agent produces exactly one ASSIGNED->ASSIGNED transition
 */

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
const { createTask, transitionTask, reassignTask, getTask } = await import("../../src/tasks/ops.js");
const { getQueueStatus } = await import("../../src/dispatch/queue.js");
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");

describe("canonical task assignment flow", () => {
  let db: DatabaseSync;
  const PROJECT = "task-assignment-flow-test";

  beforeEach(() => {
    db = getMemoryDb();
    resetEnforcementConfigForTest();

    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: {
        "worker-1": { extends: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" } },
        "worker-2": { extends: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" } },
      },
      assignment: { enabled: true, strategy: "workload_balanced" },
    });
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
    try { db.close(); } catch { /* already closed */ }
  });

  it("createTask with assignedTo produces exactly ONE task_assigned event after processing", () => {
    // Step 1: createTask emits ONLY task_created (not task_assigned)
    const task = createTask({
      projectId: PROJECT,
      title: "Assigned on creation",
      createdBy: "pm",
      assignedTo: "worker-1",
    }, db);

    // Before processing: only task_created should exist
    const preEvents = listEvents(PROJECT, { status: "pending" }, db);
    const preCreated = preEvents.filter((e) => e.type === "task_created");
    const preAssigned = preEvents.filter((e) => e.type === "task_assigned");
    expect(preCreated.length).toBe(1);
    expect(preAssigned.length).toBe(0);

    // Step 2: Process task_created -> handleTaskCreated emits task_assigned
    processEvents(PROJECT, db);

    // After processing: exactly ONE task_assigned should exist
    const postEvents = listEvents(PROJECT, {}, db);
    const postAssigned = postEvents.filter((e) => e.type === "task_assigned");
    expect(postAssigned.length).toBe(1);
    expect(postAssigned[0]!.payload.taskId).toBe(task.id);
    expect(postAssigned[0]!.payload.assignedTo).toBe("worker-1");

    // Step 3: Process task_assigned -> handleTaskAssigned enqueues for dispatch
    processEvents(PROJECT, db);

    // Exactly one queue item
    const items = db.prepare(
      "SELECT * FROM dispatch_queue WHERE project_id = ? AND task_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')",
    ).all(PROJECT, task.id) as Record<string, unknown>[];
    expect(items.length).toBe(1);
  });

  it("OPEN task with auto-assignment produces exactly one ASSIGNED transition", async () => {
    // Test auto-assignment by calling autoAssign directly (same as handleTaskCreated does).
    // We call it directly because the router uses require() for circular-dep avoidance,
    // which may not resolve in all test environments.
    const { autoAssign } = await import("../../src/assignment/engine.js");

    // Create OPEN task (no assignedTo)
    const task = createTask({
      projectId: PROJECT,
      title: "Auto-assign me",
      createdBy: "pm",
    }, db);

    expect(task.state).toBe("OPEN");

    // Simulate what handleTaskCreated does: call autoAssign for OPEN tasks
    const assignResult = autoAssign(PROJECT, task.id, { enabled: true, strategy: "workload_balanced" }, db);
    expect(assignResult.assigned).toBe(true);

    // Check: task is now ASSIGNED
    const updated = getTask(PROJECT, task.id, db);
    expect(updated!.state).toBe("ASSIGNED");

    // Check: exactly ONE task_assigned event exists (emitted by transitionTask inside autoAssign)
    const allEvents = listEvents(PROJECT, {}, db);
    const assignedEvents = allEvents.filter((e) => e.type === "task_assigned");
    expect(assignedEvents.length).toBe(1);
    expect(assignedEvents[0]!.payload.taskId).toBe(task.id);

    // Check transitions: exactly one OPEN -> ASSIGNED transition
    const transitions = db.prepare(
      "SELECT * FROM transitions WHERE task_id = ? AND to_state = 'ASSIGNED'",
    ).all(task.id) as Record<string, unknown>[];
    expect(transitions.length).toBe(1);
    expect(transitions[0]!.from_state).toBe("OPEN");
  });

  it("reassignTask to same agent produces NO transition and no event", () => {
    // Create an ASSIGNED task
    const task = createTask({
      projectId: PROJECT,
      title: "Same-agent reassign",
      createdBy: "pm",
      assignedTo: "worker-1",
    }, db);

    // Drain all existing events
    processEvents(PROJECT, db);
    processEvents(PROJECT, db);

    // Count events/transitions before reassignment attempt
    const eventsBefore = listEvents(PROJECT, {}, db);
    const transitionsBefore = db.prepare(
      "SELECT COUNT(*) as count FROM transitions WHERE task_id = ?",
    ).get(task.id) as Record<string, unknown>;

    // Attempt reassignment to SAME agent
    const result = reassignTask({
      projectId: PROJECT,
      taskId: task.id,
      newAssignee: "worker-1",
      actor: "pm",
    }, db);

    // Should succeed (no-op) but produce no transition or event
    expect(result.ok).toBe(true);

    // No new events should have been created
    const eventsAfter = listEvents(PROJECT, {}, db);
    const newAssignedEvents = eventsAfter.filter(
      (e) => e.type === "task_assigned" && !eventsBefore.some((eb) => eb.id === e.id),
    );
    expect(newAssignedEvents.length).toBe(0);

    // No new transitions
    const transitionsAfter = db.prepare(
      "SELECT COUNT(*) as count FROM transitions WHERE task_id = ?",
    ).get(task.id) as Record<string, unknown>;
    expect(transitionsAfter.count).toBe(transitionsBefore.count);
  });

  it("reassignTask to different agent produces exactly one ASSIGNED->ASSIGNED transition", () => {
    // Create an ASSIGNED task
    const task = createTask({
      projectId: PROJECT,
      title: "Different-agent reassign",
      createdBy: "pm",
      assignedTo: "worker-1",
    }, db);

    // Drain all existing events
    processEvents(PROJECT, db);
    processEvents(PROJECT, db);

    // Count events before reassignment
    const eventsBefore = listEvents(PROJECT, {}, db);

    // Reassign to different agent
    const result = reassignTask({
      projectId: PROJECT,
      taskId: task.id,
      newAssignee: "worker-2",
      actor: "pm",
    }, db);

    expect(result.ok).toBe(true);
    expect(result.task!.assignedTo).toBe("worker-2");

    // Exactly one ASSIGNED->ASSIGNED transition
    const reassignTransitions = db.prepare(
      "SELECT * FROM transitions WHERE task_id = ? AND from_state = 'ASSIGNED' AND to_state = 'ASSIGNED'",
    ).all(task.id) as Record<string, unknown>[];
    expect(reassignTransitions.length).toBe(1);

    // Exactly one NEW task_assigned event from the reassignment
    const eventsAfter = listEvents(PROJECT, {}, db);
    const newAssignedEvents = eventsAfter.filter(
      (e) => e.type === "task_assigned" && !eventsBefore.some((eb) => eb.id === e.id),
    );
    expect(newAssignedEvents.length).toBe(1);
    expect(newAssignedEvents[0]!.payload.assignedTo).toBe("worker-2");
    expect(newAssignedEvents[0]!.payload.fromState).toBe("ASSIGNED");
  });

  it("no duplicate dispatch queue items across the full canonical flow", () => {
    // Create task with assignee -> process all events -> verify single queue item
    const task = createTask({
      projectId: PROJECT,
      title: "No duplicate dispatch",
      createdBy: "pm",
      assignedTo: "worker-1",
    }, db);

    // Process events until quiescent (all events handled)
    let processed = 1;
    let iterations = 0;
    while (processed > 0 && iterations < 10) {
      processed = processEvents(PROJECT, db);
      iterations++;
    }

    // Verify exactly one non-terminal queue item
    const items = db.prepare(
      "SELECT * FROM dispatch_queue WHERE project_id = ? AND task_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')",
    ).all(PROJECT, task.id) as Record<string, unknown>[];
    expect(items.length).toBe(1);
  });
});
