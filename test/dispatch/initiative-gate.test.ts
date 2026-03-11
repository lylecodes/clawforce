import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { shouldDispatch } from "../../src/dispatch/dispatcher.js";
import { clearAllUsage, updateProviderUsage } from "../../src/rate-limits.js";
import { getDb } from "../../src/db.js";

describe("dispatch gate — initiative budget", () => {
  const projectId = "test-initiative-gate";

  beforeEach(() => {
    clearAllUsage();
    const db = getDb(projectId);
    db.prepare("DELETE FROM budgets WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM cost_records WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM goals WHERE project_id = ?").run(projectId);

    // Set provider usage low so rate limits don't interfere
    updateProviderUsage("anthropic", {
      windows: [{ label: "RPM", usedPercent: 10 }],
    });
  });

  it("blocks dispatch when initiative allocation exceeded", () => {
    const db = getDb(projectId);
    const now = Date.now();

    // Create initiative (root goal) with 10% allocation
    const goalId = randomUUID();
    db.prepare(`
      INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
      VALUES (?, ?, 'Test Initiative', 'active', 'test', ?, 10)
    `).run(goalId, projectId, now);

    // Create task linked to the goal
    const taskId = randomUUID();
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries, goal_id)
      VALUES (?, ?, 'Test Task', 'ASSIGNED', 'medium', 'test', ?, ?, 0, 3, ?)
    `).run(taskId, projectId, now, now, goalId);

    // Set project daily budget: 1000c
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES (?, ?, NULL, 1000, 0, ?, ?, ?)
    `).run(randomUUID(), projectId, now + 86400000, now, now);

    // 10% of 1000c = 100c allocation. Record 150c of cost against the task.
    db.prepare(`
      INSERT INTO cost_records (id, project_id, agent_id, task_id, input_tokens, output_tokens, cost_cents, created_at)
      VALUES (?, ?, 'worker', ?, 0, 0, 150, ?)
    `).run(randomUUID(), projectId, taskId, now);

    const result = shouldDispatch(projectId, "worker", "anthropic", { taskId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Initiative");
      expect(result.reason).toContain("budget exceeded");
    }
  });

  it("allows dispatch when within initiative allocation", () => {
    const db = getDb(projectId);
    const now = Date.now();

    // Create initiative with 50% allocation
    const goalId = randomUUID();
    db.prepare(`
      INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
      VALUES (?, ?, 'Big Initiative', 'active', 'test', ?, 50)
    `).run(goalId, projectId, now);

    // Create task linked to the goal
    const taskId = randomUUID();
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries, goal_id)
      VALUES (?, ?, 'Test Task', 'ASSIGNED', 'medium', 'test', ?, ?, 0, 3, ?)
    `).run(taskId, projectId, now, now, goalId);

    // Set project daily budget: 1000c (50% = 500c allocation)
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES (?, ?, NULL, 1000, 0, ?, ?, ?)
    `).run(randomUUID(), projectId, now + 86400000, now, now);

    // Record only 50c of cost — well within the 500c allocation
    db.prepare(`
      INSERT INTO cost_records (id, project_id, agent_id, task_id, input_tokens, output_tokens, cost_cents, created_at)
      VALUES (?, ?, 'worker', ?, 0, 0, 50, ?)
    `).run(randomUUID(), projectId, taskId, now);

    const result = shouldDispatch(projectId, "worker", "anthropic", { taskId });
    expect(result.ok).toBe(true);
  });

  it("allows dispatch when task has no goal", () => {
    const taskId = randomUUID();
    // Task doesn't exist in DB — shouldDispatch should pass (no goal = no gate)
    const result = shouldDispatch(projectId, "worker", "anthropic", { taskId });
    expect(result.ok).toBe(true);
  });

  it("allows dispatch when goal has no allocation", () => {
    const db = getDb(projectId);
    const now = Date.now();

    // Create goal WITHOUT allocation
    const goalId = randomUUID();
    db.prepare(`
      INSERT INTO goals (id, project_id, title, status, created_by, created_at)
      VALUES (?, ?, 'No-Budget Goal', 'active', 'test', ?)
    `).run(goalId, projectId, now);

    // Create task linked to the goal
    const taskId = randomUUID();
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries, goal_id)
      VALUES (?, ?, 'Test Task', 'ASSIGNED', 'medium', 'test', ?, ?, 0, 3, ?)
    `).run(taskId, projectId, now, now, goalId);

    // Set project daily budget
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES (?, ?, NULL, 1000, 0, ?, ?, ?)
    `).run(randomUUID(), projectId, now + 86400000, now, now);

    const result = shouldDispatch(projectId, "worker", "anthropic", { taskId });
    expect(result.ok).toBe(true);
  });
});
