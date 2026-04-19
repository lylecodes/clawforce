import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "../../src/sqlite-driver.js";

describe("cascading budget allocation v2", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE budgets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT,
        daily_limit_cents INTEGER,
        daily_spent_cents INTEGER NOT NULL DEFAULT 0,
        daily_limit_tokens INTEGER,
        daily_spent_tokens INTEGER NOT NULL DEFAULT 0,
        daily_limit_requests INTEGER,
        daily_spent_requests INTEGER NOT NULL DEFAULT 0,
        hourly_limit_cents INTEGER,
        hourly_spent_cents INTEGER NOT NULL DEFAULT 0,
        hourly_limit_tokens INTEGER,
        hourly_spent_tokens INTEGER NOT NULL DEFAULT 0,
        hourly_limit_requests INTEGER,
        hourly_spent_requests INTEGER NOT NULL DEFAULT 0,
        monthly_limit_cents INTEGER,
        monthly_spent_cents INTEGER NOT NULL DEFAULT 0,
        monthly_limit_tokens INTEGER,
        monthly_spent_tokens INTEGER NOT NULL DEFAULT 0,
        monthly_limit_requests INTEGER,
        monthly_spent_requests INTEGER NOT NULL DEFAULT 0,
        daily_reset_at INTEGER NOT NULL DEFAULT 0,
        hourly_reset_at INTEGER,
        monthly_reset_at INTEGER,
        reserved_cents INTEGER NOT NULL DEFAULT 0,
        reserved_tokens INTEGER NOT NULL DEFAULT 0,
        reserved_requests INTEGER NOT NULL DEFAULT 0,
        session_limit_cents INTEGER,
        task_limit_cents INTEGER,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `);
  });

  it("allocates daily cents only (legacy compat)", async () => {
    const { allocateBudget } = await import("../../src/budget-cascade.js");

    // Set up parent budget
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_reset_at, created_at, updated_at)
      VALUES ('parent', 'p1', 'manager', 5000, ?, ?, ?)
    `).run(Date.now() + 86400000, Date.now(), Date.now());

    const result = allocateBudget({
      projectId: "p1",
      parentAgentId: "manager",
      childAgentId: "worker1",
      dailyLimitCents: 2000,
    }, db);

    expect(result.ok).toBe(true);

    const child = db.prepare(
      "SELECT daily_limit_cents FROM budgets WHERE project_id = 'p1' AND agent_id = 'worker1'",
    ).get() as { daily_limit_cents: number };
    expect(child.daily_limit_cents).toBe(2000);
  });

  it("allocates all dimensions via allocationConfig", async () => {
    const { allocateBudget } = await import("../../src/budget-cascade.js");

    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_limit_tokens, daily_limit_requests,
        hourly_limit_cents, monthly_limit_cents, daily_reset_at, hourly_reset_at, monthly_reset_at, created_at, updated_at)
      VALUES ('parent', 'p1', 'manager', 10000, 5000000, 200,
        2000, 200000, ?, ?, ?, ?, ?)
    `).run(Date.now() + 86400000, Date.now() + 3600000, Date.now() + 86400000 * 30, Date.now(), Date.now());

    const result = allocateBudget({
      projectId: "p1",
      parentAgentId: "manager",
      childAgentId: "worker1",
      allocationConfig: {
        daily: { cents: 3000, tokens: 1000000, requests: 50 },
        hourly: { cents: 500 },
        monthly: { cents: 60000 },
      },
    }, db);

    expect(result.ok).toBe(true);

    const child = db.prepare(
      "SELECT daily_limit_cents, daily_limit_tokens, daily_limit_requests, hourly_limit_cents, monthly_limit_cents FROM budgets WHERE agent_id = 'worker1'",
    ).get() as Record<string, number>;

    expect(child.daily_limit_cents).toBe(3000);
    expect(child.daily_limit_tokens).toBe(1000000);
    expect(child.daily_limit_requests).toBe(50);
    expect(child.hourly_limit_cents).toBe(500);
    expect(child.monthly_limit_cents).toBe(60000);
  });

  it("validates each dimension independently", async () => {
    const { allocateBudget } = await import("../../src/budget-cascade.js");

    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_limit_tokens, daily_reset_at, created_at, updated_at)
      VALUES ('parent', 'p1', 'manager', 5000, 2000000, ?, ?, ?)
    `).run(Date.now() + 86400000, Date.now(), Date.now());

    // First allocation: 3000 cents
    allocateBudget({
      projectId: "p1",
      parentAgentId: "manager",
      childAgentId: "worker1",
      allocationConfig: { daily: { cents: 3000, tokens: 1000000 } },
    }, db);

    // Second allocation: 3000 cents would exceed (3000 + 3000 > 5000)
    const result = allocateBudget({
      projectId: "p1",
      parentAgentId: "manager",
      childAgentId: "worker2",
      allocationConfig: { daily: { cents: 3000 } },
    }, db);

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("daily cents");
  });

  it("blocks when parent has no limit for requested dimension", async () => {
    const { allocateBudget } = await import("../../src/budget-cascade.js");

    // Parent has daily cents but NOT daily tokens
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_reset_at, created_at, updated_at)
      VALUES ('parent', 'p1', 'manager', 5000, ?, ?, ?)
    `).run(Date.now() + 86400000, Date.now(), Date.now());

    const result = allocateBudget({
      projectId: "p1",
      parentAgentId: "manager",
      childAgentId: "worker1",
      allocationConfig: { daily: { cents: 2000, tokens: 500000 } },
    }, db);

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("no daily tokens limit");
  });

  it("updates existing child budget with new dimensions", async () => {
    const { allocateBudget } = await import("../../src/budget-cascade.js");

    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_limit_tokens, daily_reset_at, created_at, updated_at)
      VALUES ('parent', 'p1', 'manager', 10000, 5000000, ?, ?, ?)
    `).run(Date.now() + 86400000, Date.now(), Date.now());

    // First allocation
    allocateBudget({
      projectId: "p1",
      parentAgentId: "manager",
      childAgentId: "worker1",
      dailyLimitCents: 2000,
    }, db);

    // Update with more dimensions
    const result = allocateBudget({
      projectId: "p1",
      parentAgentId: "manager",
      childAgentId: "worker1",
      allocationConfig: { daily: { cents: 3000, tokens: 1000000 } },
    }, db);

    expect(result.ok).toBe(true);

    const child = db.prepare(
      "SELECT daily_limit_cents, daily_limit_tokens FROM budgets WHERE agent_id = 'worker1'",
    ).get() as Record<string, number>;
    expect(child.daily_limit_cents).toBe(3000);
    expect(child.daily_limit_tokens).toBe(1000000);
  });

  it("blocks when parent has no budget", async () => {
    const { allocateBudget } = await import("../../src/budget-cascade.js");

    const result = allocateBudget({
      projectId: "p1",
      parentAgentId: "nonexistent",
      childAgentId: "worker1",
      dailyLimitCents: 1000,
    }, db);

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("no budget");
  });
});
