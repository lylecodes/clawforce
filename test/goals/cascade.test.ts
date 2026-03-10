import type { DatabaseSync } from "node:sqlite";
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
const { createGoal, achieveGoal, abandonGoal, getGoal } = await import("../../src/goals/ops.js");
const { computeGoalProgress, checkGoalCascade } = await import("../../src/goals/cascade.js");

describe("goals/cascade", () => {
  let db: DatabaseSync;
  const PROJECT = "cascade-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  describe("computeGoalProgress", () => {
    it("counts child goals correctly", () => {
      const parent = createGoal({ projectId: PROJECT, title: "Parent", createdBy: "test" }, db);
      const c1 = createGoal({ projectId: PROJECT, title: "Child 1", parentGoalId: parent.id, createdBy: "test" }, db);
      createGoal({ projectId: PROJECT, title: "Child 2", parentGoalId: parent.id, createdBy: "test" }, db);
      const c3 = createGoal({ projectId: PROJECT, title: "Child 3", parentGoalId: parent.id, createdBy: "test" }, db);

      achieveGoal(PROJECT, c1.id, "test", db);
      abandonGoal(PROJECT, c3.id, "test", undefined, db);

      const progress = computeGoalProgress(PROJECT, parent.id, db);
      expect(progress.childGoals.total).toBe(3);
      expect(progress.childGoals.achieved).toBe(1);
      expect(progress.childGoals.abandoned).toBe(1);
      expect(progress.childGoals.active).toBe(1);
    });

    it("counts linked tasks correctly", () => {
      const goal = createGoal({ projectId: PROJECT, title: "Goal", createdBy: "test" }, db);
      const now = Date.now();

      // Create tasks with different states
      for (const [state, i] of [["OPEN", 1], ["DONE", 2], ["DONE", 3], ["FAILED", 4]] as const) {
        db.prepare(`
          INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries, goal_id)
          VALUES (?, ?, ?, ?, 'P2', 'test', ?, ?, 0, 3, ?)
        `).run(`task-${i}`, PROJECT, `Task ${i}`, state, now, now, goal.id);
      }

      const progress = computeGoalProgress(PROJECT, goal.id, db);
      expect(progress.tasks.total).toBe(4);
      expect(progress.tasks.done).toBe(2);
      expect(progress.tasks.failed).toBe(1);
      expect(progress.tasks.active).toBe(1);
    });
  });

  describe("checkGoalCascade", () => {
    it("all children achieved → parent auto-achieved", () => {
      const parent = createGoal({ projectId: PROJECT, title: "Parent", createdBy: "test" }, db);
      const c1 = createGoal({ projectId: PROJECT, title: "Child 1", parentGoalId: parent.id, createdBy: "test" }, db);
      const c2 = createGoal({ projectId: PROJECT, title: "Child 2", parentGoalId: parent.id, createdBy: "test" }, db);

      achieveGoal(PROJECT, c1.id, "test", db);
      achieveGoal(PROJECT, c2.id, "test", db);

      const result = checkGoalCascade(PROJECT, db);
      expect(result.achieved).toBe(1);

      const updated = getGoal(PROJECT, parent.id, db);
      expect(updated!.status).toBe("achieved");
      expect(updated!.achievedAt).toBeGreaterThan(0);
    });

    it("partial children → no cascade", () => {
      const parent = createGoal({ projectId: PROJECT, title: "Parent", createdBy: "test" }, db);
      const c1 = createGoal({ projectId: PROJECT, title: "Child 1", parentGoalId: parent.id, createdBy: "test" }, db);
      createGoal({ projectId: PROJECT, title: "Child 2", parentGoalId: parent.id, createdBy: "test" }, db);

      achieveGoal(PROJECT, c1.id, "test", db);

      const result = checkGoalCascade(PROJECT, db);
      expect(result.achieved).toBe(0);

      const updated = getGoal(PROJECT, parent.id, db);
      expect(updated!.status).toBe("active");
    });

    it("multi-level cascade (child → parent → grandparent)", () => {
      const root = createGoal({ projectId: PROJECT, title: "Root", createdBy: "test" }, db);
      const mid = createGoal({ projectId: PROJECT, title: "Mid", parentGoalId: root.id, createdBy: "test" }, db);
      const leaf1 = createGoal({ projectId: PROJECT, title: "Leaf 1", parentGoalId: mid.id, createdBy: "test" }, db);
      const leaf2 = createGoal({ projectId: PROJECT, title: "Leaf 2", parentGoalId: mid.id, createdBy: "test" }, db);

      achieveGoal(PROJECT, leaf1.id, "test", db);
      achieveGoal(PROJECT, leaf2.id, "test", db);

      // Should cascade: leaves achieved → mid achieved → root achieved
      const result = checkGoalCascade(PROJECT, db);
      expect(result.achieved).toBe(2); // mid + root

      expect(getGoal(PROJECT, mid.id, db)!.status).toBe("achieved");
      expect(getGoal(PROJECT, root.id, db)!.status).toBe("achieved");
    });

    it("abandoned children don't count as achieved", () => {
      const parent = createGoal({ projectId: PROJECT, title: "Parent", createdBy: "test" }, db);
      const c1 = createGoal({ projectId: PROJECT, title: "Child 1", parentGoalId: parent.id, createdBy: "test" }, db);
      const c2 = createGoal({ projectId: PROJECT, title: "Child 2", parentGoalId: parent.id, createdBy: "test" }, db);

      abandonGoal(PROJECT, c1.id, "test", undefined, db);
      abandonGoal(PROJECT, c2.id, "test", undefined, db);

      // All abandoned, none achieved → should NOT cascade
      const result = checkGoalCascade(PROJECT, db);
      expect(result.achieved).toBe(0);

      const updated = getGoal(PROJECT, parent.id, db);
      expect(updated!.status).toBe("active");
    });

    it("mix of achieved and abandoned → cascade when at least one achieved", () => {
      const parent = createGoal({ projectId: PROJECT, title: "Parent", createdBy: "test" }, db);
      const c1 = createGoal({ projectId: PROJECT, title: "Child 1", parentGoalId: parent.id, createdBy: "test" }, db);
      const c2 = createGoal({ projectId: PROJECT, title: "Child 2", parentGoalId: parent.id, createdBy: "test" }, db);

      achieveGoal(PROJECT, c1.id, "test", db);
      abandonGoal(PROJECT, c2.id, "test", undefined, db);

      const result = checkGoalCascade(PROJECT, db);
      expect(result.achieved).toBe(1);

      expect(getGoal(PROJECT, parent.id, db)!.status).toBe("achieved");
    });

    it("leaf goals with no children → no cascade", () => {
      createGoal({ projectId: PROJECT, title: "Leaf 1", createdBy: "test" }, db);
      createGoal({ projectId: PROJECT, title: "Leaf 2", createdBy: "test" }, db);

      const result = checkGoalCascade(PROJECT, db);
      expect(result.checked).toBe(0);
      expect(result.achieved).toBe(0);
    });
  });
});
