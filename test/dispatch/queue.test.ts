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
const { createTask } = await import("../../src/tasks/ops.js");
const { enqueue, claimNext, reclaimExpiredLeases, completeItem, failItem, cancelItem, getQueueStatus } =
  await import("../../src/dispatch/queue.js");
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
});
