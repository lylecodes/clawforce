import type { DatabaseSync } from "../../src/sqlite-driver.js";
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
const { createTask } = await import("../../src/tasks/ops.js");
const { enqueue, claimNext, reclaimExpiredLeases, completeItem, failItem, cancelItem, getQueueStatus, markDispatched, retryFailedItem, releaseActiveItem, STALE_DISPATCHED_MS } =
  await import("../../src/dispatch/queue.js");
const projectModule = await import("../../src/project.js");
const { listEvents } = await import("../../src/events/store.js");
const { queryMetrics } = await import("../../src/metrics.js");
const { queryAuditLog } = await import("../../src/audit.js");

describe("dispatch/queue", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("enqueues a task", () => {
    const task = createTask({ projectId: PROJECT, title: "Task 1", createdBy: "agent:pm" }, db);
    const item = enqueue(PROJECT, task.id, { prompt: "do it" }, 1, db);

    expect(item).not.toBeNull();
    expect(item!.taskId).toBe(task.id);
    expect(item!.priority).toBe(1);
    expect(item!.status).toBe("queued");
    expect(item!.payload).toEqual({ prompt: "do it" });
  });

  it("derives queue priority from reactive and recurring task metadata when not overridden", () => {
    const reactiveTask = createTask({
      projectId: PROJECT,
      title: "Reactive issue task",
      createdBy: "system:test",
      assignedTo: "agent:owner",
      priority: "P2",
      origin: "reactive",
      originId: "issue-123",
    }, db);
    const recurringTask = createTask({
      projectId: PROJECT,
      title: "Recurring sweep task",
      createdBy: "system:test",
      assignedTo: "agent:owner",
      priority: "P2",
      origin: "reactive",
      metadata: {
        recurringJob: {
          agentId: "agent:owner",
          jobName: "sweep",
          schedule: "*/15 * * * *",
          reason: "dogfood",
          scheduledAt: Date.now(),
        },
      },
    }, db);

    const reactiveItem = enqueue(PROJECT, reactiveTask.id, undefined, undefined, db)!;
    const recurringItem = enqueue(PROJECT, recurringTask.id, undefined, undefined, db)!;

    expect(reactiveItem.priority).toBe(1);
    expect(recurringItem.priority).toBe(3);
  });

  it("deduplicates on taskId", () => {
    const task = createTask({ projectId: PROJECT, title: "Task 1", createdBy: "agent:pm" }, db);
    const item1 = enqueue(PROJECT, task.id, undefined, undefined, db);
    const item2 = enqueue(PROJECT, task.id, undefined, undefined, db);

    expect(item1).not.toBeNull();
    expect(item2).toBeNull();
  });

  it("allows re-enqueue after terminal status", () => {
    const task = createTask({ projectId: PROJECT, title: "Task 1", createdBy: "agent:pm" }, db);
    const item1 = enqueue(PROJECT, task.id, undefined, undefined, db)!;
    completeItem(item1.id, db);

    const item2 = enqueue(PROJECT, task.id, undefined, undefined, db);
    expect(item2).not.toBeNull();
    expect(item2!.id).not.toBe(item1.id);
  });

  it("claims next by priority then FIFO", () => {
    const t1 = createTask({ projectId: PROJECT, title: "Low priority", createdBy: "agent:pm" }, db);
    const t2 = createTask({ projectId: PROJECT, title: "High priority", createdBy: "agent:pm" }, db);
    const t3 = createTask({ projectId: PROJECT, title: "Medium priority", createdBy: "agent:pm" }, db);

    enqueue(PROJECT, t1.id, undefined, 3, db); // P3
    enqueue(PROJECT, t2.id, undefined, 0, db); // P0
    enqueue(PROJECT, t3.id, undefined, 1, db); // P1

    const claimed1 = claimNext(PROJECT, undefined, "agent:1", db);
    expect(claimed1!.taskId).toBe(t2.id); // P0 first
    expect(claimed1!.status).toBe("leased");

    const claimed2 = claimNext(PROJECT, undefined, "agent:2", db);
    expect(claimed2!.taskId).toBe(t3.id); // P1 second

    const claimed3 = claimNext(PROJECT, undefined, "agent:3", db);
    expect(claimed3!.taskId).toBe(t1.id); // P3 last
  });

  it("claims issue-driven reactive work ahead of recurring maintenance when both use derived priorities", () => {
    const recurringTask = createTask({
      projectId: PROJECT,
      title: "Recurring sweep",
      createdBy: "system:test",
      assignedTo: "agent:owner",
      priority: "P2",
      origin: "reactive",
      metadata: {
        recurringJob: {
          agentId: "agent:owner",
          jobName: "integrity-sweep",
          schedule: "*/30 * * * *",
          reason: "cron due",
          scheduledAt: Date.now(),
        },
      },
    }, db);
    const reactiveTask = createTask({
      projectId: PROJECT,
      title: "Open onboarding for Stockton",
      createdBy: "system:test",
      assignedTo: "data-director",
      priority: "P2",
      origin: "reactive",
      originId: "issue-stockton",
    }, db);

    enqueue(PROJECT, recurringTask.id, undefined, undefined, db);
    enqueue(PROJECT, reactiveTask.id, undefined, undefined, db);

    const claimed1 = claimNext(PROJECT, undefined, "agent:1", db);
    const claimed2 = claimNext(PROJECT, undefined, "agent:2", db);

    expect(claimed1?.taskId).toBe(reactiveTask.id);
    expect(claimed2?.taskId).toBe(recurringTask.id);
  });

  it("returns null when queue is empty", () => {
    const claimed = claimNext(PROJECT, undefined, undefined, db);
    expect(claimed).toBeNull();
  });

  it("sets lease expiration on claim", () => {
    const task = createTask({ projectId: PROJECT, title: "Task", createdBy: "agent:pm" }, db);
    enqueue(PROJECT, task.id, undefined, undefined, db);

    const claimed = claimNext(PROJECT, 60000, "holder", db)!;
    expect(claimed.leasedBy).toBe("holder");
    expect(claimed.leaseExpiresAt).toBeGreaterThan(Date.now());
    expect(claimed.dispatchAttempts).toBe(1);
  });

  it("reclaims expired leases", () => {
    const task = createTask({ projectId: PROJECT, title: "Task", createdBy: "agent:pm" }, db);
    enqueue(PROJECT, task.id, undefined, undefined, db);

    // Claim with a very short lease (already expired)
    const claimed = claimNext(PROJECT, -1000, "holder", db)!;
    expect(claimed.status).toBe("leased");

    // Reclaim should reset to queued
    const reclaimed = reclaimExpiredLeases(PROJECT, db);
    expect(reclaimed).toBe(1);

    // Should be claimable again
    const reClaimed = claimNext(PROJECT, undefined, "holder2", db);
    expect(reClaimed).not.toBeNull();
    expect(reClaimed!.dispatchAttempts).toBe(2);
  });

  it("fails items after max dispatch attempts", () => {
    const task = createTask({ projectId: PROJECT, title: "Task", createdBy: "agent:pm" }, db);
    enqueue(PROJECT, task.id, undefined, undefined, db);

    // Claim 3 times (max_dispatch_attempts = 3) with expired leases
    for (let i = 0; i < 3; i++) {
      claimNext(PROJECT, -1000, "holder", db);
      reclaimExpiredLeases(PROJECT, db);
    }

    // After 3 attempts, the last reclaim should fail the item
    const status = getQueueStatus(PROJECT, db);
    expect(status.failed).toBe(1);
    expect(status.queued).toBe(0);
  });

  it("completes a queue item", () => {
    const task = createTask({ projectId: PROJECT, title: "Task", createdBy: "agent:pm" }, db);
    const item = enqueue(PROJECT, task.id, undefined, undefined, db)!;

    completeItem(item.id, db);

    const status = getQueueStatus(PROJECT, db);
    expect(status.completed).toBe(1);
    expect(status.queued).toBe(0);
  });

  it("fails a queue item with error", () => {
    const task = createTask({ projectId: PROJECT, title: "Task", createdBy: "agent:pm" }, db);
    const item = enqueue(PROJECT, task.id, undefined, undefined, db)!;

    failItem(item.id, "Something went wrong", db);

    const status = getQueueStatus(PROJECT, db);
    expect(status.failed).toBe(1);
    expect(status.recentItems[0]!.lastError).toBe("Something went wrong");
  });

  it("requeues a failed item when the task is still dispatchable", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Retry me",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
      description: "Acceptance criteria: task is retried cleanly.",
    }, db);
    const failed = enqueue(PROJECT, task.id, { prompt: "retry this" }, 1, db)!;
    failItem(failed.id, "Task remained in ASSIGNED after inline dispatch", db);

    const retried = retryFailedItem(PROJECT, {
      taskId: task.id,
      actor: "operator:test",
    }, db);

    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.previousItem.id).toBe(failed.id);
    expect(retried.queueItem.taskId).toBe(task.id);
    expect(retried.queueItem.status).toBe("queued");
    expect(retried.queueItem.payload).toEqual({ prompt: "retry this" });
  });

  it("refreshes retry payload model from the current assignee config", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Retry with refreshed model",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
      description: "Acceptance criteria: retry uses the current configured model.",
    }, db);
    const failed = enqueue(PROJECT, task.id, { prompt: "retry this", model: "openai-codex/gpt-4.1" }, 1, db)!;
    failItem(failed.id, "Dispatch used an unsupported model", db);

    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
      agentId: "agent:worker",
      config: {
        model: "gpt-5.4-mini",
      },
    } as any);

    const retried = retryFailedItem(PROJECT, {
      taskId: task.id,
      actor: "operator:test",
    }, db);

    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.queueItem.payload).toEqual({ prompt: "retry this", model: "gpt-5.4-mini" });
  });

  it("normalizes model objects in queue payloads to primary strings", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Normalize model payload",
      createdBy: "agent:pm",
    }, db);

    const item = enqueue(PROJECT, task.id, {
      model: {
        primary: "openai-codex/gpt-5.4",
        fallbacks: ["openai-codex/gpt-4.1"],
      },
    }, 1, db)!;

    expect(item.payload).toEqual({ model: "openai-codex/gpt-5.4" });
  });

  it("replays blocked recurring runs through queue retry", () => {
    const recurringTask = createTask({
      projectId: PROJECT,
      title: "Run recurring workflow worker.intake-triage",
      createdBy: "system:recurring-job",
      assignedTo: "worker",
      description: "## Acceptance Criteria\n- recover the recurring run cleanly.",
      metadata: {
        recurringJob: {
          agentId: "worker",
          jobName: "intake-triage",
          schedule: "*/20 * * * *",
          reason: "never run before",
          scheduledAt: Date.now(),
        },
      },
      tags: ["recurring-job", "agent:worker", "job:intake-triage"],
      kind: "infra",
      origin: "reactive",
    }, db);
    const failed = enqueue(PROJECT, recurringTask.id, { prompt: "retry this" }, 1, db)!;
    failItem(failed.id, "Dispatch retries exhausted", db);
    db.prepare("UPDATE tasks SET state = 'BLOCKED', updated_at = ? WHERE id = ? AND project_id = ?")
      .run(Date.now(), recurringTask.id, PROJECT);

    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
      agentId: "worker",
      config: {
        briefing: [],
        model: "gpt-5.4",
        jobs: {
          "intake-triage": {
            cron: "*/20 * * * *",
            nudge: "Review blocked recurring work.",
          },
        },
      },
    } as any);

    const retried = retryFailedItem(PROJECT, { taskId: recurringTask.id }, db);

    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.queueItem.taskId).not.toBe(recurringTask.id);
    expect(retried.queueItem.payload).toEqual({
      prompt: "retry this",
      model: "gpt-5.4",
      jobName: "intake-triage",
    });
    const cancelled = db.prepare("SELECT state FROM tasks WHERE id = ?").get(recurringTask.id) as { state: string };
    expect(cancelled.state).toBe("CANCELLED");
    const replayed = db.prepare("SELECT metadata FROM tasks WHERE id = ?").get(retried.queueItem.taskId) as { metadata: string };
    const metadata = JSON.parse(replayed.metadata) as Record<string, unknown>;
    expect(metadata.replayOfTaskId).toBe(recurringTask.id);
  });

  it("surfaces the recurring replay failure reason when config is missing", () => {
    const recurringTask = createTask({
      projectId: PROJECT,
      title: "Run recurring workflow worker.intake-triage",
      createdBy: "system:recurring-job",
      assignedTo: "worker",
      description: "## Acceptance Criteria\n- recover the recurring run cleanly.",
      metadata: {
        recurringJob: {
          agentId: "worker",
          jobName: "intake-triage",
          schedule: "*/20 * * * *",
          reason: "never run before",
          scheduledAt: Date.now(),
        },
      },
      tags: ["recurring-job", "agent:worker", "job:intake-triage"],
      kind: "infra",
      origin: "reactive",
    }, db);
    const failed = enqueue(PROJECT, recurringTask.id, { prompt: "retry this" }, 1, db)!;
    failItem(failed.id, "Dispatch retries exhausted", db);
    db.prepare("UPDATE tasks SET state = 'BLOCKED', updated_at = ? WHERE id = ? AND project_id = ?")
      .run(Date.now(), recurringTask.id, PROJECT);

    vi.spyOn(projectModule, "getAgentConfig").mockReturnValue(undefined);

    const retried = retryFailedItem(PROJECT, { taskId: recurringTask.id }, db);

    expect(retried.ok).toBe(false);
    expect(retried.reason).toContain("is no longer configured");
  });

  it("refuses to requeue a failed item when the task is no longer dispatchable", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Do not retry",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
      description: "Acceptance criteria: task closes.",
    }, db);
    const failed = enqueue(PROJECT, task.id, { prompt: "retry this" }, 1, db)!;
    failItem(failed.id, "Task remained in ASSIGNED after inline dispatch", db);
    db.prepare("UPDATE tasks SET state = 'BLOCKED', updated_at = ? WHERE id = ? AND project_id = ?")
      .run(Date.now(), task.id, PROJECT);

    const retried = retryFailedItem(PROJECT, { taskId: task.id }, db);

    expect(retried.ok).toBe(false);
    expect(retried.reason).toContain("not a recurring workflow run");
  });

  it("releases an active leased item back to queued", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Release me",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
      description: "Acceptance criteria: task can be redispatched.",
    }, db);
    enqueue(PROJECT, task.id, { prompt: "release this" }, 1, db);
    const leased = claimNext(PROJECT, undefined, "dispatcher:test", db)!;

    const released = releaseActiveItem(PROJECT, {
      taskId: task.id,
      actor: "operator:test",
      reason: "Restart controller under new build",
    }, db);

    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.previousItem.id).toBe(leased.id);
    expect(released.previousItem.status).toBe("leased");
    expect(released.queueItem.id).toBe(leased.id);
    expect(released.queueItem.status).toBe("queued");
    expect(released.queueItem.dispatchAttempts).toBe(1);
  });

  it("cancels a queue item", () => {
    const task = createTask({ projectId: PROJECT, title: "Task", createdBy: "agent:pm" }, db);
    const item = enqueue(PROJECT, task.id, undefined, undefined, db)!;

    cancelItem(item.id, db);

    const status = getQueueStatus(PROJECT, db);
    expect(status.cancelled).toBe(1);
  });

  it("returns correct queue status", () => {
    const t1 = createTask({ projectId: PROJECT, title: "T1", createdBy: "agent:pm" }, db);
    const t2 = createTask({ projectId: PROJECT, title: "T2", createdBy: "agent:pm" }, db);
    const t3 = createTask({ projectId: PROJECT, title: "T3", createdBy: "agent:pm" }, db);

    enqueue(PROJECT, t1.id, undefined, undefined, db);
    const item2 = enqueue(PROJECT, t2.id, undefined, undefined, db)!;
    enqueue(PROJECT, t3.id, undefined, undefined, db);

    claimNext(PROJECT, undefined, "agent:1", db); // leases t1
    completeItem(item2.id, db);

    const status = getQueueStatus(PROJECT, db);
    expect(status.queued).toBe(1);  // t3
    expect(status.leased).toBe(1);  // t1
    expect(status.completed).toBe(1); // t2
    expect(status.recentItems).toHaveLength(3);
  });

  // --- Dead letter emission from reclaimExpiredLeases ---

  it("emits dispatch_dead_letter event when item exhausts attempts via lease expiry", () => {
    const task = createTask({ projectId: PROJECT, title: "Dead letter task", createdBy: "agent:pm" }, db);
    enqueue(PROJECT, task.id, undefined, undefined, db);

    // Exhaust all 3 attempts with expired leases
    for (let i = 0; i < 3; i++) {
      claimNext(PROJECT, -1000, "holder", db);
      reclaimExpiredLeases(PROJECT, db);
    }

    // Verify dead letter event was emitted
    const deadLetterEvents = listEvents(PROJECT, { type: "dispatch_dead_letter" }, db);
    expect(deadLetterEvents).toHaveLength(1);
    expect(deadLetterEvents[0]!.payload.taskId).toBe(task.id);
    expect(deadLetterEvents[0]!.payload.attempts).toBe(3);
    expect(deadLetterEvents[0]!.payload.lastError).toBe("Lease expired after max attempts");
  });

  it("does not emit dispatch_dead_letter when lease reclaim still has attempts remaining", () => {
    const task = createTask({ projectId: PROJECT, title: "Retriable task", createdBy: "agent:pm" }, db);
    enqueue(PROJECT, task.id, undefined, undefined, db);

    // Only 1 attempt — not exhausted yet
    claimNext(PROJECT, -1000, "holder", db);
    reclaimExpiredLeases(PROJECT, db);

    const deadLetterEvents = listEvents(PROJECT, { type: "dispatch_dead_letter" }, db);
    expect(deadLetterEvents).toHaveLength(0);
  });

  // --- Metrics & audit instrumentation ---

  it("records queue_enqueue metric and audit on enqueue", () => {
    const task = createTask({ projectId: PROJECT, title: "Metric task", createdBy: "agent:pm" }, db);
    const item = enqueue(PROJECT, task.id, undefined, 1, db)!;

    const metrics = queryMetrics({ projectId: PROJECT, key: "queue_enqueue" }, db);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.subject).toBe(task.id);
    expect(metrics[0]!.tags).toMatchObject({ priority: 1, queueItemId: item.id });

    const audits = queryAuditLog({ projectId: PROJECT, action: "queue.enqueue" }, db);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.targetId).toBe(item.id);
    expect(audits[0]!.actor).toBe("system:dispatch");
  });

  it("records queue_wait_time metric and audit on claim", () => {
    const task = createTask({ projectId: PROJECT, title: "Wait task", createdBy: "agent:pm" }, db);
    enqueue(PROJECT, task.id, undefined, undefined, db);

    const claimed = claimNext(PROJECT, 60000, "agent:test", db)!;

    const metrics = queryMetrics({ projectId: PROJECT, key: "queue_wait_time" }, db);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.subject).toBe(task.id);
    expect(metrics[0]!.value).toBeGreaterThanOrEqual(0);

    const audits = queryAuditLog({ projectId: PROJECT, action: "queue.claim" }, db);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toBe("agent:test");
    expect(audits[0]!.targetId).toBe(claimed.id);
  });

  it("records queue_lease_expired metric and audit on reclaim", () => {
    const task = createTask({ projectId: PROJECT, title: "Lease task", createdBy: "agent:pm" }, db);
    enqueue(PROJECT, task.id, undefined, undefined, db);

    claimNext(PROJECT, -1000, "holder", db);
    reclaimExpiredLeases(PROJECT, db);

    const metrics = queryMetrics({ projectId: PROJECT, key: "queue_lease_expired" }, db);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.tags).toMatchObject({ exhausted: false });

    const audits = queryAuditLog({ projectId: PROJECT, action: "queue.lease_expired" }, db);
    expect(audits).toHaveLength(1);
    const detail = JSON.parse(audits[0]!.detail!);
    expect(detail.outcome).toBe("requeued");
  });

  it("records queue.complete audit when projectId is provided", () => {
    const task = createTask({ projectId: PROJECT, title: "Complete task", createdBy: "agent:pm" }, db);
    const item = enqueue(PROJECT, task.id, undefined, undefined, db)!;

    completeItem(item.id, db, PROJECT);

    const audits = queryAuditLog({ projectId: PROJECT, action: "queue.complete" }, db);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.targetId).toBe(item.id);
  });

  it("records queue.fail audit when projectId is provided", () => {
    const task = createTask({ projectId: PROJECT, title: "Fail task", createdBy: "agent:pm" }, db);
    const item = enqueue(PROJECT, task.id, undefined, undefined, db)!;

    failItem(item.id, "test error", db, PROJECT);

    const audits = queryAuditLog({ projectId: PROJECT, action: "queue.fail" }, db);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toBe("test error");
  });

  // --- Stale dispatched item reclaim ---

  it("reclaims stale dispatched items using dispatched_at (not created_at)", () => {
    const task = createTask({ projectId: PROJECT, title: "Stale dispatch task", createdBy: "agent:pm" }, db);
    const item = enqueue(PROJECT, task.id, undefined, undefined, db)!;

    // Mark as dispatched, then backdate dispatched_at to be stale
    markDispatched(item.id, db, PROJECT);
    const staleTime = Date.now() - STALE_DISPATCHED_MS - 60_000; // 1 min past threshold
    db.prepare("UPDATE dispatch_queue SET dispatched_at = ? WHERE id = ?").run(staleTime, item.id);

    const reclaimed = reclaimExpiredLeases(PROJECT, db);
    expect(reclaimed).toBe(1);

    const status = getQueueStatus(PROJECT, db);
    expect(status.failed).toBe(1);
    expect(status.recentItems[0]!.lastError).toBe("Dispatched session never completed");
  });

  it("does NOT reclaim recently dispatched items", () => {
    const task = createTask({ projectId: PROJECT, title: "Recent dispatch task", createdBy: "agent:pm" }, db);
    const item = enqueue(PROJECT, task.id, undefined, undefined, db)!;

    // Mark as dispatched just now — should NOT be reclaimed
    markDispatched(item.id, db, PROJECT);

    const reclaimed = reclaimExpiredLeases(PROJECT, db);
    expect(reclaimed).toBe(0);

    const status = getQueueStatus(PROJECT, db);
    expect(status.failed).toBe(0);
  });

  it("does NOT reclaim dispatched items with NULL dispatched_at", () => {
    const task = createTask({ projectId: PROJECT, title: "Null dispatched_at task", createdBy: "agent:pm" }, db);
    const item = enqueue(PROJECT, task.id, undefined, undefined, db)!;

    // Manually set status to dispatched but leave dispatched_at NULL
    db.prepare("UPDATE dispatch_queue SET status = 'dispatched' WHERE id = ?").run(item.id);

    const reclaimed = reclaimExpiredLeases(PROJECT, db);
    expect(reclaimed).toBe(0);
  });

  it("uses STALE_DISPATCHED_MS (20 min) not 2 hours", () => {
    expect(STALE_DISPATCHED_MS).toBe(20 * 60 * 1000);
  });
});
