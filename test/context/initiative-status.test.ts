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

describe("initiative_status context source", () => {
  let db: ReturnType<typeof getMemoryDb>;
  const projectId = "test-init-ctx";

  beforeEach(() => {
    db = getMemoryDb();
    runMigrations(db);
  });

  it("renders initiative allocation table with spend", async () => {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Project budget
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b1', ?, NULL, 1000, 0, ?, ?, ?)
    `).run(projectId, now + 86400000, now, now);

    // Two initiatives
    db.prepare(`
      INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
      VALUES ('init-a', ?, 'UI Work', 'active', 'agent', ?, 40)
    `).run(projectId, now);
    db.prepare(`
      INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
      VALUES ('init-b', ?, 'Outreach', 'active', 'agent', ?, 30)
    `).run(projectId, now);

    // Task + cost under init-a
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, state, goal_id, created_by, created_at, updated_at)
      VALUES ('t1', ?, 'Fix nav', 'DONE', 'init-a', 'agent', ?, ?)
    `).run(projectId, now, now);
    db.prepare(`
      INSERT INTO cost_records (id, project_id, agent_id, task_id, input_tokens, output_tokens, cost_cents, model, created_at)
      VALUES ('c1', ?, 'worker', 't1', 1000, 500, 200, 'claude-sonnet-4-6', ?)
    `).run(projectId, todayStart.getTime() + 1000);

    const { resolveInitiativeStatusSource } = await import("../../src/context/assembler.js");
    const result = resolveInitiativeStatusSource(projectId, db);

    expect(result).toContain("UI Work");
    expect(result).toContain("40%");
    expect(result).toContain("400c");
    expect(result).toContain("200c");
    expect(result).toContain("Outreach");
    expect(result).toContain("30%");
    expect(result).toContain("Reserve");
    expect(result).toContain("30%");
  });

  it("returns empty message when no initiatives exist", async () => {
    const { resolveInitiativeStatusSource } = await import("../../src/context/assembler.js");
    const result = resolveInitiativeStatusSource(projectId, db);
    expect(result).toContain("No initiatives");
  });
});
