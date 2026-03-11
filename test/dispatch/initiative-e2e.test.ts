/**
 * End-to-end integration tests for initiative budget gating.
 *
 * Exercises the full pipeline: goals with allocation, parent-walking
 * to find the initiative, hard gate blocking dispatch, and cascading
 * budget allocation.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { shouldDispatch } from "../../src/dispatch/dispatcher.js";
import { clearAllUsage, updateProviderUsage } from "../../src/rate-limits.js";
import { getDb } from "../../src/db.js";
import { createGoal } from "../../src/goals/ops.js";
import { allocateBudget } from "../../src/budget-cascade.js";

describe("initiative budget — end-to-end", () => {
  const projectId = "test-initiative-e2e";

  beforeEach(() => {
    clearAllUsage();
    const db = getDb(projectId);
    db.prepare("DELETE FROM cost_records WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM goals WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM budgets WHERE project_id = ?").run(projectId);

    // Set provider usage low so rate limits don't interfere
    updateProviderUsage("anthropic", {
      windows: [{ label: "RPM", usedPercent: 10 }],
    });
  });

  it("full lifecycle: create initiative, spend budget, get blocked", () => {
    const db = getDb(projectId);
    const now = Date.now();

    // 1. Set up project budget: 1000c daily
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES (?, ?, NULL, 1000, 0, ?, ?, ?)
    `).run(randomUUID(), projectId, now + 86400000, now, now);

    // 2. Create initiative (root goal) with 10% allocation → 100c
    const initiative = createGoal({
      projectId,
      title: "Ship v2 Launch",
      description: "Launch version 2",
      createdBy: "manager",
      allocation: 10,
    });
    expect(initiative.allocation).toBe(10);

    // 3. Create sub-goal under the initiative (no allocation)
    const subGoal = createGoal({
      projectId,
      title: "Build API endpoints",
      createdBy: "manager",
      parentGoalId: initiative.id,
    });
    expect(subGoal.parentGoalId).toBe(initiative.id);
    expect(subGoal.allocation).toBeUndefined();

    // 4. Create a task linked to the sub-goal
    const taskId = randomUUID();
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries, goal_id)
      VALUES (?, ?, 'Implement auth endpoint', 'ASSIGNED', 'P2', 'worker', ?, ?, 0, 3, ?)
    `).run(taskId, projectId, now, now, subGoal.id);

    // 5. First shouldDispatch — should pass (no spend yet)
    const firstCheck = shouldDispatch(projectId, "worker", "anthropic", { taskId });
    expect(firstCheck.ok).toBe(true);

    // 6. Record 120c of cost on the task (exceeds 100c allocation)
    db.prepare(`
      INSERT INTO cost_records (id, project_id, agent_id, task_id, input_tokens, output_tokens, cost_cents, created_at)
      VALUES (?, ?, 'worker', ?, 0, 0, 120, ?)
    `).run(randomUUID(), projectId, taskId, now);

    // 7. Second shouldDispatch — should be blocked
    const secondCheck = shouldDispatch(projectId, "worker", "anthropic", { taskId });
    expect(secondCheck.ok).toBe(false);
    if (!secondCheck.ok) {
      expect(secondCheck.reason.toLowerCase()).toContain("initiative");
      expect(secondCheck.reason).toContain("Ship v2 Launch");
    }
  });

  it("cascading: parent allocates to child, child bounded", () => {
    const db = getDb(projectId);
    const now = Date.now();

    // 1. Set up manager with $10 budget (1000c)
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES (?, ?, 'manager', 1000, 0, ?, ?, ?)
    `).run(randomUUID(), projectId, now + 86400000, now, now);

    // 2. Allocate $4 (400c) to frontend → ok
    const r1 = allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "frontend",
      dailyLimitCents: 400,
    });
    expect(r1.ok).toBe(true);

    // 3. Allocate $4 (400c) to backend → ok
    const r2 = allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "backend",
      dailyLimitCents: 400,
    });
    expect(r2.ok).toBe(true);

    // 4. Try allocate $3 (300c) to QA → should fail (only 200c remains)
    const r3 = allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "qa",
      dailyLimitCents: 300,
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.reason).toContain("exceeds");
      expect(r3.reason).toContain("200");
    }

    // 5. Allocate $2 (200c) to QA → ok (exactly remaining)
    const r4 = allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "qa",
      dailyLimitCents: 200,
    });
    expect(r4.ok).toBe(true);
  });
});
