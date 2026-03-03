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
const { handleWorkerSessionEnd, notifyWorkerSessionEnd } = await import("../../src/tasks/session-end.js");
const { createTask, getTask, transitionTask, attachEvidence } = await import("../../src/tasks/ops.js");
const { trackWorkerSession, resetWorkerComplianceForTest } = await import("../../src/tasks/compliance.js");

let db: DatabaseSync;
const PROJECT = "test-project";

beforeEach(() => {
  db = getMemoryDb();
  resetWorkerComplianceForTest();
});

afterEach(() => {
  resetWorkerComplianceForTest();
  try { db.close(); } catch {}
});

describe("handleWorkerSessionEnd", () => {
  it("returns false for unknown session", () => {
    const result = handleWorkerSessionEnd({
      sessionKey: "unknown-session",
      status: "error",
      dbOverride: db,
    });
    expect(result).toBe(false);
  });

  it("attaches evidence and transitions to FAILED for non-compliant worker in ASSIGNED state", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Worker task",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
    }, db);

    trackWorkerSession("session-1", PROJECT, task.id);

    const result = handleWorkerSessionEnd({
      sessionKey: "session-1",
      status: "error",
      error: "Process crashed",
      dbOverride: db,
    });

    expect(result).toBe(true);
    const updatedTask = getTask(PROJECT, task.id, db);
    expect(updatedTask!.state).toBe("FAILED");
  });

  it("does nothing for tasks already in DONE", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Done task",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
    }, db);

    // Transition to DONE through the full lifecycle
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "agent:verifier" }, db);

    trackWorkerSession("session-2", PROJECT, task.id);

    const result = handleWorkerSessionEnd({
      sessionKey: "session-2",
      status: "ok",
      dbOverride: db,
    });

    expect(result).toBe(false);
    const updatedTask = getTask(PROJECT, task.id, db);
    expect(updatedTask!.state).toBe("DONE");
  });

  it("does nothing for tasks already in FAILED", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Failed task",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
    }, db);

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "FAILED", actor: "agent:worker", reason: "earlier failure" }, db);

    trackWorkerSession("session-3", PROJECT, task.id);

    const result = handleWorkerSessionEnd({
      sessionKey: "session-3",
      status: "error",
      dbOverride: db,
    });

    expect(result).toBe(false);
  });
});

describe("notifyWorkerSessionEnd", () => {
  it("delegates to handleWorkerSessionEnd", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Notify task",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
    }, db);

    trackWorkerSession("session-4", PROJECT, task.id);

    const result = notifyWorkerSessionEnd("session-4", {
      status: "timeout",
      error: "Timed out",
    }, db);

    expect(result).toBe(true);
    const updatedTask = getTask(PROJECT, task.id, db);
    expect(updatedTask!.state).toBe("FAILED");
  });
});
