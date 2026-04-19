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
const {
  createGoal,
  getGoal,
  listGoals,
  updateGoal,
  achieveGoal,
  abandonGoal,
  getChildGoals,
  getGoalTree,
  linkTaskToGoal,
  unlinkTaskFromGoal,
  getGoalTasks,
} = await import("../../src/goals/ops.js");

describe("goals/ops", () => {
  let db: DatabaseSync;
  const PROJECT = "goal-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("createGoal creates a goal with all fields", () => {
    const goal = createGoal({
      projectId: PROJECT,
      title: "Ship v2.0",
      description: "Release version 2.0",
      acceptanceCriteria: "All features deployed",
      ownerAgentId: "ceo",
      department: "engineering",
      team: "platform",
      createdBy: "ceo",
      metadata: { quarter: "Q2" },
    }, db);

    expect(goal.id).toBeTruthy();
    expect(goal.title).toBe("Ship v2.0");
    expect(goal.description).toBe("Release version 2.0");
    expect(goal.acceptanceCriteria).toBe("All features deployed");
    expect(goal.status).toBe("active");
    expect(goal.ownerAgentId).toBe("ceo");
    expect(goal.department).toBe("engineering");
    expect(goal.team).toBe("platform");
    expect(goal.createdBy).toBe("ceo");
    expect(goal.metadata?.quarter).toBe("Q2");
  });

  it("createGoal with parentGoalId validates parent exists", () => {
    expect(() => createGoal({
      projectId: PROJECT,
      title: "Sub-goal",
      parentGoalId: "nonexistent",
      createdBy: "test",
    }, db)).toThrow("Parent goal not found");
  });

  it("createGoal with valid parentGoalId succeeds", () => {
    const parent = createGoal({
      projectId: PROJECT, title: "Parent", createdBy: "ceo",
    }, db);

    const child = createGoal({
      projectId: PROJECT, title: "Child", parentGoalId: parent.id, createdBy: "ceo",
    }, db);

    expect(child.parentGoalId).toBe(parent.id);
  });

  it("getGoal returns null for nonexistent", () => {
    const result = getGoal(PROJECT, "nonexistent", db);
    expect(result).toBeNull();
  });

  it("getGoal returns created goal", () => {
    const created = createGoal({
      projectId: PROJECT, title: "Test Goal", createdBy: "test",
    }, db);

    const fetched = getGoal(PROJECT, created.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Test Goal");
  });

  it("listGoals with status filter", () => {
    createGoal({ projectId: PROJECT, title: "Active 1", createdBy: "test" }, db);
    const g2 = createGoal({ projectId: PROJECT, title: "Active 2", createdBy: "test" }, db);
    achieveGoal(PROJECT, g2.id, "test", db);

    const active = listGoals(PROJECT, { status: "active" }, db);
    expect(active).toHaveLength(1);
    expect(active[0]!.title).toBe("Active 1");

    const achieved = listGoals(PROJECT, { status: "achieved" }, db);
    expect(achieved).toHaveLength(1);
    expect(achieved[0]!.title).toBe("Active 2");
  });

  it("listGoals with department/team filter", () => {
    createGoal({ projectId: PROJECT, title: "Eng Goal", department: "engineering", createdBy: "test" }, db);
    createGoal({ projectId: PROJECT, title: "Design Goal", department: "design", createdBy: "test" }, db);

    const eng = listGoals(PROJECT, { department: "engineering" }, db);
    expect(eng).toHaveLength(1);
    expect(eng[0]!.title).toBe("Eng Goal");
  });

  it("listGoals with parentGoalId null returns top-level only", () => {
    const parent = createGoal({ projectId: PROJECT, title: "Parent", createdBy: "test" }, db);
    createGoal({ projectId: PROJECT, title: "Child", parentGoalId: parent.id, createdBy: "test" }, db);

    const topLevel = listGoals(PROJECT, { parentGoalId: null }, db);
    expect(topLevel).toHaveLength(1);
    expect(topLevel[0]!.title).toBe("Parent");
  });

  it("updateGoal updates fields", () => {
    const goal = createGoal({ projectId: PROJECT, title: "Original", createdBy: "test" }, db);

    const updated = updateGoal(PROJECT, goal.id, {
      title: "Updated",
      description: "New description",
      ownerAgentId: "new-owner",
    }, db);

    expect(updated.title).toBe("Updated");
    expect(updated.description).toBe("New description");
    expect(updated.ownerAgentId).toBe("new-owner");
  });

  it("achieveGoal sets status and achievedAt", () => {
    const goal = createGoal({ projectId: PROJECT, title: "Goal", createdBy: "test" }, db);
    const achieved = achieveGoal(PROJECT, goal.id, "test", db);

    expect(achieved.status).toBe("achieved");
    expect(achieved.achievedAt).toBeGreaterThan(0);
  });

  it("abandonGoal sets status with reason", () => {
    const goal = createGoal({ projectId: PROJECT, title: "Goal", createdBy: "test" }, db);
    const abandoned = abandonGoal(PROJECT, goal.id, "test", "No longer needed", db);

    expect(abandoned.status).toBe("abandoned");
    expect(abandoned.metadata?.abandonReason).toBe("No longer needed");
  });

  it("cannot achieve already-achieved goal", () => {
    const goal = createGoal({ projectId: PROJECT, title: "Goal", createdBy: "test" }, db);
    achieveGoal(PROJECT, goal.id, "test", db);

    expect(() => achieveGoal(PROJECT, goal.id, "test", db)).toThrow("Cannot achieve goal in status: achieved");
  });

  it("cannot abandon already-abandoned goal", () => {
    const goal = createGoal({ projectId: PROJECT, title: "Goal", createdBy: "test" }, db);
    abandonGoal(PROJECT, goal.id, "test", undefined, db);

    expect(() => abandonGoal(PROJECT, goal.id, "test", undefined, db)).toThrow("Cannot abandon goal in status: abandoned");
  });

  it("getChildGoals returns direct children", () => {
    const parent = createGoal({ projectId: PROJECT, title: "Parent", createdBy: "test" }, db);
    createGoal({ projectId: PROJECT, title: "Child 1", parentGoalId: parent.id, createdBy: "test" }, db);
    createGoal({ projectId: PROJECT, title: "Child 2", parentGoalId: parent.id, createdBy: "test" }, db);

    const children = getChildGoals(PROJECT, parent.id, db);
    expect(children).toHaveLength(2);
  });

  it("getGoalTree returns recursive tree", () => {
    const root = createGoal({ projectId: PROJECT, title: "Root", createdBy: "test" }, db);
    const child = createGoal({ projectId: PROJECT, title: "Child", parentGoalId: root.id, createdBy: "test" }, db);
    createGoal({ projectId: PROJECT, title: "Grandchild", parentGoalId: child.id, createdBy: "test" }, db);

    const tree = getGoalTree(PROJECT, root.id, db);
    expect(tree).not.toBeNull();
    expect(tree!.children).toHaveLength(1);
    expect(tree!.children[0]!.children).toHaveLength(1);
    expect(tree!.children[0]!.children[0]!.title).toBe("Grandchild");
  });

  it("linkTaskToGoal and getGoalTasks round-trip", () => {
    const goal = createGoal({ projectId: PROJECT, title: "Goal", createdBy: "test" }, db);

    // Create a task directly in DB
    const taskId = "task-" + Date.now();
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries)
      VALUES (?, ?, 'Test Task', 'OPEN', 'P2', 'test', ?, ?, 0, 3)
    `).run(taskId, PROJECT, Date.now(), Date.now());

    linkTaskToGoal(PROJECT, taskId, goal.id, db);

    const tasks = getGoalTasks(PROJECT, goal.id, db);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe(taskId);

    // Unlink
    unlinkTaskFromGoal(PROJECT, taskId, db);
    const tasksAfter = getGoalTasks(PROJECT, goal.id, db);
    expect(tasksAfter).toHaveLength(0);
  });
});
