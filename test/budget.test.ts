import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { getMemoryDb } = await import("../src/db.js");
const { setBudget, checkBudget, resetDailyBudgets } = await import("../src/budget.js");
const { recordCost } = await import("../src/cost.js");

let db: ReturnType<typeof getMemoryDb>;

beforeEach(() => {
  db = getMemoryDb();
});

afterEach(() => {
  try { db.close(); } catch {}
});

describe("setBudget", () => {
  it("creates a project-level budget", () => {
    setBudget({
      projectId: "p1",
      config: { dailyLimitCents: 5000 },
    }, db);

    const row = db.prepare("SELECT * FROM budgets WHERE project_id = 'p1' AND agent_id IS NULL").get() as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.daily_limit_cents).toBe(5000);
    expect(row.daily_spent_cents).toBe(0);
  });

  it("creates an agent-level budget", () => {
    setBudget({
      projectId: "p1",
      agentId: "worker-1",
      config: { dailyLimitCents: 2000, taskLimitCents: 500 },
    }, db);

    const row = db.prepare("SELECT * FROM budgets WHERE project_id = 'p1' AND agent_id = 'worker-1'").get() as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.daily_limit_cents).toBe(2000);
    expect(row.task_limit_cents).toBe(500);
  });

  it("updates existing budget on second call", () => {
    setBudget({ projectId: "p1", config: { dailyLimitCents: 1000 } }, db);
    setBudget({ projectId: "p1", config: { dailyLimitCents: 2000 } }, db);

    const rows = db.prepare("SELECT * FROM budgets WHERE project_id = 'p1' AND agent_id IS NULL").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.daily_limit_cents).toBe(2000);
  });
});

describe("checkBudget", () => {
  it("returns ok when no budget is set", () => {
    const result = checkBudget({ projectId: "p1" }, db);
    expect(result.ok).toBe(true);
  });

  it("returns ok when within budget", () => {
    setBudget({ projectId: "p1", config: { dailyLimitCents: 5000 } }, db);
    const result = checkBudget({ projectId: "p1" }, db);
    expect(result.ok).toBe(true);
  });

  it("returns not ok when daily budget exceeded", () => {
    setBudget({ projectId: "p1", config: { dailyLimitCents: 100 } }, db);
    // Simulate spending
    db.prepare("UPDATE budgets SET daily_spent_cents = 150 WHERE project_id = 'p1'").run();

    const result = checkBudget({ projectId: "p1" }, db);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("exceeded");
  });

  it("checks agent-level budget", () => {
    setBudget({ projectId: "p1", agentId: "worker-1", config: { dailyLimitCents: 50 } }, db);
    db.prepare("UPDATE budgets SET daily_spent_cents = 60 WHERE project_id = 'p1' AND agent_id = 'worker-1'").run();

    const result = checkBudget({ projectId: "p1", agentId: "worker-1" }, db);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("worker-1");
  });

  it("checks task-level budget", () => {
    setBudget({ projectId: "p1", config: { taskLimitCents: 100 } }, db);
    // Record cost for the task
    recordCost({ projectId: "p1", agentId: "a1", taskId: "task-1", inputTokens: 1_000_000, outputTokens: 1_000_000, model: "sonnet" }, db);

    const result = checkBudget({ projectId: "p1", taskId: "task-1" }, db);
    // 1800 cents > 100 limit
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Task budget exceeded");
  });
});

describe("resetDailyBudgets", () => {
  it("resets budgets past their reset time", () => {
    setBudget({ projectId: "p1", config: { dailyLimitCents: 5000 } }, db);
    // Set reset time to the past
    db.prepare("UPDATE budgets SET daily_spent_cents = 3000, daily_reset_at = ?").run(Date.now() - 1000);

    const count = resetDailyBudgets("p1", db);
    expect(count).toBe(1);

    const row = db.prepare("SELECT daily_spent_cents FROM budgets WHERE project_id = 'p1'").get() as Record<string, unknown>;
    expect(row.daily_spent_cents).toBe(0);
  });

  it("does not reset budgets with future reset time", () => {
    setBudget({ projectId: "p1", config: { dailyLimitCents: 5000 } }, db);
    db.prepare("UPDATE budgets SET daily_spent_cents = 3000").run();

    const count = resetDailyBudgets("p1", db);
    expect(count).toBe(0);

    const row = db.prepare("SELECT daily_spent_cents FROM budgets WHERE project_id = 'p1'").get() as Record<string, unknown>;
    expect(row.daily_spent_cents).toBe(3000);
  });
});
