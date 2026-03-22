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

// Mock auto-kill and stuck detector to avoid side effects
vi.mock("../../src/audit/auto-kill.js", () => ({
  killAllStuckAgents: vi.fn(async () => 0),
}));
vi.mock("../../src/audit/stuck-detector.js", () => ({
  detectStuckAgents: vi.fn(() => []),
}));
vi.mock("../../src/dispatch/spawn.js", () => ({
  buildTaskPrompt: vi.fn(() => "mock prompt"),
}));
vi.mock("../../src/dispatch/inject-dispatch.js", () => ({
  dispatchViaInject: vi.fn(async () => ({ ok: false, error: "mock" })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { sweep } = await import("../../src/sweep/actions.js");
const { createTask, transitionTask, attachEvidence, getTask } = await import("../../src/tasks/ops.js");
const { listEvents } = await import("../../src/events/store.js");
const { getMessage } = await import("../../src/messaging/store.js");
const project = await import("../../src/project.js");

import type { ReviewConfig } from "../../src/types.js";

describe("review escalation sweep", () => {
  let db: DatabaseSync;
  const PROJECT = "review-escalation-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    vi.restoreAllMocks();
  });

  function injectReviewConfig(config: ReviewConfig | undefined, withManager = false) {
    const extConfig: any = config ? { review: config } : {};
    vi.spyOn(project, "getExtendedProjectConfig").mockReturnValue(
      Object.keys(extConfig).length > 0 ? extConfig : null,
    );

    if (withManager) {
      vi.spyOn(project, "getRegisteredAgentIds").mockReturnValue(["mgr-agent"]);
      vi.spyOn(project, "getAgentConfig").mockReturnValue({
        projectId: PROJECT,
        config: { extends: "manager" } as any,
      });
    }
  }

  /** Create a task and move it to REVIEW with a backdated transition timestamp. */
  function createReviewTask(hoursAgo: number, title = "Stale review task") {
    const task = createTask({ projectId: PROJECT, title, createdBy: "mgr" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "mgr", assignedTo: "worker", verificationRequired: false }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "worker", verificationRequired: false }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "work done", attachedBy: "worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "worker", verificationRequired: false }, db);

    // Backdate the REVIEW transition
    const pastTime = Date.now() - (hoursAgo * 3_600_000);
    db.prepare(
      "UPDATE transitions SET created_at = ? WHERE task_id = ? AND to_state = 'REVIEW'",
    ).run(pastTime, task.id);

    return task;
  }

  it("no escalation when autoEscalateAfterHours not configured", async () => {
    injectReviewConfig(undefined);
    createReviewTask(10); // 10 hours ago

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.reviewEscalated).toBe(0);
  });

  it("no escalation when task within threshold", async () => {
    injectReviewConfig({ autoEscalateAfterHours: 4 });
    createReviewTask(2); // Only 2 hours, threshold is 4

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.reviewEscalated).toBe(0);
  });

  it("escalation fires when task exceeds threshold", async () => {
    injectReviewConfig({ autoEscalateAfterHours: 4 }, true);
    createReviewTask(6); // 6 hours, threshold is 4

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.reviewEscalated).toBe(1);
  });

  it("task metadata marked to prevent re-escalation", async () => {
    injectReviewConfig({ autoEscalateAfterHours: 4 }, true);
    const task = createReviewTask(6);

    await sweep({ projectId: PROJECT, dbOverride: db });

    // Check metadata
    const updated = getTask(PROJECT, task.id, db);
    const metadata = typeof updated?.metadata === "string" ? JSON.parse(updated.metadata) : updated?.metadata;
    expect(metadata?.review_escalated).toBeTruthy();
    expect(metadata?.review_escalated_at).toBeTruthy();
  });

  it("already-escalated tasks not re-escalated", async () => {
    injectReviewConfig({ autoEscalateAfterHours: 4 }, true);
    const task = createReviewTask(6);

    // First sweep
    const r1 = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(r1.reviewEscalated).toBe(1);

    // Second sweep — should skip
    const r2 = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(r2.reviewEscalated).toBe(0);
  });

  it("sweep event emitted with review_stale finding", async () => {
    injectReviewConfig({ autoEscalateAfterHours: 4 }, true);
    createReviewTask(6);

    await sweep({ projectId: PROJECT, dbOverride: db });

    const events = listEvents(PROJECT, { type: "sweep_finding" }, db);
    const staleEvent = events.find(e => (e.payload as any).finding === "review_stale");
    expect(staleEvent).toBeTruthy();
    expect(staleEvent?.payload).toMatchObject({
      finding: "review_stale",
      assignedTo: "worker",
    });
  });
});
