import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
  diagnoseSafe: vi.fn(),
}));
vi.mock("../src/identity.js", () => ({
  currentIdentity: () => ({ projectId: "test", agentId: "tester" }),
}));

const { getMemoryDb } = await import("../src/db.js");
const { runMigrations } = await import("../src/migrations.js");
const { allocateBudget, getAgentBudgetStatus } = await import("../src/budget-cascade.js");

describe("cascading budget allocation", () => {
  let db: ReturnType<typeof getMemoryDb>;
  const projectId = "test-cascade";

  beforeEach(() => {
    db = getMemoryDb();
    runMigrations(db);
    // Parent agent with $10 daily budget
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b-parent', ?, 'manager', 1000, 0, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());
  });

  it("allocates budget from parent to child", () => {
    const result = allocateBudget({
      projectId,
      parentAgentId: "manager",
      childAgentId: "frontend",
      dailyLimitCents: 400,
    }, db);
    expect(result.ok).toBe(true);

    const status = getAgentBudgetStatus(projectId, "frontend", db);
    expect(status.dailyLimitCents).toBe(400);
  });

  it("rejects allocation exceeding parent's allocatable budget", () => {
    allocateBudget({ projectId, parentAgentId: "manager", childAgentId: "frontend", dailyLimitCents: 600 }, db);

    const result = allocateBudget({
      projectId, parentAgentId: "manager", childAgentId: "backend", dailyLimitCents: 500,
    }, db);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("exceeds");
  });

  it("allows updating existing allocation", () => {
    allocateBudget({ projectId, parentAgentId: "manager", childAgentId: "frontend", dailyLimitCents: 400 }, db);
    const result = allocateBudget({ projectId, parentAgentId: "manager", childAgentId: "frontend", dailyLimitCents: 300 }, db);
    expect(result.ok).toBe(true);

    const status = getAgentBudgetStatus(projectId, "frontend", db);
    expect(status.dailyLimitCents).toBe(300);
  });

  it("getAgentBudgetStatus shows allocated to reports", () => {
    allocateBudget({ projectId, parentAgentId: "manager", childAgentId: "frontend", dailyLimitCents: 400 }, db);
    allocateBudget({ projectId, parentAgentId: "manager", childAgentId: "backend", dailyLimitCents: 300 }, db);

    const status = getAgentBudgetStatus(projectId, "manager", db);
    expect(status.dailyLimitCents).toBe(1000);
    expect(status.allocatedToReportsCents).toBe(700);
    expect(status.allocatableCents).toBe(300);
  });

  it("rejects when parent has no budget", () => {
    const result = allocateBudget({
      projectId, parentAgentId: "no-budget-agent", childAgentId: "someone", dailyLimitCents: 100,
    }, db);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("no budget");
  });
});
