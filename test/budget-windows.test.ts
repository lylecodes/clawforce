import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
const { checkMultiWindowBudget, getBudgetStatus } = await import("../src/budget-windows.js");
const { recordCost } = await import("../src/cost.js");

let db: ReturnType<typeof getMemoryDb>;

beforeEach(() => {
  db = getMemoryDb();
});

afterEach(() => {
  try { db.close(); } catch {}
});

describe("multi-window budget", () => {
  it("getBudgetStatus returns remaining for each window", () => {
    // Insert budget with all three windows
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, hourly_limit_cents, monthly_limit_cents,
        daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b1', 'test-proj', NULL, 2000, 500, 50000, 0, ?, ?, ?)
    `).run(Date.now() + 86400000, Date.now(), Date.now());

    // Record some cost
    recordCost({ projectId: "test-proj", agentId: "a1", inputTokens: 10000, outputTokens: 5000, model: "claude-sonnet-4-6" }, db);

    const status = getBudgetStatus("test-proj", undefined, db);
    expect(status.daily).toBeDefined();
    expect(status.daily!.limitCents).toBe(2000);
    expect(status.daily!.spentCents).toBeGreaterThan(0);
    expect(status.daily!.remainingCents).toBeLessThan(2000);
    expect(status.daily!.usedPercent).toBeGreaterThan(0);
    expect(status.hourly).toBeDefined();
    expect(status.monthly).toBeDefined();
  });

  it("checkMultiWindowBudget blocks when any window exceeded", () => {
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, hourly_limit_cents, monthly_limit_cents,
        daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b2', 'test-proj', NULL, 100000, 1, 100000, 0, ?, ?, ?)
    `).run(Date.now() + 86400000, Date.now(), Date.now());

    // Exceed hourly (1 cent limit)
    recordCost({ projectId: "test-proj", agentId: "a1", inputTokens: 100000, outputTokens: 50000, model: "claude-opus-4-6" }, db);

    const result = checkMultiWindowBudget({ projectId: "test-proj" }, db);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Hourly");
  });

  it("returns alert thresholds when approaching limit", () => {
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, hourly_limit_cents, monthly_limit_cents,
        daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b3', 'test-proj', NULL, 100, NULL, NULL, 75, ?, ?, ?)
    `).run(Date.now() + 86400000, Date.now(), Date.now());

    const status = getBudgetStatus("test-proj", undefined, db);
    expect(status.daily!.usedPercent).toBe(75);
    expect(status.alerts).toContain("Daily budget 75% consumed");
  });

  it("returns no alerts when well within budget", () => {
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, hourly_limit_cents, monthly_limit_cents,
        daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b4', 'test-proj', NULL, 10000, NULL, NULL, 100, ?, ?, ?)
    `).run(Date.now() + 86400000, Date.now(), Date.now());

    const status = getBudgetStatus("test-proj", undefined, db);
    expect(status.alerts).toHaveLength(0);
    expect(status.daily!.usedPercent).toBe(1);
  });

  it("checkMultiWindowBudget returns ok when within all windows", () => {
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, hourly_limit_cents, monthly_limit_cents,
        daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b5', 'test-proj', NULL, 100000, 100000, 1000000, 0, ?, ?, ?)
    `).run(Date.now() + 86400000, Date.now(), Date.now());

    const result = checkMultiWindowBudget({ projectId: "test-proj" }, db);
    expect(result.ok).toBe(true);
    expect(result.remaining).toBeGreaterThan(0);
  });

  it("returns empty status when no budget exists", () => {
    const status = getBudgetStatus("nonexistent-proj", undefined, db);
    expect(status.hourly).toBeUndefined();
    expect(status.daily).toBeUndefined();
    expect(status.monthly).toBeUndefined();
    expect(status.alerts).toHaveLength(0);
  });

  it("checkMultiWindowBudget returns ok when no budget set", () => {
    const result = checkMultiWindowBudget({ projectId: "nonexistent-proj" }, db);
    expect(result.ok).toBe(true);
  });
});
