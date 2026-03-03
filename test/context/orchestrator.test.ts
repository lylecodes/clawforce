/**
 * Tests for the orchestrator layer:
 * - orchestrator-config.ts
 * - context render functions (builder.ts)
 * - orchestrator-cron.ts
 * - worker-context.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { getMemoryDb, closeAllDbs } from "../../src/db.js";
import { createTask, transitionTask, attachEvidence } from "../../src/tasks/ops.js";
import { createWorkflow, addTaskToPhase } from "../../src/workflow.js";
import {
  registerManagerProject,
  getManagerForAgent,
  isManagerSession,
  unregisterManagerProject,
  resetManagerConfigForTest,
} from "../../src/manager-config.js";
import type { ManagerSettings } from "../../src/manager-config.js";
import {
  renderTaskBoard,
  renderEscalations,
  renderWorkflows,
  renderRecentActivity,
  renderSweepStatus,
  type ContextSnapshot,
} from "../../src/context/builder.js";
import { buildManagerCronJob, parseScheduleMs, toCronJobCreate } from "../../src/manager-cron.js";
import { buildWorkerContext } from "../../src/context/worker.js";
import {
  registerWorkerAssignment,
  getWorkerAssignment,
  clearWorkerAssignment,
  resetWorkerRegistryForTest,
} from "../../src/worker-registry.js";
import {
  trackWorkerSession,
  markWorkerCompliant,
  resetWorkerComplianceForTest,
} from "../../src/tasks/compliance.js";
import { handleWorkerSessionEnd } from "../../src/tasks/session-end.js";
import { getTask, getTaskEvidence } from "../../src/tasks/ops.js";

describe("orchestrator-config", () => {
  beforeEach(() => resetManagerConfigForTest());
  afterEach(() => resetManagerConfigForTest());

  const settings: ManagerSettings = {
    enabled: true,
    agentId: "my-project",
    directives: ["Always check tasks first"],
    contextBudgetChars: 10000,
  };

  test("register and lookup by agentId", () => {
    registerManagerProject("proj1", settings);
    const entry = getManagerForAgent("my-project");
    expect(entry).not.toBeNull();
    expect(entry!.projectId).toBe("proj1");
    expect(entry!.settings.directives).toEqual(["Always check tasks first"]);
  });

  test("isManagerSession returns true for registered agent", () => {
    registerManagerProject("proj1", settings);
    expect(isManagerSession("my-project")).toBe(true);
    expect(isManagerSession("unknown")).toBe(false);
    expect(isManagerSession(undefined)).toBe(false);
  });

  test("disabled settings are not registered", () => {
    registerManagerProject("proj1", { ...settings, enabled: false });
    expect(getManagerForAgent("my-project")).toBeNull();
  });

  test("unregister removes entry", () => {
    registerManagerProject("proj1", settings);
    expect(isManagerSession("my-project")).toBe(true);
    unregisterManagerProject("my-project");
    expect(isManagerSession("my-project")).toBe(false);
  });
});

describe("context render functions", () => {
  let db: DatabaseSync;

  function emptySnapshot(): ContextSnapshot {
    return { openCount: 0, assignedCount: 0, inProgressCount: 0, reviewCount: 0, blockedCount: 0, failedCount: 0, doneCount: 0, escalationCount: 0, activeWorkflows: 0 };
  }

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    closeAllDbs();
  });

  test("renderTaskBoard shows counts and task lines", () => {
    createTask({ projectId: "test", title: "Task A", createdBy: "agent1" }, db);
    createTask({ projectId: "test", title: "Task B", createdBy: "agent1", assignedTo: "agent2" }, db);

    const snapshot = emptySnapshot();
    const result = renderTaskBoard(db, "test", 25, snapshot);

    expect(result).toContain("## Work Board");
    expect(result).toContain("Task A");
    expect(result).toContain("Task B");
    expect(snapshot.openCount).toBe(1);
    expect(snapshot.assignedCount).toBe(1);
  });

  test("renderTaskBoard empty project shows zero counts", () => {
    const snapshot = emptySnapshot();
    const result = renderTaskBoard(db, "test", 25, snapshot);

    expect(result).toContain("## Work Board");
    expect(result).toContain("**Total:** 0");
    expect(snapshot.openCount).toBe(0);
  });

  test("renderEscalations includes failure reason from transitions", () => {
    const task = createTask({
      projectId: "test",
      title: "Failing task",
      createdBy: "agent1",
      assignedTo: "agent2",
      maxRetries: 1,
    }, db);

    transitionTask({ projectId: "test", taskId: task.id, toState: "IN_PROGRESS", actor: "agent2" }, db);
    attachEvidence({ projectId: "test", taskId: task.id, type: "output", content: "attempt 1", attachedBy: "agent2" }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "REVIEW", actor: "agent2" }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "FAILED", actor: "verifier", reason: "bad" }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "OPEN", actor: "agent1" }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "ASSIGNED", actor: "agent2" }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "IN_PROGRESS", actor: "agent2" }, db);
    attachEvidence({ projectId: "test", taskId: task.id, type: "output", content: "attempt 2", attachedBy: "agent2" }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "REVIEW", actor: "agent2" }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "FAILED", actor: "verifier", reason: "still bad" }, db);

    const snapshot = emptySnapshot();
    const result = renderEscalations(db, "test", 25, snapshot);

    expect(result).not.toBeNull();
    expect(result).toContain("Needs Your Attention");
    expect(result).toContain("Failing task");
    expect(result).toContain("still bad");
    expect(snapshot.escalationCount).toBeGreaterThan(0);
  });

  test("renderEscalations returns null when no exhausted tasks", () => {
    createTask({ projectId: "test", title: "Normal task", createdBy: "agent1" }, db);
    expect(renderEscalations(db, "test", 25)).toBeNull();
  });

  test("renderWorkflows shows phase progress with gate conditions", () => {
    const workflow = createWorkflow({
      projectId: "test",
      name: "Deploy Pipeline",
      phases: [
        { name: "Build", gateCondition: "all_done" },
        { name: "Test", gateCondition: "any_done" },
      ],
      createdBy: "agent1",
    }, db);

    const task = createTask({ projectId: "test", title: "Build app", createdBy: "agent1" }, db);
    addTaskToPhase({ projectId: "test", workflowId: workflow.id, phase: 0, taskId: task.id }, db);

    const snapshot = emptySnapshot();
    const result = renderWorkflows(db, "test", snapshot);

    expect(result).not.toBeNull();
    expect(result).toContain("Active Workflows");
    expect(result).toContain("Deploy Pipeline");
    expect(result).toContain("gate: all_done");
    expect(result).toContain("gate: any_done");
    expect(snapshot.activeWorkflows).toBe(1);
  });

  test("renderWorkflows returns null when no active workflows", () => {
    expect(renderWorkflows(db, "test")).toBeNull();
  });

  test("renderRecentActivity shows transitions", () => {
    const task = createTask({
      projectId: "test",
      title: "Some task",
      createdBy: "agent1",
      assignedTo: "agent2",
    }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "IN_PROGRESS", actor: "agent2" }, db);

    const result = renderRecentActivity(db, "test", 20);

    expect(result).not.toBeNull();
    expect(result).toContain("Recent Activity");
    expect(result).toContain("ASSIGNED→IN_PROGRESS");
  });

  test("renderRecentActivity returns null when no transitions", () => {
    expect(renderRecentActivity(db, "test", 20)).toBeNull();
  });

  test("renderTaskBoard shows BLOCKED tasks with blocking reason", () => {
    const task = createTask({
      projectId: "test",
      title: "Blocked task",
      createdBy: "agent1",
      assignedTo: "agent2",
    }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "IN_PROGRESS", actor: "agent2" }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "BLOCKED", actor: "agent2", reason: "Waiting for API key" }, db);

    const result = renderTaskBoard(db, "test", 25);

    expect(result).toContain("Blocked task");
    expect(result).toContain('blocked: "Waiting for API key"');
  });

  test("renderSweepStatus lists stale task details", () => {
    const staleTime = Date.now() - 3 * 60 * 60 * 1000; // 3 hours ago
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("stale-001", "test", "Stale investigation", "IN_PROGRESS", "P1", "agent1", staleTime, staleTime, 0, 3);

    const result = renderSweepStatus(db, "test");

    expect(result).not.toBeNull();
    expect(result).toContain("Operations Status");
    expect(result).toContain("stale-00");
    expect(result).toContain("Stale investigation");
    expect(result).toContain("IN_PROGRESS");
  });

  test("renderSweepStatus returns null when no issues", () => {
    createTask({ projectId: "test", title: "Fresh task", createdBy: "agent1" }, db);
    expect(renderSweepStatus(db, "test")).toBeNull();
  });
});

describe("orchestrator-cron", () => {
  test("builds cron job with nudge payload", () => {
    const job = buildManagerCronJob("myproject", "myproject-agent", "every:300000");
    expect(job.name).toBe("manager-myproject");
    expect(job.schedule).toBe("every:300000");
    expect(job.agentId).toBe("myproject-agent");
    expect(job.payload).toContain("manager");
    expect(job.payload).toContain("Handle pending escalations");
    expect(job.payload).toContain("Assign OPEN tasks");
  });

  test("parseScheduleMs handles duration shorthands", () => {
    expect(parseScheduleMs("30s")).toBe(30_000);
    expect(parseScheduleMs("5m")).toBe(300_000);
    expect(parseScheduleMs("1h")).toBe(3_600_000);
    expect(parseScheduleMs("1d")).toBe(86_400_000);
  });

  test("parseScheduleMs handles raw milliseconds", () => {
    expect(parseScheduleMs("300000")).toBe(300_000);
    expect(parseScheduleMs("60000")).toBe(60_000);
  });

  test("parseScheduleMs handles every:N format", () => {
    expect(parseScheduleMs("every:300000")).toBe(300_000);
    expect(parseScheduleMs("every:60000")).toBe(60_000);
  });

  test("parseScheduleMs falls back to 5m for unrecognized format", () => {
    expect(parseScheduleMs("garbage")).toBe(300_000);
    expect(parseScheduleMs("")).toBe(300_000);
    expect(parseScheduleMs("cron:* * * * *")).toBe(300_000);
  });

  test("toCronJobCreate produces valid cron job shape", () => {
    const job = buildManagerCronJob("proj", "agent-1", "10m");
    const create = toCronJobCreate(job);

    expect(create.name).toBe("manager-proj");
    expect(create.agentId).toBe("agent-1");
    expect(create.enabled).toBe(true);
    expect(create.schedule).toEqual({ kind: "every", everyMs: 600_000 });
    expect(create.sessionTarget).toBe("isolated");
    expect(create.wakeMode).toBe("now");
    expect(create.payload.kind).toBe("agentTurn");
    expect(create.payload.message).toContain("manager");
  });
});

describe("worker-registry", () => {
  beforeEach(() => resetWorkerRegistryForTest());
  afterEach(() => resetWorkerRegistryForTest());

  test("register and lookup assignment", () => {
    registerWorkerAssignment("agent:worker-1", "proj1", "task-abc");
    const assignment = getWorkerAssignment("agent:worker-1");
    expect(assignment).not.toBeNull();
    expect(assignment!.projectId).toBe("proj1");
    expect(assignment!.taskId).toBe("task-abc");
  });

  test("returns null for unregistered agent", () => {
    expect(getWorkerAssignment("agent:unknown")).toBeNull();
  });

  test("clear removes assignment", () => {
    registerWorkerAssignment("agent:worker-1", "proj1", "task-abc");
    clearWorkerAssignment("agent:worker-1");
    expect(getWorkerAssignment("agent:worker-1")).toBeNull();
  });

  test("overwrites previous assignment", () => {
    registerWorkerAssignment("agent:worker-1", "proj1", "task-1");
    registerWorkerAssignment("agent:worker-1", "proj1", "task-2");
    expect(getWorkerAssignment("agent:worker-1")!.taskId).toBe("task-2");
  });
});

describe("worker-context", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    closeAllDbs();
  });

  test("builds focused context for a task", () => {
    const task = createTask({
      projectId: "test",
      title: "Fix the login bug",
      description: "Users can't log in when password contains special chars",
      priority: "P1",
      createdBy: "orchestrator",
      assignedTo: "worker1",
      tags: ["frontend", "auth"],
    }, db);

    const result = buildWorkerContext({
      projectId: "test",
      taskId: task.id,
      instructions: "Fix the login validation to handle special characters",
      dbOverride: db,
    });

    expect(result).not.toBeNull();
    expect(result!.prompt).toContain("Fix the login bug");
    expect(result!.prompt).toContain("special chars");
    expect(result!.prompt).toContain("Fix the login validation");
    expect(result!.prompt).toContain("frontend, auth");
    expect(result!.prompt).toContain("P1");
    expect(result!.task.id).toBe(task.id);
  });

  test("returns null for missing task", () => {
    const result = buildWorkerContext({
      projectId: "test",
      taskId: "nonexistent",
      instructions: "Do something",
      dbOverride: db,
    });
    expect(result).toBeNull();
  });

  test("includes evidence from prior work", () => {
    const task = createTask({
      projectId: "test",
      title: "Build feature",
      createdBy: "orchestrator",
      assignedTo: "worker1",
    }, db);

    attachEvidence({
      projectId: "test",
      taskId: task.id,
      type: "output",
      content: "Initial analysis output here",
      attachedBy: "worker1",
    }, db);

    const result = buildWorkerContext({
      projectId: "test",
      taskId: task.id,
      instructions: "Continue building the feature",
      dbOverride: db,
    });

    expect(result).not.toBeNull();
    expect(result!.prompt).toContain("Initial analysis output here");
    expect(result!.evidence.length).toBe(1);
  });

  test("includes completion requirements", () => {
    const task = createTask({
      projectId: "test",
      title: "Some task",
      createdBy: "orchestrator",
    }, db);

    const result = buildWorkerContext({
      projectId: "test",
      taskId: task.id,
      instructions: "Do the thing",
      dbOverride: db,
    });

    expect(result!.prompt).toContain("attach_evidence");
    expect(result!.prompt).toContain("REVIEW");
    expect(result!.prompt).toContain("BLOCKED");
  });
});

describe("worker-session-end", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    resetWorkerComplianceForTest();
  });

  afterEach(() => {
    closeAllDbs();
    resetWorkerComplianceForTest();
  });

  test("attaches evidence and transitions to FAILED on error", () => {
    const task = createTask({
      projectId: "test",
      title: "LinkedIn outreach",
      createdBy: "orchestrator",
      assignedTo: "worker1",
    }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "IN_PROGRESS", actor: "worker1" }, db);

    trackWorkerSession("session-1", "test", task.id);

    const acted = handleWorkerSessionEnd({
      sessionKey: "session-1",
      status: "error",
      error: "Browser tool crashed: page not found",
      summary: "Failed during LinkedIn login step",
      dbOverride: db,
    });

    expect(acted).toBe(true);

    const updated = getTask("test", task.id, db);
    expect(updated!.state).toBe("FAILED");

    const evidence = getTaskEvidence("test", task.id, db);
    expect(evidence.length).toBe(1);
    expect(evidence[0]!.content).toContain("Browser tool crashed");
    expect(evidence[0]!.content).toContain("LinkedIn login step");
  });

  test("no-op on compliant worker", () => {
    const task = createTask({
      projectId: "test",
      title: "Some task",
      createdBy: "orchestrator",
      assignedTo: "worker1",
    }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "IN_PROGRESS", actor: "worker1" }, db);

    trackWorkerSession("session-2", "test", task.id);
    markWorkerCompliant("session-2");

    const acted = handleWorkerSessionEnd({
      sessionKey: "session-2",
      status: "ok",
      dbOverride: db,
    });

    expect(acted).toBe(false);
    const updated = getTask("test", task.id, db);
    expect(updated!.state).toBe("IN_PROGRESS");
  });

  test("no-op when task already DONE", () => {
    const task = createTask({
      projectId: "test",
      title: "Completed task",
      createdBy: "orchestrator",
      assignedTo: "worker1",
    }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "IN_PROGRESS", actor: "worker1" }, db);
    attachEvidence({ projectId: "test", taskId: task.id, type: "output", content: "done", attachedBy: "worker1" }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "REVIEW", actor: "worker1" }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "DONE", actor: "verifier" }, db);

    trackWorkerSession("session-3", "test", task.id);

    const acted = handleWorkerSessionEnd({
      sessionKey: "session-3",
      status: "ok",
      dbOverride: db,
    });

    expect(acted).toBe(false);
    const updated = getTask("test", task.id, db);
    expect(updated!.state).toBe("DONE");
  });

  test("handles timeout status", () => {
    const task = createTask({
      projectId: "test",
      title: "Timeout task",
      createdBy: "orchestrator",
      assignedTo: "worker1",
    }, db);
    transitionTask({ projectId: "test", taskId: task.id, toState: "IN_PROGRESS", actor: "worker1" }, db);

    trackWorkerSession("session-4", "test", task.id);

    const acted = handleWorkerSessionEnd({
      sessionKey: "session-4",
      status: "timeout",
      dbOverride: db,
    });

    expect(acted).toBe(true);
    const updated = getTask("test", task.id, db);
    expect(updated!.state).toBe("FAILED");

    const evidence = getTaskEvidence("test", task.id, db);
    expect(evidence[0]!.content).toContain("timeout");
  });

  test("no-op for untracked session", () => {
    const acted = handleWorkerSessionEnd({
      sessionKey: "untracked",
      status: "error",
      error: "something broke",
      dbOverride: db,
    });
    expect(acted).toBe(false);
  });
});
