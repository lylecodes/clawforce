import type { DatabaseSync } from "../../src/sqlite-driver.js";
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
const { buildRetryContext, buildRetryPrompt } = await import("../../src/tasks/retry.js");
const { createTask, transitionTask, attachEvidence } = await import("../../src/tasks/ops.js");

let db: DatabaseSync;
const PROJECT = "test-project";

beforeEach(() => {
  db = getMemoryDb();
  vi.spyOn(dbModule, "getDb").mockReturnValue(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  try { db.close(); } catch {}
});

describe("buildRetryContext", () => {
  it("returns null for missing task", () => {
    const ctx = buildRetryContext(PROJECT, "nonexistent");
    expect(ctx).toBeNull();
  });

  it("returns attemptNumber: 1 with empty previousAttempts on first attempt", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Fresh task",
      createdBy: "agent:pm",
    }, db);

    const ctx = buildRetryContext(PROJECT, task.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.attemptNumber).toBe(1);
    expect(ctx!.previousAttempts).toHaveLength(0);
  });

  it("builds previous attempts from REVIEW → FAILED transitions", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Retry task",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
    }, db);

    // First attempt
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "attempt 1 output", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:verifier", reason: "needs fixes" }, db);

    // Second attempt
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "attempt 2 output", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "FAILED", actor: "agent:verifier", reason: "still broken" }, db);

    const ctx = buildRetryContext(PROJECT, task.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.previousAttempts.length).toBeGreaterThanOrEqual(1);
    // At least one attempt should have a failure reason
    const hasReason = ctx!.previousAttempts.some(a => a.failureReason);
    expect(hasReason).toBe(true);
  });
});

describe("buildRetryPrompt", () => {
  it("returns base prompt when no previous attempts", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Fresh task",
      createdBy: "agent:pm",
    }, db);

    const result = buildRetryPrompt(PROJECT, task.id, "Do the thing");
    expect(result).toBe("Do the thing");
  });

  it("prepends retry context to base prompt when previous attempts exist", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Retry task",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
    }, db);

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "output", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "FAILED", actor: "agent:verifier", reason: "bug" }, db);

    const result = buildRetryPrompt(PROJECT, task.id, "Try again");
    expect(result).toContain("Try again");
    expect(result).toContain("Retry Context");
  });
});
