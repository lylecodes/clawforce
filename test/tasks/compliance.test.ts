import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createTask, transitionTask, attachEvidence, getTask } = await import("../../src/tasks/ops.js");
const {
  trackWorkerSession,
  markWorkerCompliant,
  isWorkerCompliant,
  getIncompliantWorkers,
  enforceWorkerCompliance,
  untrackWorkerSession,
  resetWorkerComplianceForTest,
} = await import("../../src/tasks/compliance.js");

describe("clawforce/worker-compliance", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
    resetWorkerComplianceForTest();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  it("untracked session is considered compliant", () => {
    expect(isWorkerCompliant("unknown-session")).toBe(true);
  });

  it("tracks worker and marks compliant on transition", () => {
    trackWorkerSession("session:worker-1", PROJECT, "task-1");
    expect(isWorkerCompliant("session:worker-1")).toBe(false);

    markWorkerCompliant("session:worker-1");
    expect(isWorkerCompliant("session:worker-1")).toBe(true);
  });

  it("getIncompliantWorkers returns non-compliant sessions", () => {
    trackWorkerSession("session:a", PROJECT, "task-a");
    trackWorkerSession("session:b", PROJECT, "task-b");

    markWorkerCompliant("session:a");

    const incompliant = getIncompliantWorkers();
    expect(incompliant.length).toBe(1);
    expect(incompliant[0]!.sessionKey).toBe("session:b");
    expect(incompliant[0]!.taskId).toBe("task-b");
  });

  it("enforceWorkerCompliance blocks ASSIGNED task", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Enforce test", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );

    trackWorkerSession("session:worker", PROJECT, task.id);

    const enforced = enforceWorkerCompliance("session:worker", db);
    expect(enforced).toBe(true);

    const updated = getTask(PROJECT, task.id, db);
    expect(updated?.state).toBe("BLOCKED");
  });

  it("enforceWorkerCompliance blocks IN_PROGRESS task", () => {
    const task = createTask(
      { projectId: PROJECT, title: "In-progress enforce", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    trackWorkerSession("session:worker", PROJECT, task.id);

    const enforced = enforceWorkerCompliance("session:worker", db);
    expect(enforced).toBe(true);

    const updated = getTask(PROJECT, task.id, db);
    expect(updated?.state).toBe("BLOCKED");
  });

  it("enforceWorkerCompliance skips already-DONE task", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Already done", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );

    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
    attachEvidence(
      { projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "agent:worker" },
      db,
    );
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "agent:worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "agent:verifier" }, db);

    trackWorkerSession("session:worker", PROJECT, task.id);

    const enforced = enforceWorkerCompliance("session:worker", db);
    expect(enforced).toBe(false);
  });

  it("enforceWorkerCompliance skips compliant worker", () => {
    const task = createTask(
      { projectId: PROJECT, title: "Compliant", createdBy: "agent:pm", assignedTo: "agent:worker" },
      db,
    );

    trackWorkerSession("session:worker", PROJECT, task.id);
    markWorkerCompliant("session:worker");

    const enforced = enforceWorkerCompliance("session:worker", db);
    expect(enforced).toBe(false);
  });

  it("untrackWorkerSession removes tracking", () => {
    trackWorkerSession("session:worker", PROJECT, "task-1");
    expect(isWorkerCompliant("session:worker")).toBe(false);

    untrackWorkerSession("session:worker");
    expect(isWorkerCompliant("session:worker")).toBe(true);
  });
});
