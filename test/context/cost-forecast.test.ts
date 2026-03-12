import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
  diagnoseSafe: vi.fn(),
}));
vi.mock("../../src/identity.js", () => ({
  currentIdentity: () => ({ projectId: "test", agentId: "tester" }),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");

describe("cost_forecast context source", () => {
  let db: ReturnType<typeof getMemoryDb>;
  const PROJECT = "forecast-test";

  beforeEach(() => {
    db = getMemoryDb();
    runMigrations(db);
  });

  it("renders forecast table with allocation, spent, remaining", async () => {
    const { resolveCostForecastSource } = await import("../../src/context/assembler.js");

    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Project budget
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b1', ?, NULL, 2000, 0, ?, ?, ?)
    `).run(PROJECT, now + 86400000, now, now);

    // Two initiatives
    db.prepare(`
      INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
      VALUES ('init-ui', ?, 'UI Improvements', 'active', 'agent', ?, 40)
    `).run(PROJECT, now);
    db.prepare(`
      INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
      VALUES ('init-out', ?, 'Outreach', 'active', 'agent', ?, 30)
    `).run(PROJECT, now);

    const result = resolveCostForecastSource(PROJECT, db);
    expect(result).toContain("Cost Forecast");
    expect(result).toContain("UI Improvements");
    expect(result).toContain("Outreach");
    expect(result).toContain("40%");
    expect(result).toContain("30%");
    expect(result).toContain("Burn Rate");
    expect(result).toContain("Exhausts At");
    expect(result).toContain("Reserve");
  });

  it("returns message when no initiatives exist", async () => {
    const { resolveCostForecastSource } = await import("../../src/context/assembler.js");

    const result = resolveCostForecastSource(PROJECT, db);
    expect(result).toContain("No initiatives");
  });

  it("computes burn rate and shows exhaustion time when spending", async () => {
    const { resolveCostForecastSource } = await import("../../src/context/assembler.js");

    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Project budget
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b1', ?, NULL, 1000, 0, ?, ?, ?)
    `).run(PROJECT, now + 86400000, now, now);

    // One initiative
    db.prepare(`
      INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
      VALUES ('init-a', ?, 'Backend', 'active', 'agent', ?, 50)
    `).run(PROJECT, now);

    // Task + cost record under the initiative
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, state, goal_id, created_by, created_at, updated_at)
      VALUES ('t1', ?, 'API work', 'DONE', 'init-a', 'agent', ?, ?)
    `).run(PROJECT, now, now);
    db.prepare(`
      INSERT INTO cost_records (id, project_id, agent_id, task_id, input_tokens, output_tokens, cost_cents, model, created_at)
      VALUES ('c1', ?, 'worker', 't1', 1000, 500, 100, 'claude-sonnet-4-6', ?)
    `).run(PROJECT, todayStart.getTime() + 1000);

    const result = resolveCostForecastSource(PROJECT, db);
    expect(result).toContain("Backend");
    expect(result).toContain("50%");
    expect(result).toContain("500c"); // budget = 50% of 1000
    expect(result).toContain("100c"); // spent
    expect(result).toContain("c/hr"); // burn rate present
    expect(result).toContain("Reserve: 50%");
  });
});
