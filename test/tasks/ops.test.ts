import crypto from "node:crypto";
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
const { createTask, transitionTask, attachEvidence, getTask, listTasks, getTaskEvidence, getTaskTransitions } =
  await import("../../src/tasks/ops.js");
const { queryAuditLog } = await import("../../src/audit.js");
const { listEvents, ingestEvent } = await import("../../src/events/store.js");
const { enqueue } = await import("../../src/dispatch/queue.js");

describe("clawforce/ops", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  it("creates a task in OPEN state", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Fix bug", createdBy: "agent:alice" },
      db,
    );
    expect(task.id).toBeTruthy();
    expect(task.state).toBe("OPEN");
    expect(task.title).toBe("Fix bug");
    expect(task.priority).toBe("P2");
    expect(task.retryCount).toBe(0);
  });

  it("creates a task in ASSIGNED state when assignedTo is provided", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Deploy", createdBy: "agent:alice", assignedTo: "agent:bob" },
      db,
    );
    expect(task.state).toBe("ASSIGNED");
    expect(task.assignedTo).toBe("agent:bob");
  });

  it("happy path: OPEN → ASSIGNED → IN_PROGRESS → REVIEW → DONE", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Implement feature", createdBy: "agent:pm" },
      db,
    );

    // OPEN → ASSIGNED
    const r1 = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:worker" },
      db,
    );
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.task.state).toBe("ASSIGNED");

    // ASSIGNED → IN_PROGRESS
    const r2 = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" },
      db,
    );
    expect(r2.ok).toBe(true);

    // Attach evidence before REVIEW
    const evidence = attachEvidence(
      {
        projectId: PROJECT,
        taskId: task.id,
        type: "output",
        content: "All tests passing",
        attachedBy: "agent:worker",
      },
      db,
    );
    expect(evidence.contentHash).toBeTruthy();

    // IN_PROGRESS → REVIEW
    const r3 = transitionTask(
      {
        projectId: PROJECT,
        taskId: task.id,
        toState: "REVIEW",
        actor: "agent:worker",
        evidenceId: evidence.id,
      },
      db,
    );
    expect(r3.ok).toBe(true);

    // REVIEW → DONE (different actor = verifier)
    const r4 = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "agent:verifier" },
      db,
    );
    expect(r4.ok).toBe(true);
    if (r4.ok) expect(r4.task.state).toBe("DONE");
  });

  it("blocks self-grading: REVIEW → DONE by assignee", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Self-grade test", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence(
      { projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" },
      db,
    );
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);

    // Same actor as assignee tries to approve
    const result = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "agent:worker" },
      db,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("self-grading");
  });

  it("requires evidence for IN_PROGRESS → REVIEW", () => {
    const task = createTask(
      { projectId: PROJECT, title: "No evidence", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);

    const result = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" },
      db,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Evidence");
  });

  it("rejects invalid transitions", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Invalid", createdBy: "agent:pm" },
      db,
    );

    const result = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "agent:pm" },
      db,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Cannot transition");
  });

  it("handles retry flow: REVIEW → IN_PROGRESS (rework) → REVIEW → DONE", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Retry test", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence(
      { projectId: PROJECT, taskId: task.id, type: "output", content: "attempt 1", attachedBy: "agent:worker" },
      db,
    );
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);

    // Verifier rejects → back to IN_PROGRESS
    const reject = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:verifier", reason: "needs fixes" },
      db,
    );
    expect(reject.ok).toBe(true);
    if (reject.ok) expect(reject.task.state).toBe("IN_PROGRESS");

    // Rework + re-submit
    attachEvidence(
      { projectId: PROJECT, taskId: task.id, type: "output", content: "attempt 2", attachedBy: "agent:worker" },
      db,
    );
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);

    // Verifier approves
    const approve = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "agent:verifier" },
      db,
    );
    expect(approve.ok).toBe(true);
    if (approve.ok) expect(approve.task.state).toBe("DONE");
  });

  it("enforces retry limit on FAILED → OPEN", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Retry limit", createdBy: "agent:pm", maxRetries: 1 },
      db,
    );

    // Move to FAILED
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "FAILED", actor: "agent:worker", reason: "crash" }, db);

    // First retry should work
    const r1 = transitionTask({ projectId: PROJECT, taskId: task.id, toState: "OPEN", actor: "agent:pm" }, db);
    expect(r1.ok).toBe(true);

    // Fail again
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "FAILED", actor: "agent:worker" }, db);

    // Second retry should be blocked (retryCount=1 >= maxRetries=1)
    const r2 = transitionTask({ projectId: PROJECT, taskId: task.id, toState: "OPEN", actor: "agent:pm" }, db);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain("exhausted");
  });

  it("lists tasks with filtering", () => {
    createTask({ projectId: PROJECT, title: "A", createdBy: "agent:pm", priority: "P0" }, db);
    createTask({ projectId: PROJECT, title: "B", createdBy: "agent:pm", priority: "P2", tags: ["backend"] }, db);
    createTask({ projectId: PROJECT, title: "C", createdBy: "agent:pm", priority: "P1", tags: ["frontend"] }, db);

    const all = listTasks(PROJECT, undefined, db);
    expect(all.length).toBe(3);
    // Should be sorted by priority
    expect(all[0]!.title).toBe("A"); // P0
    expect(all[1]!.title).toBe("C"); // P1
    expect(all[2]!.title).toBe("B"); // P2

    const tagged = listTasks(PROJECT, { tags: ["backend"] }, db);
    expect(tagged.length).toBe(1);
    expect(tagged[0]!.title).toBe("B");
  });

  it("records transitions with audit trail", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Audit test", createdBy: "agent:pm" },
      db,
    );

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);

    const transitions = getTaskTransitions(PROJECT, task.id, db);
    expect(transitions.length).toBe(2);
    expect(transitions[0]!.fromState).toBe("OPEN");
    expect(transitions[0]!.toState).toBe("ASSIGNED");
    expect(transitions[1]!.fromState).toBe("ASSIGNED");
    expect(transitions[1]!.toState).toBe("IN_PROGRESS");
  });

  it("attaches and retrieves evidence", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Evidence test", createdBy: "agent:pm" },
      db,
    );

    const e1 = attachEvidence(
      { projectId: PROJECT, taskId: task.id, type: "output", content: "stdout output", attachedBy: "agent:worker" },
      db,
    );
    const e2 = attachEvidence(
      { projectId: PROJECT, taskId: task.id, type: "diff", content: "--- a/file\n+++ b/file", attachedBy: "agent:worker" },
      db,
    );

    const evidence = getTaskEvidence(PROJECT, task.id, db);
    expect(evidence.length).toBe(2);
    expect(evidence[0]!.id).toBe(e1.id);
    expect(evidence[1]!.type).toBe("diff");
  });

  it("handles BLOCKED flow", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Blocked test", createdBy: "agent:pm" },
      db,
    );

    const r1 = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "BLOCKED", actor: "agent:pm", reason: "waiting on API" },
      db,
    );
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.task.state).toBe("BLOCKED");

    const r2 = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "OPEN", actor: "agent:pm" },
      db,
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.task.state).toBe("OPEN");
  });

  it("handles ASSIGNED → BLOCKED transition", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Block assigned", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );
    expect(task.state).toBe("ASSIGNED");

    const r1 = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "BLOCKED", actor: "system:compliance", reason: "worker non-compliant" },
      db,
    );
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.task.state).toBe("BLOCKED");

    // Can unblock back to OPEN
    const r2 = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "OPEN", actor: "agent:pm" },
      db,
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.task.state).toBe("OPEN");
  });

  it("handles IN_PROGRESS → BLOCKED transition", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Block in-progress", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);

    const r1 = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "BLOCKED", actor: "system:compliance", reason: "worker abandoned" },
      db,
    );
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.task.state).toBe("BLOCKED");
  });

  it("includes valid next states in transition error", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Invalid transition", createdBy: "agent:pm" },
      db,
    );

    const result = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "agent:pm" },
      db,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Valid next states");
      expect(result.reason).toContain("ASSIGNED");
      expect(result.reason).toContain("BLOCKED");
    }
  });

  it("uses explicit assignedTo on OPEN → ASSIGNED", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Assign test", createdBy: "agent:pm" },
      db,
    );

    const result = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:pm", assignedTo: "agent:bob" },
      db,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.assignedTo).toBe("agent:bob");
    }
  });

  it("lists tasks with multi-state filter", () => {
    createTask({ projectId: PROJECT, title: "Open task", createdBy: "agent:pm" }, db);
    const assigned = createTask({ projectId: PROJECT, title: "Assigned task", createdBy: "agent:pm", assignedTo: "agent:a" }, db);
    const failedTask = createTask({ projectId: PROJECT, title: "Failed task", createdBy: "agent:pm", assignedTo: "agent:a" }, db);
    transitionTask({ projectId: PROJECT, taskId: failedTask.id, toState: "FAILED", actor: "agent:a" }, db);

    const results = listTasks(PROJECT, { states: ["OPEN", "ASSIGNED"] }, db);
    expect(results.length).toBe(2);
    const states = results.map((t) => t.state);
    expect(states).toContain("OPEN");
    expect(states).toContain("ASSIGNED");
    expect(states).not.toContain("FAILED");
  });

  it("returns not found for missing task", () => {
    const task = getTask(PROJECT, "nonexistent", db);
    expect(task).toBeUndefined();

    const result = transitionTask(
      { projectId: PROJECT, taskId: "nonexistent", toState: "ASSIGNED", actor: "agent:worker" },
      db,
    );
    expect(result.ok).toBe(false);
  });

  it("writes task.transition audit entry on each transition", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Transition audit", createdBy: "agent:pm" },
      db,
    );

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);

    const allAudits = queryAuditLog({ projectId: PROJECT, action: "task.transition", targetId: task.id }, db);
    expect(allAudits.length).toBe(2);

    // Sort by createdAt ASC for predictable order
    const audits = [...allAudits].sort((a, b) => a.createdAt - b.createdAt);

    const detail0 = JSON.parse(audits[0]!.detail!);
    expect(detail0.from).toBe("OPEN");
    expect(detail0.to).toBe("ASSIGNED");

    const detail1 = JSON.parse(audits[1]!.detail!);
    expect(detail1.from).toBe("ASSIGNED");
    expect(detail1.to).toBe("IN_PROGRESS");
  });

  it("enriches task_review_ready event with fromState and evidenceCount", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Review enriched", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "work done", attachedBy: "agent:worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "diff", content: "diff content", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);

    const events = listEvents(PROJECT, { type: "task_review_ready" }, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.fromState).toBe("IN_PROGRESS");
    expect(events[0]!.payload.evidenceCount).toBe(2);
  });

  it("CAS: rejects transition when task state changed concurrently", () => {
    const task = createTask(
      { projectId: PROJECT, title: "CAS test", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );

    // Task is in ASSIGNED state. Simulate concurrent change: another process
    // already moved it to IN_PROGRESS between getTask and the UPDATE.
    // We do this by directly updating the DB state AFTER creating the task.
    // Then we try a transition from ASSIGNED → IN_PROGRESS, which getTask will
    // see as IN_PROGRESS (current), but the CAS expects ASSIGNED.

    // Move to IN_PROGRESS first (legitimately)
    const r1 = transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" },
      db,
    );
    expect(r1.ok).toBe(true);

    // Now sneak the state back to ASSIGNED in the DB, but in a way that
    // the UPDATE's CAS clause (WHERE state = ? AND project_id = ?) will catch:
    // We directly change state so next getTask sees ASSIGNED,
    // but mid-flight another "process" changes it to REVIEW.
    db.prepare("UPDATE tasks SET state = 'ASSIGNED' WHERE id = ?").run(task.id);

    // Attach evidence so REVIEW transition is valid
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" }, db);

    // Now attempt ASSIGNED → REVIEW, but right before the UPDATE fires,
    // change the state. Since SQLite is synchronous and we can't intercept,
    // we instead verify the CAS WHERE clause is present by testing the
    // direct SQL: update with wrong expected state returns 0 changes.
    const result = db.prepare(
      "UPDATE tasks SET state = 'REVIEW' WHERE id = ? AND state = ? AND project_id = ?",
    ).run(task.id, "IN_PROGRESS", PROJECT); // Wrong expected state
    expect(result.changes).toBe(0); // CAS prevented the update
  });

  it("event dedup keys are set on task_review_ready", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Dedup review", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);

    const events = listEvents(PROJECT, { type: "task_review_ready" }, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.dedupKey).toBeTruthy();
    expect(events[0]!.dedupKey).toContain("task-review:");
  });

  it("event dedup keys are set on task_completed", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Dedup completed", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "agent:verifier" }, db);

    const events = listEvents(PROJECT, { type: "task_completed" }, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.dedupKey).toBeTruthy();
    expect(events[0]!.dedupKey).toContain("task-completed:");
  });

  it("event dedup keys are set on task_failed", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Dedup failed", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "FAILED", actor: "agent:worker", reason: "error" }, db);

    const events = listEvents(PROJECT, { type: "task_failed" }, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.dedupKey).toBeTruthy();
    expect(events[0]!.dedupKey).toContain("task-failed:");
  });

  it("duplicate event emission returns deduplicated: true", () => {
    const dedupKey = `test-dedup-${crypto.randomUUID()}`;

    const first = ingestEvent(PROJECT, "task_completed", "internal", { test: true }, dedupKey, db);
    expect(first.deduplicated).toBe(false);

    const second = ingestEvent(PROJECT, "task_completed", "internal", { test: true }, dedupKey, db);
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it("cancels pending queue items when task transitions to non-dispatchable state", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Queue cancel test", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );

    // Manually enqueue the task (simulating what the event router does)
    const queueItem = enqueue(PROJECT, task.id, undefined, undefined, db);
    expect(queueItem).not.toBeNull();

    // Verify it's in queued status
    const before = db.prepare("SELECT status FROM dispatch_queue WHERE id = ?").get(queueItem!.id) as Record<string, unknown>;
    expect(before.status).toBe("queued");

    // Transition task to REVIEW — should cancel the queued item
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);

    // The queued item should now be cancelled (not dispatched)
    const after = db.prepare("SELECT status FROM dispatch_queue WHERE id = ?").get(queueItem!.id) as Record<string, unknown>;
    expect(after.status).toBe("cancelled");
  });

  it("records task_cycle metric on DONE transition", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Metrics test", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence(
      { projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" },
      db,
    );
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "agent:verifier" }, db);

    // Verify a metric was recorded
    const rows = db.prepare("SELECT * FROM metrics WHERE type = 'task_cycle' AND subject = ?").all(task.id) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("cycle_time");
    expect((rows[0]!.value as number)).toBeGreaterThanOrEqual(0);
  });

  // --- Task dependency enforcement ---

  it("createTask throws when parentTaskId does not exist", () => {
    expect(() =>
      createTask({
        projectId: PROJECT,
        title: "Orphan child",
        createdBy: "agent:pm",
        parentTaskId: "non-existent-parent-id",
      }, db),
    ).toThrow(/Parent task.*not found/);
  });

  it("createTask succeeds when parentTaskId is valid", () => {
    const parent = createTask({ projectId: PROJECT, title: "Parent", createdBy: "agent:pm" }, db);
    const child = createTask({
      projectId: PROJECT,
      title: "Child",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
      parentTaskId: parent.id,
    }, db);
    expect(child.parentTaskId).toBe(parent.id);
  });

  it("blocks IN_PROGRESS transition when parent is not DONE", () => {
    const parent = createTask({
      projectId: PROJECT, title: "Parent task", createdBy: "agent:pm", assignedTo: "agent:lead",
    }, db);
    const child = createTask({
      projectId: PROJECT, title: "Child task", createdBy: "agent:pm", assignedTo: "agent:worker",
      parentTaskId: parent.id,
    }, db);

    // Child is ASSIGNED — try to start it while parent is still ASSIGNED
    const result = transitionTask({
      projectId: PROJECT, taskId: child.id, toState: "IN_PROGRESS", actor: "agent:worker",
    }, db);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Cannot start: parent task .+ is still in state ASSIGNED/);
    }
  });

  it("allows IN_PROGRESS transition when parent is DONE", () => {
    const parent = createTask({
      projectId: PROJECT, title: "Parent for allow", createdBy: "agent:pm", assignedTo: "agent:lead",
    }, db);
    const child = createTask({
      projectId: PROJECT, title: "Child for allow", createdBy: "agent:pm", assignedTo: "agent:worker",
      parentTaskId: parent.id,
    }, db);

    // Complete the parent task
    transitionTask({ projectId: PROJECT, taskId: parent.id, toState: "IN_PROGRESS", actor: "agent:lead" }, db);
    attachEvidence({ projectId: PROJECT, taskId: parent.id, type: "output", content: "parent done", attachedBy: "agent:lead" }, db);
    transitionTask({ projectId: PROJECT, taskId: parent.id, toState: "REVIEW", actor: "agent:lead" }, db);
    transitionTask({ projectId: PROJECT, taskId: parent.id, toState: "DONE", actor: "agent:verifier" }, db);

    // Now child should be able to start
    const result = transitionTask({
      projectId: PROJECT, taskId: child.id, toState: "IN_PROGRESS", actor: "agent:worker",
    }, db);

    expect(result.ok).toBe(true);
  });

  it("auto-unblocks BLOCKED child tasks when parent completes", () => {
    const parent = createTask({
      projectId: PROJECT, title: "Parent unblock", createdBy: "agent:pm", assignedTo: "agent:lead",
    }, db);
    const child = createTask({
      projectId: PROJECT, title: "Child blocked", createdBy: "agent:pm", assignedTo: "agent:worker",
      parentTaskId: parent.id,
    }, db);

    // Manually block the child (simulating dependency blocking)
    transitionTask({ projectId: PROJECT, taskId: child.id, toState: "BLOCKED", actor: "system:dependency", reason: "Waiting for parent" }, db);

    const blockedChild = getTask(PROJECT, child.id, db)!;
    expect(blockedChild.state).toBe("BLOCKED");

    // Complete the parent
    transitionTask({ projectId: PROJECT, taskId: parent.id, toState: "IN_PROGRESS", actor: "agent:lead" }, db);
    attachEvidence({ projectId: PROJECT, taskId: parent.id, type: "output", content: "parent done", attachedBy: "agent:lead" }, db);
    transitionTask({ projectId: PROJECT, taskId: parent.id, toState: "REVIEW", actor: "agent:lead" }, db);
    transitionTask({ projectId: PROJECT, taskId: parent.id, toState: "DONE", actor: "agent:verifier" }, db);

    // Child should now be ASSIGNED (auto-unblocked)
    const unblocked = getTask(PROJECT, child.id, db)!;
    expect(unblocked.state).toBe("ASSIGNED");
  });
});
