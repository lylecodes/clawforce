import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { createTask } = await import("../../src/tasks/ops.js");
const {
  detectProjectCompletion,
  handleWorkflowCompletion,
  handleGoalAchieved,
} = await import("../../src/planning/completion.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-completion";

function createGoal(title: string, opts?: { parentGoalId?: string; acceptanceCriteria?: string; status?: string }) {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO goals (id, project_id, title, status, parent_goal_id, acceptance_criteria, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, PROJECT, title, opts?.status ?? "active", opts?.parentGoalId ?? null, opts?.acceptanceCriteria ?? null, "agent:test", now);
  return { id, title };
}

function createWorkflow(name: string, taskIds: string[]) {
  const id = crypto.randomUUID();
  const phases = [{ name: "phase-1", taskIds, gateCondition: "all_done" }];
  db.prepare(`
    INSERT INTO workflows (id, project_id, name, phases, current_phase, state, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 'active', 'agent:test', ?, ?)
  `).run(id, PROJECT, name, JSON.stringify(phases), Date.now(), Date.now());
  return { id, name };
}

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("detectProjectCompletion", () => {
  it("returns incomplete when no goals exist", () => {
    const status = detectProjectCompletion(PROJECT, db);
    expect(status.isComplete).toBe(false);
    expect(status.topLevelGoals.total).toBe(0);
  });

  it("returns incomplete when active goals remain", () => {
    createGoal("Goal 1");
    createGoal("Goal 2", { status: "achieved" });

    const status = detectProjectCompletion(PROJECT, db);
    expect(status.isComplete).toBe(false);
    expect(status.topLevelGoals.active).toBe(1);
  });

  it("returns complete when all top-level goals achieved", () => {
    createGoal("Goal 1", { status: "achieved" });
    createGoal("Goal 2", { status: "achieved" });

    const status = detectProjectCompletion(PROJECT, db);
    expect(status.isComplete).toBe(true);
    expect(status.topLevelGoals.achieved).toBe(2);
  });

  it("returns complete when mix of achieved and abandoned (at least one achieved)", () => {
    createGoal("Goal 1", { status: "achieved" });
    createGoal("Goal 2", { status: "abandoned" });

    const status = detectProjectCompletion(PROJECT, db);
    expect(status.isComplete).toBe(true);
  });

  it("returns incomplete when all abandoned (no achieved)", () => {
    createGoal("Goal 1", { status: "abandoned" });

    const status = detectProjectCompletion(PROJECT, db);
    expect(status.isComplete).toBe(false);
  });

  it("ignores child goals (only checks top-level)", () => {
    const parent = createGoal("Parent", { status: "achieved" });
    createGoal("Child", { parentGoalId: parent.id }); // still active

    const status = detectProjectCompletion(PROJECT, db);
    expect(status.isComplete).toBe(true); // child doesn't count as top-level
  });

  it("returns incomplete when active workflows exist", () => {
    createGoal("Goal 1", { status: "achieved" });
    const task = createTask({ projectId: PROJECT, title: "t", createdBy: "test" }, db);
    createWorkflow("wf-1", [task.id]);

    const status = detectProjectCompletion(PROJECT, db);
    expect(status.isComplete).toBe(false);
    expect(status.activeWorkflows).toBe(1);
  });
});

describe("handleWorkflowCompletion", () => {
  it("creates verification task when goal has acceptance criteria", () => {
    const goal = createGoal("Ship v2", { acceptanceCriteria: "All tests pass\nDocs updated" });
    const task = createTask({ projectId: PROJECT, title: "Build v2", createdBy: "agent:worker" }, db);

    // Link task to goal and workflow
    db.prepare("UPDATE tasks SET goal_id = ? WHERE id = ?").run(goal.id, task.id);
    const wf = createWorkflow("v2-workflow", [task.id]);
    db.prepare("UPDATE tasks SET workflow_id = ? WHERE id = ?").run(wf.id, task.id);

    const verificationIds = handleWorkflowCompletion(PROJECT, wf.id, db);
    expect(verificationIds).toHaveLength(1);

    // Check verification task was created
    const verTask = db.prepare("SELECT title, description, goal_id FROM tasks WHERE id = ?")
      .get(verificationIds[0]) as Record<string, unknown>;
    expect(verTask.title).toContain("Verify");
    expect(verTask.description).toContain("All tests pass");
    expect(verTask.goal_id).toBe(goal.id);
  });

  it("skips goals without acceptance criteria", () => {
    const goal = createGoal("Ship v2"); // no criteria
    const task = createTask({ projectId: PROJECT, title: "Build v2", createdBy: "agent:worker" }, db);
    db.prepare("UPDATE tasks SET goal_id = ? WHERE id = ?").run(goal.id, task.id);
    const wf = createWorkflow("v2-workflow", [task.id]);
    db.prepare("UPDATE tasks SET workflow_id = ? WHERE id = ?").run(wf.id, task.id);

    const verificationIds = handleWorkflowCompletion(PROJECT, wf.id, db);
    expect(verificationIds).toHaveLength(0);
  });

  it("skips already achieved goals", () => {
    const goal = createGoal("Done goal", { status: "achieved", acceptanceCriteria: "Check" });
    const task = createTask({ projectId: PROJECT, title: "Build", createdBy: "agent:worker" }, db);
    db.prepare("UPDATE tasks SET goal_id = ? WHERE id = ?").run(goal.id, task.id);
    const wf = createWorkflow("wf", [task.id]);
    db.prepare("UPDATE tasks SET workflow_id = ? WHERE id = ?").run(wf.id, task.id);

    const verificationIds = handleWorkflowCompletion(PROJECT, wf.id, db);
    expect(verificationIds).toHaveLength(0);
  });
});

describe("handleGoalAchieved", () => {
  it("detects project completion when last top-level goal achieved", () => {
    const g1 = createGoal("Goal 1", { status: "achieved" });
    const g2 = createGoal("Goal 2", { status: "achieved" });

    const result = handleGoalAchieved(PROJECT, g2.id, db);
    expect(result.projectComplete).toBe(true);

    // Check project_metadata
    const meta = db.prepare(
      "SELECT value FROM project_metadata WHERE project_id = ? AND key = 'completed_at'",
    ).get(PROJECT) as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
  });

  it("does not trigger for child goals", () => {
    const parent = createGoal("Parent");
    const child = createGoal("Child", { parentGoalId: parent.id, status: "achieved" });

    const result = handleGoalAchieved(PROJECT, child.id, db);
    expect(result.projectComplete).toBe(false);
  });

  it("does not trigger when active goals remain", () => {
    createGoal("Active goal");
    const achieved = createGoal("Done goal", { status: "achieved" });

    const result = handleGoalAchieved(PROJECT, achieved.id, db);
    expect(result.projectComplete).toBe(false);
  });

  it("only records completion once", () => {
    const g1 = createGoal("Goal 1", { status: "achieved" });

    handleGoalAchieved(PROJECT, g1.id, db);
    handleGoalAchieved(PROJECT, g1.id, db);

    const rows = db.prepare(
      "SELECT COUNT(*) as cnt FROM project_metadata WHERE project_id = ? AND key = 'completed_at'",
    ).get(PROJECT) as Record<string, unknown>;
    expect(rows.cnt).toBe(1);
  });
});
