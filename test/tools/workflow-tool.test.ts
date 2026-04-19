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
const { createClawforceWorkflowTool } = await import("../../src/tools/workflow-tool.js");
const { createTask, transitionTask } = await import("../../src/tasks/ops.js");

describe("clawforce_workflow tool", () => {
  let db: DatabaseSync;
  const PROJECT = "wf-test";

  beforeEach(async () => {
    db = getMemoryDb();
    const dbModule = await import("../../src/db.js");
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    vi.restoreAllMocks();
  });

  function exec(params: Record<string, unknown>) {
    const tool = createClawforceWorkflowTool({ agentSessionKey: "session:test" });
    return tool.execute("call-1", params);
  }

  function parseResult(result: { content: Array<{ text: string }> }) {
    return JSON.parse(result.content[0]!.text);
  }

  it("creates a workflow", async () => {
    const result = await exec({
      action: "create",
      project_id: PROJECT,
      name: "Build Pipeline",
      phases: [
        { name: "Build", gate_condition: "all_done" },
        { name: "Test" },
        { name: "Deploy" },
      ],
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.workflow.name).toBe("Build Pipeline");
    expect(data.workflow.phases).toHaveLength(3);
    expect(data.workflow.state).toBe("active");
    expect(data.workflow.currentPhase).toBe(0);
  });

  it("gets a workflow", async () => {
    const createResult = await exec({
      action: "create",
      project_id: PROJECT,
      name: "Test WF",
      phases: [{ name: "Phase 1" }],
    });
    const created = parseResult(createResult);

    const getResult = await exec({
      action: "get",
      project_id: PROJECT,
      workflow_id: created.workflow.id,
    });
    const data = parseResult(getResult);
    expect(data.ok).toBe(true);
    expect(data.workflow.id).toBe(created.workflow.id);
    expect(data.workflow.name).toBe("Test WF");
  });

  it("lists workflows", async () => {
    await exec({
      action: "create",
      project_id: PROJECT,
      name: "WF 1",
      phases: [{ name: "P1" }],
    });
    await exec({
      action: "create",
      project_id: PROJECT,
      name: "WF 2",
      phases: [{ name: "P1" }],
    });

    const result = await exec({ action: "list", project_id: PROJECT });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.workflows).toHaveLength(2);
  });

  it("adds a task to a phase", async () => {
    const wfResult = await exec({
      action: "create",
      project_id: PROJECT,
      name: "WF",
      phases: [{ name: "Phase 1" }, { name: "Phase 2" }],
    });
    const wf = parseResult(wfResult).workflow;

    const task = createTask({ projectId: PROJECT, title: "Task A", createdBy: "test" }, db);

    const addResult = await exec({
      action: "add_task",
      project_id: PROJECT,
      workflow_id: wf.id,
      phase: 0,
      task_id: task.id,
    });
    const data = parseResult(addResult);
    expect(data.ok).toBe(true);
  });

  it("advances a workflow when gate is satisfied", async () => {
    const wfResult = await exec({
      action: "create",
      project_id: PROJECT,
      name: "WF",
      phases: [{ name: "Phase 1", gate_condition: "all_done" }, { name: "Phase 2" }],
    });
    const wf = parseResult(wfResult).workflow;

    const task = createTask({ projectId: PROJECT, title: "Task A", createdBy: "test" }, db);
    await exec({ action: "add_task", project_id: PROJECT, workflow_id: wf.id, phase: 0, task_id: task.id });

    // Complete the task through lifecycle
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "a" }, db);
    const { attachEvidence: attach } = await import("../../src/tasks/ops.js");
    attach({ projectId: PROJECT, taskId: task.id, type: "output", content: "done", attachedBy: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "DONE", actor: "b", verificationRequired: false }, db);

    const advResult = await exec({ action: "advance", project_id: PROJECT, workflow_id: wf.id });
    const data = parseResult(advResult);
    expect(data.ok).toBe(true);
    expect(data.advanced).toBe(true);
    expect(data.currentPhase).toBe(1);
  });

  it("reports phase_status", async () => {
    const wfResult = await exec({
      action: "create",
      project_id: PROJECT,
      name: "WF",
      phases: [{ name: "Phase 1" }],
    });
    const wf = parseResult(wfResult).workflow;

    const task = createTask({ projectId: PROJECT, title: "Task A", createdBy: "test" }, db);
    await exec({ action: "add_task", project_id: PROJECT, workflow_id: wf.id, phase: 0, task_id: task.id });

    const statusResult = await exec({
      action: "phase_status",
      project_id: PROJECT,
      workflow_id: wf.id,
      phase: 0,
    });
    const data = parseResult(statusResult);
    expect(data.ok).toBe(true);
    expect(data.name).toBe("Phase 1");
    expect(data.total).toBe(1);
    expect(data.completed).toBe(0);
    expect(data.ready).toBe(false);
  });

  it("returns error for missing phases on create", async () => {
    const result = await exec({ action: "create", project_id: PROJECT, name: "WF" });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.reason).toContain("phases");
  });

  it("returns error for unknown action", async () => {
    const result = await exec({ action: "bad_action", project_id: PROJECT });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.reason).toContain("Unknown action");
  });

  it("all_resolved gate: satisfied when one DONE and one FAILED", async () => {
    const wfResult = await exec({
      action: "create",
      project_id: PROJECT,
      name: "WF Resolved",
      phases: [{ name: "Phase 1", gate_condition: "all_resolved" }, { name: "Phase 2" }],
    });
    const wf = parseResult(wfResult).workflow;

    const taskA = createTask({ projectId: PROJECT, title: "Task A", createdBy: "test" }, db);
    const taskB = createTask({ projectId: PROJECT, title: "Task B", createdBy: "test" }, db);
    await exec({ action: "add_task", project_id: PROJECT, workflow_id: wf.id, phase: 0, task_id: taskA.id });
    await exec({ action: "add_task", project_id: PROJECT, workflow_id: wf.id, phase: 0, task_id: taskB.id });

    // Complete taskA through lifecycle
    transitionTask({ projectId: PROJECT, taskId: taskA.id, toState: "ASSIGNED", actor: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: taskA.id, toState: "IN_PROGRESS", actor: "a" }, db);
    const { attachEvidence: attach } = await import("../../src/tasks/ops.js");
    attach({ projectId: PROJECT, taskId: taskA.id, type: "output", content: "done", attachedBy: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: taskA.id, toState: "REVIEW", actor: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: taskA.id, toState: "DONE", actor: "b", verificationRequired: false }, db);

    // Fail taskB
    transitionTask({ projectId: PROJECT, taskId: taskB.id, toState: "ASSIGNED", actor: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: taskB.id, toState: "FAILED", actor: "a" }, db);

    // Gate should be satisfied — advance should work
    const advResult = await exec({ action: "advance", project_id: PROJECT, workflow_id: wf.id });
    const data = parseResult(advResult);
    expect(data.ok).toBe(true);
    expect(data.advanced).toBe(true);
    expect(data.currentPhase).toBe(1);
  });

  it("all_resolved gate: satisfied when all tasks FAILED (all resolved)", async () => {
    const wfResult = await exec({
      action: "create",
      project_id: PROJECT,
      name: "WF All Failed",
      phases: [{ name: "Phase 1", gate_condition: "all_resolved" }, { name: "Phase 2" }],
    });
    const wf = parseResult(wfResult).workflow;

    const taskA = createTask({ projectId: PROJECT, title: "Task A", createdBy: "test" }, db);
    const taskB = createTask({ projectId: PROJECT, title: "Task B", createdBy: "test" }, db);
    await exec({ action: "add_task", project_id: PROJECT, workflow_id: wf.id, phase: 0, task_id: taskA.id });
    await exec({ action: "add_task", project_id: PROJECT, workflow_id: wf.id, phase: 0, task_id: taskB.id });

    // Fail both tasks
    transitionTask({ projectId: PROJECT, taskId: taskA.id, toState: "ASSIGNED", actor: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: taskA.id, toState: "FAILED", actor: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: taskB.id, toState: "ASSIGNED", actor: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: taskB.id, toState: "FAILED", actor: "a" }, db);

    // Gate should be satisfied — all tasks reached terminal state
    const advResult = await exec({ action: "advance", project_id: PROJECT, workflow_id: wf.id });
    const data = parseResult(advResult);
    expect(data.ok).toBe(true);
    expect(data.advanced).toBe(true);
    expect(data.currentPhase).toBe(1);
  });

  it("any_resolved gate: satisfied when one task is DONE", async () => {
    const wfResult = await exec({
      action: "create",
      project_id: PROJECT,
      name: "WF Any Resolved",
      phases: [{ name: "Phase 1", gate_condition: "any_resolved" }, { name: "Phase 2" }],
    });
    const wf = parseResult(wfResult).workflow;

    const taskA = createTask({ projectId: PROJECT, title: "Task A", createdBy: "test" }, db);
    const taskB = createTask({ projectId: PROJECT, title: "Task B", createdBy: "test" }, db);
    await exec({ action: "add_task", project_id: PROJECT, workflow_id: wf.id, phase: 0, task_id: taskA.id });
    await exec({ action: "add_task", project_id: PROJECT, workflow_id: wf.id, phase: 0, task_id: taskB.id });

    // Complete taskA through lifecycle
    transitionTask({ projectId: PROJECT, taskId: taskA.id, toState: "ASSIGNED", actor: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: taskA.id, toState: "IN_PROGRESS", actor: "a" }, db);
    const { attachEvidence: attach } = await import("../../src/tasks/ops.js");
    attach({ projectId: PROJECT, taskId: taskA.id, type: "output", content: "done", attachedBy: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: taskA.id, toState: "REVIEW", actor: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: taskA.id, toState: "DONE", actor: "b", verificationRequired: false }, db);

    // taskB stays OPEN — but gate should still be satisfied
    const advResult = await exec({ action: "advance", project_id: PROJECT, workflow_id: wf.id });
    const data = parseResult(advResult);
    expect(data.ok).toBe(true);
    expect(data.advanced).toBe(true);
    expect(data.currentPhase).toBe(1);
  });

  it("all_done gate requires ALL tasks DONE (regression)", async () => {
    const wfResult = await exec({
      action: "create",
      project_id: PROJECT,
      name: "WF All Done Regression",
      phases: [{ name: "Phase 1", gate_condition: "all_done" }, { name: "Phase 2" }],
    });
    const wf = parseResult(wfResult).workflow;

    const taskA = createTask({ projectId: PROJECT, title: "Task A", createdBy: "test" }, db);
    const taskB = createTask({ projectId: PROJECT, title: "Task B", createdBy: "test" }, db);
    await exec({ action: "add_task", project_id: PROJECT, workflow_id: wf.id, phase: 0, task_id: taskA.id });
    await exec({ action: "add_task", project_id: PROJECT, workflow_id: wf.id, phase: 0, task_id: taskB.id });

    // Complete taskA through lifecycle
    transitionTask({ projectId: PROJECT, taskId: taskA.id, toState: "ASSIGNED", actor: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: taskA.id, toState: "IN_PROGRESS", actor: "a" }, db);
    const { attachEvidence: attach } = await import("../../src/tasks/ops.js");
    attach({ projectId: PROJECT, taskId: taskA.id, type: "output", content: "done", attachedBy: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: taskA.id, toState: "REVIEW", actor: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: taskA.id, toState: "DONE", actor: "b", verificationRequired: false }, db);

    // Fail taskB — gate should NOT be satisfied
    transitionTask({ projectId: PROJECT, taskId: taskB.id, toState: "ASSIGNED", actor: "a" }, db);
    transitionTask({ projectId: PROJECT, taskId: taskB.id, toState: "FAILED", actor: "a" }, db);

    const advResult = await exec({ action: "advance", project_id: PROJECT, workflow_id: wf.id });
    const data = parseResult(advResult);
    expect(data.ok).toBe(false);
  });
});
