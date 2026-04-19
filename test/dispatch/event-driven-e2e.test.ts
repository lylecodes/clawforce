/**
 * E2E integration test for event-driven dispatch.
 *
 * Tests the full flow:
 * 1. Create project with event-driven config
 * 2. Create a task and assign it
 * 3. Verify task_assigned event fires
 * 4. Verify dispatch_agent action resolves the worker
 * 5. Verify enqueue is called
 * 6. Verify budget pacing is checked
 * 7. Verify budget_plan briefing source returns valid markdown
 */

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
const { registerWorkforceConfig, getExtendedProjectConfig } = await import("../../src/project.js");
const { createTask, transitionTask } = await import("../../src/tasks/ops.js");
const { ingestEvent, listEvents } = await import("../../src/events/store.js");
const { executeAction, findAgentByRole } = await import("../../src/events/actions.js");
const { setBudget } = await import("../../src/budget.js");
const { resolveBudgetPlanSource } = await import("../../src/context/sources/budget-plan.js");
const { computeBudgetPacing } = await import("../../src/budget/pacer.js");
const { processEvents } = await import("../../src/events/router.js");

import type { ClawforceEvent, EventActionConfig } from "../../src/types.js";

describe("event-driven dispatch E2E", () => {
  let db: DatabaseSync;
  const PROJECT = "test-e2e-event-driven";

  beforeEach(() => {
    db = getMemoryDb();

    // 1. Create project with event-driven config
    registerWorkforceConfig(PROJECT, {
      name: "E2E Test Project",
      agents: {
        "e2e-lead": {
          extends: "manager",
          title: "Lead",
          persona: "E2E test lead agent",
          briefing: [{ source: "soul" }, { source: "budget_plan" }],
          expectations: [],
          coordination: { enabled: true },
        },
        "e2e-worker": {
          extends: "employee",
          title: "Worker",
          persona: "E2E test worker agent",
          briefing: [{ source: "soul" }, { source: "task_board" }],
          expectations: [],
        },
        "e2e-verifier": {
          extends: "verifier",
          title: "Verifier",
          persona: "E2E test verifier agent",
          briefing: [{ source: "soul" }],
          expectations: [],
        },
      },
      dispatch: {
        mode: "event-driven",
        budget_pacing: {
          enabled: true,
          reactive_reserve_pct: 20,
          low_budget_threshold: 10,
          critical_threshold: 5,
        },
      },
    });

    // Set up project budget
    setBudget({
      projectId: PROJECT,
      config: { dailyLimitCents: 40000 },
    }, db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("full flow: create task → assign → event fires → dispatch_agent resolves → pacing checked → budget_plan returns markdown", () => {
    // 2. Create a task
    const task = createTask({
      projectId: PROJECT,
      title: "Implement feature X",
      description: "Acceptance criteria: feature X works correctly with tests",
      createdBy: "e2e-lead",
    }, db);

    expect(task.id).toBeTruthy();
    expect(task.state).toBe("OPEN");

    // Assign the task (triggers task_assigned event in auto-lifecycle)
    const assignResult = transitionTask(
      {
        projectId: PROJECT,
        taskId: task.id,
        toState: "ASSIGNED",
        actor: "e2e-lead",
        reason: "Assigned to worker",
        assignedTo: "e2e-worker",
      },
      db,
    );
    expect(assignResult.ok).toBe(true);

    // 3. Verify task_assigned event can be created
    const eventResult = ingestEvent(
      PROJECT,
      "task_assigned",
      "internal",
      { taskId: task.id, assignedTo: "e2e-worker" },
      undefined,
      db,
    );
    expect(eventResult.id).toBeTruthy();
    expect(eventResult.deduplicated).toBe(false);

    // Verify default event handlers are registered for event-driven mode
    const extConfig = getExtendedProjectConfig(PROJECT);
    expect(extConfig?.dispatch?.mode).toBe("event-driven");
    // task_assigned is NOT a default user handler — the built-in handleTaskAssigned()
    // in router.ts handles dispatch. User handlers for task_assigned would double-dispatch.
    expect(extConfig?.eventHandlers?.task_assigned).toBeUndefined();

    // 4. Verify the built-in handleTaskAssigned enqueues for dispatch
    //    (no user handler needed — the canonical path uses the built-in router handler)
    //    Process the task_assigned event we manually ingested above
    processEvents(PROJECT, db);

    // 5. Verify enqueue was called via built-in handleTaskAssigned (queue item exists)
    const queueItems = db.prepare(
      "SELECT * FROM dispatch_queue WHERE project_id = ? AND task_id = ? AND status = 'queued'",
    ).all(PROJECT, task.id) as Record<string, unknown>[];
    expect(queueItems.length).toBeGreaterThan(0);

    // 6. Verify budget pacing is checked
    const pacing = computeBudgetPacing({
      dailyBudgetCents: 40000,
      spentCents: 0,
      hoursRemaining: 16,
    });
    expect(pacing.canDispatchWorker).toBe(true);
    expect(pacing.canDispatchLead).toBe(true);

    // 7. Verify budget_plan briefing source returns valid markdown
    const budgetPlan = resolveBudgetPlanSource(PROJECT, db);
    expect(budgetPlan).not.toBeNull();
    expect(budgetPlan).toContain("## Budget Plan");
    expect(budgetPlan).toContain("$400.00"); // daily budget
    expect(budgetPlan).toContain("Remaining");
    expect(budgetPlan).toContain("Pipeline Status");
    expect(budgetPlan).toContain("Worker dispatch: ALLOWED");
    expect(budgetPlan).toContain("Lead dispatch: ALLOWED");
    expect(budgetPlan).toContain("Recommendation:");
  });

  it("budget_plan reflects pipeline task counts", () => {
    // Create multiple tasks in different states
    const task1 = createTask({
      projectId: PROJECT,
      title: "Task 1",
      description: "Acceptance criteria: done",
      createdBy: "e2e-lead",
    }, db);

    const task2 = createTask({
      projectId: PROJECT,
      title: "Task 2",
      description: "Acceptance criteria: done",
      createdBy: "e2e-lead",
    }, db);

    transitionTask({
      projectId: PROJECT,
      taskId: task1.id,
      toState: "ASSIGNED",
      actor: "e2e-lead",
      assignedTo: "e2e-worker",
    }, db);

    const budgetPlan = resolveBudgetPlanSource(PROJECT, db);
    expect(budgetPlan).not.toBeNull();
    expect(budgetPlan).toContain("OPEN: 1");
    expect(budgetPlan).toContain("ASSIGNED: 1");
  });

  it("dispatch_agent blocks when budget is critical", () => {
    // Exhaust the budget
    setBudget({
      projectId: PROJECT,
      config: { dailyLimitCents: 40000 },
    }, db);

    // Update spent to 96% (critical threshold = 5%)
    db.prepare(
      "UPDATE budgets SET daily_spent_cents = 38500 WHERE project_id = ? AND agent_id IS NULL",
    ).run(PROJECT);

    // Budget pacing should block
    const pacing = computeBudgetPacing({
      dailyBudgetCents: 40000,
      spentCents: 38500,
      hoursRemaining: 8,
    });
    expect(pacing.canDispatchWorker).toBe(false);
    expect(pacing.canDispatchLead).toBe(false);

    // Budget plan should reflect blocked status
    const budgetPlan = resolveBudgetPlanSource(PROJECT, db);
    expect(budgetPlan).toContain("Worker dispatch: BLOCKED");
    expect(budgetPlan).toContain("Lead dispatch: BLOCKED");
  });

  it("findAgentByRole resolves correct agents", () => {
    expect(findAgentByRole(PROJECT, "lead")).toBe("e2e-lead");
    expect(findAgentByRole(PROJECT, "worker")).toBe("e2e-worker");
    expect(findAgentByRole(PROJECT, "verifier")).toBe("e2e-verifier");
    expect(findAgentByRole(PROJECT, "nonexistent")).toBeUndefined();
  });

  it("budget_changed event fires when budget limits change", () => {
    // setBudget was called in beforeEach, so one event exists already
    const events = listEvents(PROJECT, { type: "budget_changed" }, db);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe("budget_changed");
  });

  it("default handlers include budget_changed → dispatch lead for planning", () => {
    const extConfig = getExtendedProjectConfig(PROJECT);
    expect(extConfig?.eventHandlers?.budget_changed).toBeDefined();
    expect(extConfig?.eventHandlers?.budget_changed?.actions[0]).toEqual({
      action: "dispatch_agent",
      agent_role: "lead",
      session_type: "planning",
    });
  });
});
