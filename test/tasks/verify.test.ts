import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createTask, transitionTask, attachEvidence } = await import("../../src/tasks/ops.js");
const { submitVerdict } = await import("../../src/tasks/verify.js");
const { getReviewsForTask } = await import("../../src/telemetry/review-store.js");

describe("submitVerdict", () => {
  let db: DatabaseSync;
  const PROJECT = "test-verify";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  function createReviewableTask() {
    const task = createTask({
      projectId: PROJECT,
      title: "Test task",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
    }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);
    return task;
  }

  it("records an approved manager review on passing verdict", () => {
    const task = createReviewableTask();

    submitVerdict({
      projectId: PROJECT,
      taskId: task.id,
      verifier: "agent:pm",
      passed: true,
      reason: "All tests pass",
      sessionKey: "agent:pm:cron:abc123",
    }, db);

    const reviews = getReviewsForTask(PROJECT, task.id, db);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.verdict).toBe("approved");
    expect(reviews[0]!.reviewerAgentId).toBe("agent:pm");
    expect(reviews[0]!.reasoning).toBe("All tests pass");
    expect(reviews[0]!.sessionKey).toBe("agent:pm:cron:abc123");
  });

  it("records a rejected manager review on failing verdict", () => {
    const task = createReviewableTask();

    submitVerdict({
      projectId: PROJECT,
      taskId: task.id,
      verifier: "agent:pm",
      passed: false,
      reason: "Tests failing",
    }, db);

    const reviews = getReviewsForTask(PROJECT, task.id, db);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.verdict).toBe("rejected");
    expect(reviews[0]!.reasoning).toBe("Tests failing");
  });

  it("transitions task to DONE on passing verdict", () => {
    const task = createReviewableTask();

    const result = submitVerdict({
      projectId: PROJECT,
      taskId: task.id,
      verifier: "agent:pm",
      passed: true,
    }, db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.state).toBe("DONE");
    }
  });

  it("transitions task to IN_PROGRESS on failing verdict", () => {
    const task = createReviewableTask();

    const result = submitVerdict({
      projectId: PROJECT,
      taskId: task.id,
      verifier: "agent:pm",
      passed: false,
    }, db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.state).toBe("IN_PROGRESS");
    }
  });
});
