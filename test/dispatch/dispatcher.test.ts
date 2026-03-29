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

// Mock the inject-dispatch module to avoid actually starting agent sessions
const mockDispatchViaInject = vi.fn();
vi.mock("../../src/dispatch/inject-dispatch.js", () => ({
  dispatchViaInject: mockDispatchViaInject,
}));

// Mock spawn module — only buildTaskPrompt is used now
vi.mock("../../src/dispatch/spawn.js", () => ({
  buildTaskPrompt: vi.fn((_task: unknown, prompt: string) => prompt),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createTask, transitionTask, attachEvidence, getTask } = await import("../../src/tasks/ops.js");
const { enqueue, getQueueStatus } = await import("../../src/dispatch/queue.js");
const { dispatchLoop, resetDispatcherForTest, getConcurrencyInfo, buildRetryContext } = await import("../../src/dispatch/dispatcher.js");
const { listEvents } = await import("../../src/events/store.js");
const { queryMetrics } = await import("../../src/metrics.js");
const { queryAuditLog } = await import("../../src/audit.js");

describe("dispatch/dispatcher", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
    resetDispatcherForTest();
    mockDispatchViaInject.mockReset();
    // Default: successful cron job creation
    mockDispatchViaInject.mockResolvedValue({ ok: true, sessionKey: "agent:test:dispatch:test" });
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("dispatches a queued item for an ASSIGNED task via cron", async () => {
    const task = createTask({
      projectId: PROJECT, title: "Test", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);

    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(1);

    // Successful dispatch marks item as "dispatched" (not completed — that happens in agent_end)
    const status = getQueueStatus(PROJECT, db);
    expect(status.queued).toBe(0);
    // "dispatched" is not in the status summary keys, check via raw query
    const dispatchedRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? AND status = 'dispatched'",
    ).get(PROJECT) as Record<string, unknown>;
    expect(dispatchedRow.cnt).toBe(1);
  });

  it("dispatches queued items when task state is lowercase assigned", async () => {
    const task = createTask({
      projectId: PROJECT, title: "Legacy assigned task", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);

    db.prepare("UPDATE tasks SET state = 'assigned' WHERE id = ? AND project_id = ?").run(task.id, PROJECT);
    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(1);

    const dispatchedRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? AND status = 'dispatched'",
    ).get(PROJECT) as Record<string, unknown>;
    expect(dispatchedRow.cnt).toBe(1);
  });

  it("fails items for tasks in non-dispatchable states", async () => {
    const task = createTask({ projectId: PROJECT, title: "Open task", createdBy: "agent:pm" }, db);
    // Task is OPEN — not dispatchable

    enqueue(PROJECT, task.id, undefined, undefined, db);

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(1);

    const status = getQueueStatus(PROJECT, db);
    expect(status.failed).toBe(1);
  });

  it("reports concurrency info", () => {
    const info = getConcurrencyInfo();
    expect(info.active).toBe(0);
    expect(info.max).toBe(3);
  });

  it("returns 0 when queue is empty", async () => {
    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(0);
  });

  // --- Dispatch events ---

  it("emits dispatch_succeeded event on successful cron creation", async () => {
    const task = createTask({
      projectId: PROJECT, title: "Success task", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);

    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);
    await dispatchLoop(PROJECT, db);

    const events = listEvents(PROJECT, { type: "dispatch_succeeded" }, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.taskId).toBe(task.id);
    expect(events[0]!.payload.sessionKey).toBe("agent:test:dispatch:test");
  });

  it("emits dispatch_failed event when task is in non-dispatchable state", async () => {
    const task = createTask({ projectId: PROJECT, title: "Open task", createdBy: "agent:pm" }, db);
    enqueue(PROJECT, task.id, undefined, undefined, db);

    await dispatchLoop(PROJECT, db);

    const events = listEvents(PROJECT, { type: "dispatch_failed" }, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.taskId).toBe(task.id);
    expect(events[0]!.payload.error).toContain("non-dispatchable state");
  });

  it("releases item to queued when cron service is unavailable (transient)", async () => {
    mockDispatchViaInject.mockResolvedValue({
      ok: false, error: "Cron service not available (bootstrap may still be in progress)",
    });

    const task = createTask({
      projectId: PROJECT, title: "Fail task", createdBy: "agent:pm", assignedTo: "agent:worker",
      description: "Test task. Acceptance criteria: item is dispatched.",
    }, db);
    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);

    await dispatchLoop(PROJECT, db);

    // Item should be released back to queued, NOT failed
    const status = getQueueStatus(PROJECT, db);
    expect(status.queued).toBe(1);
    expect(status.failed).toBe(0);

    // No dispatch_failed event should be emitted for transient cron errors
    const events = listEvents(PROJECT, { type: "dispatch_failed" }, db);
    expect(events).toHaveLength(0);
  });

  it("emits dispatch_failed event when dispatch fails with non-cron error", async () => {
    mockDispatchViaInject.mockResolvedValue({
      ok: false, error: "Agent session spawn failed",
    });

    const task = createTask({
      projectId: PROJECT, title: "Fail task", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);
    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);

    await dispatchLoop(PROJECT, db);

    const events = listEvents(PROJECT, { type: "dispatch_failed" }, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.error).toBe("Agent session spawn failed");
  });

  // --- Dead letter emission from dispatcher ---

  it("emits dispatch_dead_letter when item exhausts max attempts", async () => {
    mockDispatchViaInject.mockResolvedValue({ ok: false, error: "cron error" });

    const task = createTask({
      projectId: PROJECT, title: "Doomed task", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);
    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);

    // Dispatch 3 times (max_dispatch_attempts = 3) — claim increments attempts
    for (let i = 0; i < 3; i++) {
      await dispatchLoop(PROJECT, db);
      // After failure, the item is marked failed. Re-enqueue for next attempt (except last).
      if (i < 2) {
        enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);
      }
    }

    const failedEvents = listEvents(PROJECT, { type: "dispatch_failed" }, db);
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
  });

  // --- Retry context ---

  it("builds retry context from previous FAILED transitions", () => {
    const task = createTask({
      projectId: PROJECT, title: "Retry task", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);

    // Transition through a failure cycle
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "Error: something went wrong", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "FAILED", actor: "agent:worker", reason: "Tests failed" }, db);

    const ctx = buildRetryContext(PROJECT, task.id, db);
    expect(ctx).not.toBeNull();
    expect(ctx).toContain("Previous Attempt Context");
    expect(ctx).toContain("Tests failed");
    expect(ctx).toContain("Error: something went wrong");
    expect(ctx).toContain("avoid repeating the same mistakes");
  });

  it("returns null retry context when no FAILED transitions exist", () => {
    const task = createTask({
      projectId: PROJECT, title: "Fresh task", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);

    const ctx = buildRetryContext(PROJECT, task.id, db);
    expect(ctx).toBeNull();
  });

  // --- Dispatch outcome metrics ---

  it("records dispatch_injected metric on successful dispatch", async () => {
    const task = createTask({
      projectId: PROJECT, title: "Success metric", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);
    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);
    await dispatchLoop(PROJECT, db);

    const metrics = queryMetrics({ projectId: PROJECT, key: "dispatch_injected" }, db);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.subject).toBe(task.id);
  });

  it("records dispatch_failure metric with reason on non-dispatchable state", async () => {
    const task = createTask({ projectId: PROJECT, title: "Open task fail", createdBy: "agent:pm" }, db);
    enqueue(PROJECT, task.id, undefined, undefined, db);
    await dispatchLoop(PROJECT, db);

    const metrics = queryMetrics({ projectId: PROJECT, key: "dispatch_failure" }, db);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.tags).toMatchObject({ reason: "non_dispatchable_state" });
  });

  it("records dispatch_dead_letter metric and audit on dead letter", async () => {
    mockDispatchViaInject.mockResolvedValue({ ok: false, error: "fatal error" });

    // Use a single-attempt queue item to trigger dead letter on first failure
    const task = createTask({
      projectId: PROJECT, title: "Dead letter metric", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);
    // Insert directly with max_dispatch_attempts=1
    const itemId = "dl-item-id";
    db.prepare(`
      INSERT INTO dispatch_queue (id, project_id, task_id, priority, status, dispatch_attempts, max_dispatch_attempts, created_at)
      VALUES (?, ?, ?, 2, 'queued', 0, 1, ?)
    `).run(itemId, PROJECT, task.id, Date.now());

    await dispatchLoop(PROJECT, db);

    const dlMetrics = queryMetrics({ projectId: PROJECT, key: "dispatch_dead_letter" }, db);
    expect(dlMetrics).toHaveLength(1);

    const audits = queryAuditLog({ projectId: PROJECT, action: "dispatch.dead_letter" }, db);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.targetId).toBe(task.id);
  });

  it("records dispatch_loop_pass metric after dispatching items", async () => {
    const task = createTask({
      projectId: PROJECT, title: "Loop metric", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);
    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);
    await dispatchLoop(PROJECT, db);

    const metrics = queryMetrics({ projectId: PROJECT, key: "dispatch_loop_pass" }, db);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.value).toBe(1);
    expect(metrics[0]!.subject).toBe(PROJECT);
  });

  it("enriches dispatch events with attempt and maxAttempts", async () => {
    const task = createTask({
      projectId: PROJECT, title: "Enriched event", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);
    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);
    await dispatchLoop(PROJECT, db);

    const events = listEvents(PROJECT, { type: "dispatch_succeeded" }, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.attempt).toBe(1);
    expect(events[0]!.payload.maxAttempts).toBe(3);
  });

  it("records queue.dispatched audit entry on successful dispatch", async () => {
    const task = createTask({
      projectId: PROJECT, title: "Audit task", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);
    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);
    await dispatchLoop(PROJECT, db);

    const dispatchedAudits = queryAuditLog({ projectId: PROJECT, action: "queue.dispatched" }, db);
    expect(dispatchedAudits).toHaveLength(1);
  });

  it("does NOT release task lease on successful dispatch (lease lives until agent_end)", async () => {
    const task = createTask({
      projectId: PROJECT, title: "Lease task", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);
    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);
    await dispatchLoop(PROJECT, db);

    // Lease should still be held (released by agent_end hook, not dispatcher)
    const taskRow = db.prepare("SELECT lease_holder FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown> | undefined;
    expect(taskRow!.lease_holder).toBeTruthy();
    expect((taskRow!.lease_holder as string)).toContain("dispatch:");
  });

  // --- Dispatch event dedup keys ---

  it("dispatch events have non-null dedup keys", async () => {
    const task = createTask({
      projectId: PROJECT, title: "Dedup event", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);
    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);
    await dispatchLoop(PROJECT, db);

    const events = listEvents(PROJECT, { type: "dispatch_succeeded" }, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.dedupKey).toBeTruthy();
    expect(events[0]!.dedupKey).toContain("dispatch_succeeded:");
  });

  it("includes retry context in dispatch prompt when task has failed before", async () => {
    const task = createTask({
      projectId: PROJECT, title: "Retry dispatch", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);

    // Create a failure history
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "Build failed", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "FAILED", actor: "agent:worker", reason: "Build error" }, db);
    // Re-open and re-assign for retry
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "OPEN", actor: "agent:pm" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:pm", assignedTo: "agent:worker" }, db);

    // Capture the prompt passed to dispatchViaCron
    let capturedPrompt = "";
    mockDispatchViaInject.mockImplementation(async (opts: { prompt: string }) => {
      capturedPrompt = opts.prompt;
      return { ok: true, sessionKey: "agent:test:dispatch:retry" };
    });

    enqueue(PROJECT, task.id, { prompt: "fix the build" }, undefined, db);
    await dispatchLoop(PROJECT, db);

    expect(capturedPrompt).toContain("Previous Attempt Context");
    expect(capturedPrompt).toContain("Build error");
  });

  it("releases task lease when cron creation fails", async () => {
    mockDispatchViaInject.mockResolvedValue({ ok: false, error: "service down" });

    const task = createTask({
      projectId: PROJECT, title: "Lease release", createdBy: "agent:pm", assignedTo: "agent:worker",
    }, db);
    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);
    await dispatchLoop(PROJECT, db);

    // Lease should be released on failure
    const taskRow = db.prepare("SELECT lease_holder FROM tasks WHERE id = ?")
      .get(task.id) as Record<string, unknown> | undefined;
    expect(taskRow!.lease_holder).toBeNull();
  });
});
