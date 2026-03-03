import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../src/db.js");
const { createWorkflow, addTaskToPhase, advanceWorkflow, isTaskInFuturePhase } =
  await import("../src/workflow.js");
const { createTask, transitionTask, attachEvidence } = await import("../src/tasks/ops.js");

describe("workflow phase gate enforcement", () => {
  let db: DatabaseSync;
  const PROJECT = "gate-test";

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

  function createTwoPhaseWorkflow() {
    return createWorkflow({
      projectId: PROJECT,
      name: "Test Workflow",
      phases: [
        { name: "Phase 0", gateCondition: "all_done" },
        { name: "Phase 1", gateCondition: "all_done" },
      ],
      createdBy: "agent:pm",
    }, db);
  }

  describe("isTaskInFuturePhase", () => {
    it("returns blocked for a task in a future phase", () => {
      const wf = createTwoPhaseWorkflow();
      const result = isTaskInFuturePhase(
        { workflowId: wf.id, workflowPhase: 1, projectId: PROJECT },
        db,
      );
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("Phase 1");
      expect(result.reason).toContain("phase 0");
    });

    it("returns not blocked for a task in the current phase", () => {
      const wf = createTwoPhaseWorkflow();
      const result = isTaskInFuturePhase(
        { workflowId: wf.id, workflowPhase: 0, projectId: PROJECT },
        db,
      );
      expect(result.blocked).toBe(false);
    });

    it("returns not blocked for a task with no workflowId", () => {
      const result = isTaskInFuturePhase(
        { projectId: PROJECT },
        db,
      );
      expect(result.blocked).toBe(false);
    });

    it("returns not blocked for completed workflows", () => {
      const wf = createTwoPhaseWorkflow();
      // Mark workflow as completed
      db.prepare("UPDATE workflows SET state = 'completed' WHERE id = ?").run(wf.id);
      const result = isTaskInFuturePhase(
        { workflowId: wf.id, workflowPhase: 1, projectId: PROJECT },
        db,
      );
      expect(result.blocked).toBe(false);
    });

    it("returns not blocked for failed workflows", () => {
      const wf = createTwoPhaseWorkflow();
      db.prepare("UPDATE workflows SET state = 'failed' WHERE id = ?").run(wf.id);
      const result = isTaskInFuturePhase(
        { workflowId: wf.id, workflowPhase: 1, projectId: PROJECT },
        db,
      );
      expect(result.blocked).toBe(false);
    });

    it("includes phase names in the reason", () => {
      const wf = createTwoPhaseWorkflow();
      const result = isTaskInFuturePhase(
        { workflowId: wf.id, workflowPhase: 1, projectId: PROJECT },
        db,
      );
      expect(result.reason).toContain('"Phase 1"');
      expect(result.reason).toContain('"Phase 0"');
    });
  });

  describe("transitionTask gate", () => {
    it("blocks OPEN → ASSIGNED for a task in a future phase", () => {
      const wf = createTwoPhaseWorkflow();
      const task = createTask({
        projectId: PROJECT,
        title: "Future task",
        createdBy: "agent:pm",
        workflowId: wf.id,
        workflowPhase: 1,
      }, db);

      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 1, taskId: task.id }, db);

      const result = transitionTask({
        projectId: PROJECT,
        taskId: task.id,
        toState: "ASSIGNED",
        actor: "agent:worker",
      }, db);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("phase 1");
      }
    });

    it("allows OPEN → ASSIGNED for a task in the current phase", () => {
      const wf = createTwoPhaseWorkflow();
      const task = createTask({
        projectId: PROJECT,
        title: "Current task",
        createdBy: "agent:pm",
        workflowId: wf.id,
        workflowPhase: 0,
      }, db);

      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: task.id }, db);

      const result = transitionTask({
        projectId: PROJECT,
        taskId: task.id,
        toState: "ASSIGNED",
        actor: "agent:worker",
      }, db);

      expect(result.ok).toBe(true);
    });

    it("allows OPEN → ASSIGNED for a non-workflow task", () => {
      const task = createTask({
        projectId: PROJECT,
        title: "Standalone task",
        createdBy: "agent:pm",
      }, db);

      const result = transitionTask({
        projectId: PROJECT,
        taskId: task.id,
        toState: "ASSIGNED",
        actor: "agent:worker",
      }, db);

      expect(result.ok).toBe(true);
    });

    it("allows OPEN → ASSIGNED after workflow advances to the task's phase", () => {
      const wf = createTwoPhaseWorkflow();

      // Create and complete a task in phase 0 to satisfy the gate
      const phase0Task = createTask({
        projectId: PROJECT,
        title: "Phase 0 task",
        createdBy: "agent:pm",
        workflowId: wf.id,
        workflowPhase: 0,
      }, db);
      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: phase0Task.id }, db);

      // Move phase 0 task through to DONE
      transitionTask({ projectId: PROJECT, taskId: phase0Task.id, toState: "ASSIGNED", actor: "agent:worker" }, db);
      transitionTask({ projectId: PROJECT, taskId: phase0Task.id, toState: "IN_PROGRESS", actor: "agent:worker" }, db);
      attachEvidence({ projectId: PROJECT, taskId: phase0Task.id, type: "output", content: "done", attachedBy: "agent:worker" }, db);
      transitionTask({ projectId: PROJECT, taskId: phase0Task.id, toState: "REVIEW", actor: "agent:worker", verificationRequired: false }, db);
      transitionTask({ projectId: PROJECT, taskId: phase0Task.id, toState: "DONE", actor: "agent:pm", verificationRequired: false }, db);

      // Advance the workflow
      const newPhase = advanceWorkflow(PROJECT, wf.id, db);
      expect(newPhase).toBe(1);

      // Now create a phase 1 task — should be assignable
      const phase1Task = createTask({
        projectId: PROJECT,
        title: "Phase 1 task",
        createdBy: "agent:pm",
        workflowId: wf.id,
        workflowPhase: 1,
      }, db);
      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 1, taskId: phase1Task.id }, db);

      const result = transitionTask({
        projectId: PROJECT,
        taskId: phase1Task.id,
        toState: "ASSIGNED",
        actor: "agent:worker",
      }, db);

      expect(result.ok).toBe(true);
    });
  });

  describe("createTask gate", () => {
    it("creates as OPEN instead of ASSIGNED when task is in a future phase", () => {
      const wf = createTwoPhaseWorkflow();
      const task = createTask({
        projectId: PROJECT,
        title: "Future assigned task",
        createdBy: "agent:pm",
        assignedTo: "agent:worker",
        workflowId: wf.id,
        workflowPhase: 1,
      }, db);

      expect(task.state).toBe("OPEN");
    });

    it("creates as ASSIGNED when task is in the current phase", () => {
      const wf = createTwoPhaseWorkflow();
      const task = createTask({
        projectId: PROJECT,
        title: "Current assigned task",
        createdBy: "agent:pm",
        assignedTo: "agent:worker",
        workflowId: wf.id,
        workflowPhase: 0,
      }, db);

      expect(task.state).toBe("ASSIGNED");
    });

    it("creates as ASSIGNED normally when no workflow is set", () => {
      const task = createTask({
        projectId: PROJECT,
        title: "No workflow task",
        createdBy: "agent:pm",
        assignedTo: "agent:worker",
      }, db);

      expect(task.state).toBe("ASSIGNED");
    });
  });
});
