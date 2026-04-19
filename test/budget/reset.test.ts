import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "../../src/sqlite-driver.js";

describe("lazy budget reset", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    // Create budgets table with all v2 columns
    db.exec(`
      CREATE TABLE budgets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT,
        daily_limit_cents INTEGER,
        daily_spent_cents INTEGER NOT NULL DEFAULT 0,
        daily_reset_at INTEGER NOT NULL,
        hourly_limit_cents INTEGER,
        hourly_spent_cents INTEGER NOT NULL DEFAULT 0,
        hourly_reset_at INTEGER,
        monthly_limit_cents INTEGER,
        monthly_spent_cents INTEGER NOT NULL DEFAULT 0,
        monthly_reset_at INTEGER,
        daily_limit_tokens INTEGER,
        daily_spent_tokens INTEGER NOT NULL DEFAULT 0,
        hourly_limit_tokens INTEGER,
        hourly_spent_tokens INTEGER NOT NULL DEFAULT 0,
        monthly_limit_tokens INTEGER,
        monthly_spent_tokens INTEGER NOT NULL DEFAULT 0,
        daily_limit_requests INTEGER,
        daily_spent_requests INTEGER NOT NULL DEFAULT 0,
        hourly_limit_requests INTEGER,
        hourly_spent_requests INTEGER NOT NULL DEFAULT 0,
        monthly_limit_requests INTEGER,
        monthly_spent_requests INTEGER NOT NULL DEFAULT 0,
        reserved_cents INTEGER NOT NULL DEFAULT 0,
        reserved_tokens INTEGER NOT NULL DEFAULT 0,
        reserved_requests INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  });

  it("resets daily counters when window has elapsed", async () => {
    const { ensureWindowsCurrent } = await import("../../src/budget/reset.js");

    const pastMidnight = Date.now() - 86400000; // yesterday
    db.prepare(`INSERT INTO budgets (id, project_id, daily_limit_cents, daily_spent_cents, daily_spent_tokens, daily_spent_requests, daily_reset_at, created_at, updated_at) VALUES ('b1', 'p1', 5000, 3000, 100000, 50, ?, ?, ?)`).run(pastMidnight, Date.now(), Date.now());

    ensureWindowsCurrent("p1", undefined, db);

    const row = db.prepare("SELECT daily_spent_cents, daily_spent_tokens, daily_spent_requests FROM budgets WHERE id = 'b1'").get() as Record<string, number>;
    expect(row.daily_spent_cents).toBe(0);
    expect(row.daily_spent_tokens).toBe(0);
    expect(row.daily_spent_requests).toBe(0);
  });

  it("does not reset if window is still active", async () => {
    const { ensureWindowsCurrent } = await import("../../src/budget/reset.js");

    const futureMidnight = Date.now() + 86400000; // tomorrow
    db.prepare(`INSERT INTO budgets (id, project_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at) VALUES ('b1', 'p1', 5000, 3000, ?, ?, ?)`).run(futureMidnight, Date.now(), Date.now());

    ensureWindowsCurrent("p1", undefined, db);

    const row = db.prepare("SELECT daily_spent_cents FROM budgets WHERE id = 'b1'").get() as Record<string, number>;
    expect(row.daily_spent_cents).toBe(3000);
  });

  it("does not reset reservations", async () => {
    const { ensureWindowsCurrent } = await import("../../src/budget/reset.js");

    const pastMidnight = Date.now() - 86400000;
    db.prepare(`INSERT INTO budgets (id, project_id, daily_limit_cents, daily_spent_cents, daily_reset_at, reserved_cents, created_at, updated_at) VALUES ('b1', 'p1', 5000, 3000, ?, 1000, ?, ?)`).run(pastMidnight, Date.now(), Date.now());

    ensureWindowsCurrent("p1", undefined, db);

    const row = db.prepare("SELECT daily_spent_cents, reserved_cents FROM budgets WHERE id = 'b1'").get() as Record<string, number>;
    expect(row.daily_spent_cents).toBe(0);
    expect(row.reserved_cents).toBe(1000); // NOT reset
  });
});
