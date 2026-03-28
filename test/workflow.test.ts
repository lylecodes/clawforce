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
const { createWorkflow, addTaskToPhase, getWorkflow, getPhaseStatus, advanceWorkflow, forceAdvanceWorkflow, listWorkflows } =
  await import("../src/workflow.js");
const { createTask, transitionTask, attachEvidence } = await import("../src/tasks/ops.js");

describe("workflow module", () => {
  let db: DatabaseSync;
  const PROJECT = "wf-test";

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

  /** Helper: move a task through OPEN -> ASSIGNED -> IN_PROGRESS -> REVIEW -> DONE */
  function completeTask(taskId: string) {
    transitionTask({ projectId: PROJECT, taskId, toState: "ASSIGNED", actor: "agent:a" }, db);
    transitionTask({ projectId: PROJECT, taskId, toState: "IN_PROGRESS", actor: "agent:a" }, db);
    attachEvidence({ projectId: PROJECT, taskId, type: "output", content: "done", attachedBy: "agent:a" }, db);
    transitionTask({ projectId: PROJECT, taskId, toState: "REVIEW", actor: "agent:a" }, db);
    transitionTask({ projectId: PROJECT, taskId, toState: "DONE", actor: "agent:verifier", verificationRequired: false }, db);
  }

  /** Helper: move a task to FAILED via ASSIGNED -> FAILED */
  function failTask(taskId: string) {
    transitionTask({ projectId: PROJECT, taskId, toState: "ASSIGNED", actor: "agent:a" }, db);
    transitionTask({ projectId: PROJECT, taskId, toState: "FAILED", actor: "agent:a", reason: "crash" }, db);
  }

  it("createWorkflow creates a workflow with phases and default gate conditions", () => {
    const wf = createWorkflow({
      projectId: PROJECT,
      name: "Build Pipeline",
      phases: [
        { name: "Build" },
        { name: "Test", gateCondition: "any_done" },
        { name: "Deploy" },
      ],
      createdBy: "agent:pm",
    }, db);

    expect(wf.id).toBeTruthy();
    expect(wf.name).toBe("Build Pipeline");
    expect(wf.projectId).toBe(PROJECT);
    expect(wf.state).toBe("active");
    expect(wf.currentPhase).toBe(0);
    expect(wf.phases).toHaveLength(3);
    // Default gate condition should be "all_done"
    expect(wf.phases[0]!.gateCondition).toBe("all_done");
    // Explicitly set gate condition preserved
    expect(wf.phases[1]!.gateCondition).toBe("any_done");
    expect(wf.phases[2]!.gateCondition).toBe("all_done");
    // Each phase starts with empty taskIds
    for (const phase of wf.phases) {
      expect(phase.taskIds).toEqual([]);
    }
  });

  it("addTaskToPhase adds a task ID to the correct phase", () => {
    const wf = createWorkflow({
      projectId: PROJECT,
      name: "WF",
      phases: [{ name: "Phase 0" }, { name: "Phase 1" }],
      createdBy: "agent:pm",
    }, db);

    const task = createTask({ projectId: PROJECT, title: "Task A", createdBy: "agent:pm" }, db);

    const result = addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 1, taskId: task.id }, db);
    expect(result).toBe(true);

    const updated = getWorkflow(PROJECT, wf.id, db);
    expect(updated!.phases[0]!.taskIds).toEqual([]);
    expect(updated!.phases[1]!.taskIds).toContain(task.id);
  });

  it("addTaskToPhase is idempotent (adding same task twice returns true)", () => {
    const wf = createWorkflow({
      projectId: PROJECT,
      name: "WF",
      phases: [{ name: "Phase 0" }],
      createdBy: "agent:pm",
    }, db);

    const task = createTask({ projectId: PROJECT, title: "Task A", createdBy: "agent:pm" }, db);

    const first = addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: task.id }, db);
    expect(first).toBe(true);

    const second = addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: task.id }, db);
    expect(second).toBe(true);

    // Should only appear once
    const updated = getWorkflow(PROJECT, wf.id, db);
    expect(updated!.phases[0]!.taskIds).toHaveLength(1);
  });

  it("addTaskToPhase rejects invalid phase index", () => {
    const wf = createWorkflow({
      projectId: PROJECT,
      name: "WF",
      phases: [{ name: "Phase 0" }],
      createdBy: "agent:pm",
    }, db);

    const task = createTask({ projectId: PROJECT, title: "Task A", createdBy: "agent:pm" }, db);

    expect(addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: -1, taskId: task.id }, db)).toBe(false);
    expect(addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 1, taskId: task.id }, db)).toBe(false);
    expect(addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 99, taskId: task.id }, db)).toBe(false);
  });

  describe("getPhaseStatus with all_done gate", () => {
    it("ready=true when all tasks are DONE", () => {
      const wf = createWorkflow({
        projectId: PROJECT,
        name: "WF",
        phases: [{ name: "Phase 0", gateCondition: "all_done" }],
        createdBy: "agent:pm",
      }, db);

      const t1 = createTask({ projectId: PROJECT, title: "T1", createdBy: "agent:pm" }, db);
      const t2 = createTask({ projectId: PROJECT, title: "T2", createdBy: "agent:pm" }, db);
      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: t1.id }, db);
      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: t2.id }, db);

      completeTask(t1.id);
      completeTask(t2.id);

      const status = getPhaseStatus(PROJECT, wf.id, 0, db);
      expect(status).not.toBeNull();
      expect(status!.ready).toBe(true);
      expect(status!.completed).toBe(2);
      expect(status!.total).toBe(2);
    });

    it("ready=false when some tasks are not DONE", () => {
      const wf = createWorkflow({
        projectId: PROJECT,
        name: "WF",
        phases: [{ name: "Phase 0", gateCondition: "all_done" }],
        createdBy: "agent:pm",
      }, db);

      const t1 = createTask({ projectId: PROJECT, title: "T1", createdBy: "agent:pm" }, db);
      const t2 = createTask({ projectId: PROJECT, title: "T2", createdBy: "agent:pm" }, db);
      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: t1.id }, db);
      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: t2.id }, db);

      completeTask(t1.id);
      // t2 remains OPEN

      const status = getPhaseStatus(PROJECT, wf.id, 0, db);
      expect(status!.ready).toBe(false);
      expect(status!.completed).toBe(1);
      expect(status!.total).toBe(2);
    });
  });

  describe("getPhaseStatus with any_done gate", () => {
    it("ready=true when at least one task is DONE", () => {
      const wf = createWorkflow({
        projectId: PROJECT,
        name: "WF",
        phases: [{ name: "Phase 0", gateCondition: "any_done" }],
        createdBy: "agent:pm",
      }, db);

      const t1 = createTask({ projectId: PROJECT, title: "T1", createdBy: "agent:pm" }, db);
      const t2 = createTask({ projectId: PROJECT, title: "T2", createdBy: "agent:pm" }, db);
      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: t1.id }, db);
      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: t2.id }, db);

      completeTask(t1.id);
      // t2 remains OPEN

      const status = getPhaseStatus(PROJECT, wf.id, 0, db);
      expect(status!.ready).toBe(true);
      expect(status!.completed).toBe(1);
    });

    it("ready=false when no tasks are DONE", () => {
      const wf = createWorkflow({
        projectId: PROJECT,
        name: "WF",
        phases: [{ name: "Phase 0", gateCondition: "any_done" }],
        createdBy: "agent:pm",
      }, db);

      const t1 = createTask({ projectId: PROJECT, title: "T1", createdBy: "agent:pm" }, db);
      const t2 = createTask({ projectId: PROJECT, title: "T2", createdBy: "agent:pm" }, db);
      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: t1.id }, db);
      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: t2.id }, db);

      // Both remain OPEN

      const status = getPhaseStatus(PROJECT, wf.id, 0, db);
      expect(status!.ready).toBe(false);
      expect(status!.completed).toBe(0);
    });
  });

  describe("getPhaseStatus with all_resolved gate", () => {
    it("ready=true when all tasks DONE or FAILED (with at least one DONE)", () => {
      const wf = createWorkflow({
        projectId: PROJECT,
        name: "WF",
        phases: [{ name: "Phase 0", gateCondition: "all_resolved" }],
        createdBy: "agent:pm",
      }, db);

      const t1 = createTask({ projectId: PROJECT, title: "T1", createdBy: "agent:pm" }, db);
      const t2 = createTask({ projectId: PROJECT, title: "T2", createdBy: "agent:pm" }, db);
      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: t1.id }, db);
      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: t2.id }, db);

      completeTask(t1.id);
      failTask(t2.id);

      const status = getPhaseStatus(PROJECT, wf.id, 0, db);
      expect(status!.ready).toBe(true);
      expect(status!.completed).toBe(1);
      expect(status!.failed).toBe(1);
      expect(status!.resolved).toBe(2);
    });

    it("ready=true when all tasks FAILED (all resolved regardless of outcome)", () => {
      const wf = createWorkflow({
        projectId: PROJECT,
        name: "WF",
        phases: [{ name: "Phase 0", gateCondition: "all_resolved" }],
        createdBy: "agent:pm",
      }, db);

      const t1 = createTask({ projectId: PROJECT, title: "T1", createdBy: "agent:pm" }, db);
      const t2 = createTask({ projectId: PROJECT, title: "T2", createdBy: "agent:pm" }, db);
      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: t1.id }, db);
      addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: t2.id }, db);

      failTask(t1.id);
      failTask(t2.id);

      const status = getPhaseStatus(PROJECT, wf.id, 0, db);
      expect(status!.ready).toBe(true);
      expect(status!.completed).toBe(0);
      expect(status!.failed).toBe(2);
    });
  });

  it("advanceWorkflow advances to next phase when gate satisfied", () => {
    const wf = createWorkflow({
      projectId: PROJECT,
      name: "WF",
      phases: [
        { name: "Phase 0", gateCondition: "all_done" },
        { name: "Phase 1" },
      ],
      createdBy: "agent:pm",
    }, db);

    const task = createTask({ projectId: PROJECT, title: "T1", createdBy: "agent:pm" }, db);
    addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: task.id }, db);

    completeTask(task.id);

    const result = advanceWorkflow(PROJECT, wf.id, db);
    expect(result).toBe(1);

    const updated = getWorkflow(PROJECT, wf.id, db);
    expect(updated!.currentPhase).toBe(1);
    expect(updated!.state).toBe("active");
  });

  it("advanceWorkflow returns null when gate not satisfied", () => {
    const wf = createWorkflow({
      projectId: PROJECT,
      name: "WF",
      phases: [
        { name: "Phase 0", gateCondition: "all_done" },
        { name: "Phase 1" },
      ],
      createdBy: "agent:pm",
    }, db);

    const task = createTask({ projectId: PROJECT, title: "T1", createdBy: "agent:pm" }, db);
    addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: task.id }, db);

    // Task remains OPEN — gate not satisfied
    const result = advanceWorkflow(PROJECT, wf.id, db);
    expect(result).toBeNull();

    const updated = getWorkflow(PROJECT, wf.id, db);
    expect(updated!.currentPhase).toBe(0);
  });

  it("advanceWorkflow marks workflow completed when last phase is done", () => {
    const wf = createWorkflow({
      projectId: PROJECT,
      name: "WF",
      phases: [{ name: "Phase 0", gateCondition: "all_done" }],
      createdBy: "agent:pm",
    }, db);

    const task = createTask({ projectId: PROJECT, title: "T1", createdBy: "agent:pm" }, db);
    addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: task.id }, db);

    completeTask(task.id);

    const result = advanceWorkflow(PROJECT, wf.id, db);
    // Returns the current phase (0) when completing the last phase
    expect(result).toBe(0);

    const updated = getWorkflow(PROJECT, wf.id, db);
    expect(updated!.state).toBe("completed");
  });

  it("forceAdvanceWorkflow advances regardless of gate condition", () => {
    const wf = createWorkflow({
      projectId: PROJECT,
      name: "WF",
      phases: [
        { name: "Phase 0", gateCondition: "all_done" },
        { name: "Phase 1" },
      ],
      createdBy: "agent:pm",
    }, db);

    const task = createTask({ projectId: PROJECT, title: "T1", createdBy: "agent:pm" }, db);
    addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: task.id }, db);

    // Task remains OPEN — gate NOT satisfied, but force-advance should work
    const result = forceAdvanceWorkflow(PROJECT, wf.id, "agent:admin", db);
    expect(result).toBe(1);

    const updated = getWorkflow(PROJECT, wf.id, db);
    expect(updated!.currentPhase).toBe(1);
    expect(updated!.state).toBe("active");
  });

  it("forceAdvanceWorkflow returns null for inactive workflow", () => {
    const wf = createWorkflow({
      projectId: PROJECT,
      name: "WF",
      phases: [{ name: "Phase 0" }],
      createdBy: "agent:pm",
    }, db);

    const task = createTask({ projectId: PROJECT, title: "T1", createdBy: "agent:pm" }, db);
    addTaskToPhase({ projectId: PROJECT, workflowId: wf.id, phase: 0, taskId: task.id }, db);

    completeTask(task.id);

    // Advance to complete the workflow (single phase)
    advanceWorkflow(PROJECT, wf.id, db);
    const completed = getWorkflow(PROJECT, wf.id, db);
    expect(completed!.state).toBe("completed");

    // Force-advance on completed workflow should return null
    const result = forceAdvanceWorkflow(PROJECT, wf.id, "agent:admin", db);
    expect(result).toBeNull();
  });

  it("listWorkflows returns all workflows for project", () => {
    createWorkflow({
      projectId: PROJECT,
      name: "WF 1",
      phases: [{ name: "Phase 0" }],
      createdBy: "agent:pm",
    }, db);
    createWorkflow({
      projectId: PROJECT,
      name: "WF 2",
      phases: [{ name: "Phase 0" }],
      createdBy: "agent:pm",
    }, db);

    const workflows = listWorkflows(PROJECT, db);
    expect(workflows).toHaveLength(2);
    expect(workflows.map((w) => w.name)).toContain("WF 1");
    expect(workflows.map((w) => w.name)).toContain("WF 2");
  });
});
