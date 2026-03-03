import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { assembleContext } from "../../src/context/assembler.js";
import { buildInstructions } from "../../src/context/sources/instructions.js";
import { getMemoryDb, closeAllDbs } from "../../src/db.js";
import * as dbModule from "../../src/db.js";
import { createTask, transitionTask, attachEvidence } from "../../src/tasks/ops.js";
import { createWorkflow, addTaskToPhase } from "../../src/workflow.js";
import type { AgentConfig } from "../../src/types.js";

describe("buildInstructions", () => {
  it("generates enforcement instructions from required outputs", () => {
    const result = buildInstructions([
      { tool: "clawforce_task", action: ["transition", "fail"], min_calls: 1 },
      { tool: "clawforce_log", action: "write", min_calls: 1 },
    ]);

    expect(result).toContain("Your Responsibilities");
    expect(result).toContain("clawforce_task");
    expect(result).toContain("transition or fail");
    expect(result).toContain("clawforce_log");
    expect(result).toContain("write");
    expect(result).toContain("at least once");
    expect(result).toContain("required deliverables");
  });

  it("handles min_calls > 1", () => {
    const result = buildInstructions([
      { tool: "clawforce_log", action: "write", min_calls: 3 },
    ]);

    expect(result).toContain("at least 3 times");
  });

  it("returns empty string for no requirements", () => {
    expect(buildInstructions([])).toBe("");
  });

  it("handles single string action", () => {
    const result = buildInstructions([
      { tool: "clawforce_log", action: "outcome", min_calls: 1 },
    ]);

    expect(result).toContain("outcome");
    expect(result).not.toContain(" or ");
  });
});

describe("assembleContext", () => {
  it("assembles instructions + custom content", () => {
    const config: AgentConfig = {
      role: "orchestrator",
      briefing: [
        { source: "instructions" },
        { source: "custom", content: "You are the project orchestrator for my-project." },
      ],
      expectations: [
        { tool: "clawforce_task", action: ["propose"], min_calls: 1 },
        { tool: "clawforce_log", action: "write", min_calls: 1 },
      ],
      performance_policy: { action: "alert" },
    };

    const result = assembleContext("leon", config);

    expect(result).toContain("Your Responsibilities");
    expect(result).toContain("clawforce_task");
    expect(result).toContain("propose");
    expect(result).toContain("You are the project orchestrator");
  });

  it("returns only instructions when no custom context", () => {
    const config: AgentConfig = {
      role: "worker",
      briefing: [{ source: "instructions" }],
      expectations: [
        { tool: "clawforce_task", action: ["transition", "fail"], min_calls: 1 },
      ],
      performance_policy: { action: "retry", max_retries: 3 },
    };

    const result = assembleContext("coder", config);

    expect(result).toContain("Your Responsibilities");
    expect(result).toContain("transition or fail");
  });

  it("returns empty string when no sources produce content", () => {
    const config: AgentConfig = {
      role: "worker",
      briefing: [{ source: "project_md" }],
      expectations: [],
      performance_policy: { action: "alert" },
    };

    // No projectDir provided, so project_md returns null → empty
    const result = assembleContext("agent1", config);
    expect(result).toBe("");
  });

  it("skips sources that return null", () => {
    const config: AgentConfig = {
      role: "worker",
      briefing: [
        { source: "project_md" },  // no projectDir, returns null
        { source: "custom", content: "Hello" },
      ],
      expectations: [],
      performance_policy: { action: "alert" },
    };

    const result = assembleContext("agent1", config);
    expect(result).toBe("Hello");
    expect(result).not.toContain("null");
  });
});

describe("assembleContext — orchestrator sources", () => {
  let db: DatabaseSync;
  const PROJECT = "assembler-test";

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeAllDbs();
  });

  function makeConfig(sources: AgentConfig["briefing"]): AgentConfig {
    return {
      role: "orchestrator",
      briefing: sources,
      expectations: [],
      performance_policy: { action: "alert" },
    };
  }

  it("escalations source renders failed tasks that exhausted retries", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Failing migration",
      createdBy: "orch",
      assignedTo: "worker",
      maxRetries: 1,
    }, db);

    // ASSIGNED → IN_PROGRESS → REVIEW (with evidence) → FAILED → retry OPEN → ASSIGNED → IN_PROGRESS → REVIEW → FAILED (exhausted)
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "attempt 1", attachedBy: "worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "FAILED", actor: "verifier", reason: "bad" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "OPEN", actor: "orch" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "attempt 2", attachedBy: "worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "FAILED", actor: "verifier", reason: "still bad" }, db);

    const result = assembleContext("orch", makeConfig([{ source: "escalations" }]), { projectId: PROJECT });

    expect(result).toContain("Needs Your Attention");
    expect(result).toContain("Failing migration");
  });

  it("escalations source returns empty when no exhausted tasks", () => {
    createTask({ projectId: PROJECT, title: "Normal task", createdBy: "orch" }, db);

    const result = assembleContext("orch", makeConfig([{ source: "escalations" }]), { projectId: PROJECT });

    expect(result).toBe("");
  });

  it("workflows source renders active workflows", () => {
    const workflow = createWorkflow({
      projectId: PROJECT,
      name: "Deploy Pipeline",
      phases: [
        { name: "Build", gateCondition: "all_done" },
        { name: "Test", gateCondition: "all_done" },
      ],
      createdBy: "orch",
    }, db);

    const task = createTask({ projectId: PROJECT, title: "Build app", createdBy: "orch" }, db);
    addTaskToPhase({ projectId: PROJECT, workflowId: workflow.id, phase: 0, taskId: task.id }, db);

    const result = assembleContext("orch", makeConfig([{ source: "workflows" }]), { projectId: PROJECT });

    expect(result).toContain("Active Workflows");
    expect(result).toContain("Deploy Pipeline");
    expect(result).toContain("Build");
    expect(result).toContain("Test");
  });

  it("workflows source returns empty when no active workflows", () => {
    const result = assembleContext("orch", makeConfig([{ source: "workflows" }]), { projectId: PROJECT });
    expect(result).toBe("");
  });

  it("activity source renders recent transitions", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Some task",
      createdBy: "orch",
      assignedTo: "worker",
    }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "worker" }, db);

    const result = assembleContext("orch", makeConfig([{ source: "activity" }]), { projectId: PROJECT });

    expect(result).toContain("Recent Activity");
    expect(result).toContain("ASSIGNED→IN_PROGRESS");
    expect(result).toContain("worker");
  });

  it("activity source returns empty when no transitions", () => {
    const result = assembleContext("orch", makeConfig([{ source: "activity" }]), { projectId: PROJECT });
    expect(result).toBe("");
  });

  it("sweep_status source returns empty when no stale/urgent tasks", () => {
    createTask({ projectId: PROJECT, title: "Fresh task", createdBy: "orch" }, db);

    const result = assembleContext("orch", makeConfig([{ source: "sweep_status" }]), { projectId: PROJECT });

    // Fresh task is not stale, so sweep_status should return nothing
    expect(result).toBe("");
  });

  it("all orchestrator sources compose together", () => {
    // Create task + transition so activity source has data
    const task = createTask({
      projectId: PROJECT,
      title: "Compose test task",
      createdBy: "orch",
      assignedTo: "worker",
    }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "worker" }, db);

    const result = assembleContext("orch", makeConfig([
      { source: "task_board" },
      { source: "activity" },
    ]), { projectId: PROJECT });

    expect(result).toContain("Work Board");
    expect(result).toContain("Recent Activity");
    expect(result).toContain("Compose test task");
  });

  it("task_board includes summary counts line", () => {
    createTask({ projectId: PROJECT, title: "Open task", createdBy: "orch" }, db);
    const assigned = createTask({ projectId: PROJECT, title: "Assigned task", createdBy: "orch", assignedTo: "worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: assigned.id, toState: "IN_PROGRESS", actor: "worker" }, db);

    const result = assembleContext("orch", makeConfig([{ source: "task_board" }]), { projectId: PROJECT });

    expect(result).toContain("**Total:**");
    expect(result).toContain("OPEN: 1");
    expect(result).toContain("IN_PROGRESS: 1");
  });

  it("task_board shows FAILED tasks (not just active)", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Failed task visible",
      createdBy: "orch",
      assignedTo: "worker",
      maxRetries: 0,
    }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "x", attachedBy: "worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "FAILED", actor: "verifier", reason: "bad" }, db);

    const result = assembleContext("orch", makeConfig([{ source: "task_board" }]), { projectId: PROJECT });

    expect(result).toContain("Failed task visible");
    expect(result).toContain("FAILED");
  });

  it("escalations source includes failure reason", () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Failing with reason",
      createdBy: "orch",
      assignedTo: "worker",
      maxRetries: 0,
    }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "IN_PROGRESS", actor: "worker" }, db);
    attachEvidence({ projectId: PROJECT, taskId: task.id, type: "output", content: "x", attachedBy: "worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "REVIEW", actor: "worker" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "FAILED", actor: "verifier", reason: "API rate limited" }, db);

    const result = assembleContext("orch", makeConfig([{ source: "escalations" }]), { projectId: PROJECT });

    expect(result).toContain("Needs Your Attention");
    expect(result).toContain("Failing with reason");
    expect(result).toContain("API rate limited");
  });

  it("workflows source includes gate conditions", () => {
    const workflow = createWorkflow({
      projectId: PROJECT,
      name: "Release Flow",
      phases: [
        { name: "Build", gateCondition: "all_done" },
        { name: "Deploy", gateCondition: "any_done" },
      ],
      createdBy: "orch",
    }, db);

    const task = createTask({ projectId: PROJECT, title: "Build step", createdBy: "orch" }, db);
    addTaskToPhase({ projectId: PROJECT, workflowId: workflow.id, phase: 0, taskId: task.id }, db);

    const result = assembleContext("orch", makeConfig([{ source: "workflows" }]), { projectId: PROJECT });

    expect(result).toContain("gate: all_done");
    expect(result).toContain("gate: any_done");
  });

  it("proposals source renders pending proposals", () => {
    // Insert a pending proposal directly
    db.prepare(
      "INSERT INTO proposals (id, project_id, title, description, proposed_by, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("prop-001", PROJECT, "Add caching layer", "Redis-based caching for API", "orch", "pending", Date.now());

    const result = assembleContext("orch", makeConfig([{ source: "proposals" }]), { projectId: PROJECT });

    expect(result).toContain("Pending Proposals");
    expect(result).toContain("Add caching layer");
    expect(result).toContain("orch");
    expect(result).toContain("Redis-based caching");
  });

  it("proposals source returns empty when no pending proposals", () => {
    const result = assembleContext("orch", makeConfig([{ source: "proposals" }]), { projectId: PROJECT });
    expect(result).toBe("");
  });

  it("proposals source excludes resolved proposals", () => {
    db.prepare(
      "INSERT INTO proposals (id, project_id, title, proposed_by, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("prop-002", PROJECT, "Approved proposal", "orch", "approved", Date.now() - 10000, Date.now());

    const result = assembleContext("orch", makeConfig([{ source: "proposals" }]), { projectId: PROJECT });
    expect(result).toBe("");
  });

  it("budgetChars truncates long context", () => {
    // Create many tasks to generate a large context
    for (let i = 0; i < 30; i++) {
      createTask({ projectId: PROJECT, title: `Long title task number ${i} with extra words`, createdBy: "orch" }, db);
    }

    const result = assembleContext("orch", makeConfig([{ source: "task_board" }]), {
      projectId: PROJECT,
      budgetChars: 500,
    });

    expect(result.length).toBeLessThanOrEqual(500);
    expect(result).toContain("[...truncated]");
  });

  it("budgetChars defaults to 15K (no truncation for small context)", () => {
    createTask({ projectId: PROJECT, title: "Small task", createdBy: "orch" }, db);

    const result = assembleContext("orch", makeConfig([{ source: "task_board" }]), { projectId: PROJECT });

    expect(result).not.toContain("[...truncated]");
    expect(result.length).toBeLessThan(15_000);
  });
});
