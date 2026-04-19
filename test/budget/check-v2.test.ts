import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "../../src/sqlite-driver.js";

describe("checkBudgetV2", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    // Create full v2 budgets table (same schema as reset.test.ts)
    db.exec(`
      CREATE TABLE budgets (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT,
        daily_limit_cents INTEGER, daily_spent_cents INTEGER NOT NULL DEFAULT 0,
        daily_limit_tokens INTEGER, daily_spent_tokens INTEGER NOT NULL DEFAULT 0,
        daily_limit_requests INTEGER, daily_spent_requests INTEGER NOT NULL DEFAULT 0,
        hourly_limit_cents INTEGER, hourly_spent_cents INTEGER NOT NULL DEFAULT 0,
        hourly_limit_tokens INTEGER, hourly_spent_tokens INTEGER NOT NULL DEFAULT 0,
        hourly_limit_requests INTEGER, hourly_spent_requests INTEGER NOT NULL DEFAULT 0,
        monthly_limit_cents INTEGER, monthly_spent_cents INTEGER NOT NULL DEFAULT 0,
        monthly_limit_tokens INTEGER, monthly_spent_tokens INTEGER NOT NULL DEFAULT 0,
        monthly_limit_requests INTEGER, monthly_spent_requests INTEGER NOT NULL DEFAULT 0,
        daily_reset_at INTEGER NOT NULL, hourly_reset_at INTEGER, monthly_reset_at INTEGER,
        reserved_cents INTEGER NOT NULL DEFAULT 0,
        reserved_tokens INTEGER NOT NULL DEFAULT 0,
        reserved_requests INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )
    `);
  });

  it("passes when under all limits", async () => {
    const { checkBudgetV2 } = await import("../../src/budget/check-v2.js");
    const future = Date.now() + 86400000;
    db.prepare(`INSERT INTO budgets (id, project_id, daily_limit_cents, daily_spent_cents, daily_limit_tokens, daily_spent_tokens, daily_reset_at, created_at, updated_at) VALUES ('b1', 'p1', 5000, 1000, 2000000, 500000, ?, ?, ?)`).run(future, Date.now(), Date.now());

    const result = checkBudgetV2({ projectId: "p1" }, db);
    expect(result.ok).toBe(true);
  });

  it("blocks when daily cents exceeded", async () => {
    const { checkBudgetV2 } = await import("../../src/budget/check-v2.js");
    const future = Date.now() + 86400000;
    db.prepare(`INSERT INTO budgets (id, project_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at) VALUES ('b1', 'p1', 5000, 5000, ?, ?, ?)`).run(future, Date.now(), Date.now());

    const result = checkBudgetV2({ projectId: "p1" }, db);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("cents");
  });

  it("blocks when daily tokens exceeded", async () => {
    const { checkBudgetV2 } = await import("../../src/budget/check-v2.js");
    const future = Date.now() + 86400000;
    db.prepare(`INSERT INTO budgets (id, project_id, daily_limit_cents, daily_spent_cents, daily_limit_tokens, daily_spent_tokens, daily_reset_at, created_at, updated_at) VALUES ('b1', 'p1', 5000, 1000, 2000000, 2000000, ?, ?, ?)`).run(future, Date.now(), Date.now());

    const result = checkBudgetV2({ projectId: "p1" }, db);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("token");
  });

  it("accounts for reservations in remaining calculation", async () => {
    const { checkBudgetV2 } = await import("../../src/budget/check-v2.js");
    const future = Date.now() + 86400000;
    db.prepare(`INSERT INTO budgets (id, project_id, daily_limit_cents, daily_spent_cents, reserved_cents, daily_reset_at, created_at, updated_at) VALUES ('b1', 'p1', 5000, 2000, 2500, ?, ?, ?)`).run(future, Date.now(), Date.now());

    // spent (2000) + reserved (2500) = 4500 < 5000, but only 500 remaining
    const result = checkBudgetV2({ projectId: "p1" }, db);
    expect(result.ok).toBe(true);
    expect(result.remaining).toBeLessThanOrEqual(500);
  });

  it("blocks when spent + reserved exceeds limit", async () => {
    const { checkBudgetV2 } = await import("../../src/budget/check-v2.js");
    const future = Date.now() + 86400000;
    db.prepare(`INSERT INTO budgets (id, project_id, daily_limit_cents, daily_spent_cents, reserved_cents, daily_reset_at, created_at, updated_at) VALUES ('b1', 'p1', 5000, 3000, 2500, ?, ?, ?)`).run(future, Date.now(), Date.now());

    const result = checkBudgetV2({ projectId: "p1" }, db);
    expect(result.ok).toBe(false);
  });

  it("checks agent-level and project-level budgets", async () => {
    const { checkBudgetV2 } = await import("../../src/budget/check-v2.js");
    const future = Date.now() + 86400000;
    // Project budget: under
    db.prepare(`INSERT INTO budgets (id, project_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at) VALUES ('bp', 'p1', 10000, 1000, ?, ?, ?)`).run(future, Date.now(), Date.now());
    // Agent budget: over
    db.prepare(`INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at) VALUES ('ba', 'p1', 'agent1', 500, 500, ?, ?, ?)`).run(future, Date.now(), Date.now());

    const result = checkBudgetV2({ projectId: "p1", agentId: "agent1" }, db);
    expect(result.ok).toBe(false); // agent budget blocks
  });
});
