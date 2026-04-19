import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "../../src/sqlite-driver.js";
import {
  computeDailySnapshot,
  computeWeeklyTrend,
  computeMonthlyProjection,
} from "../../src/budget/forecast.js";

/**
 * In-memory SQLite database seeded with budgets, goals, tasks, and cost_records
 * for multi-day forecasting tests.
 */
describe("budget forecasting", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");

    // --- budgets table (v2 schema) ---
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

    // --- cost_records table ---
    db.exec(`
      CREATE TABLE cost_records (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        task_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_cents INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        provider TEXT,
        source TEXT NOT NULL DEFAULT 'dispatch',
        created_at INTEGER NOT NULL
      )
    `);

    // --- goals table ---
    db.exec(`
      CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        acceptance_criteria TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        parent_goal_id TEXT,
        owner_agent_id TEXT,
        department TEXT,
        team TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        achieved_at INTEGER,
        metadata TEXT,
        allocation INTEGER,
        priority TEXT
      )
    `);

    // --- tasks table ---
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        state TEXT NOT NULL DEFAULT 'OPEN',
        priority TEXT NOT NULL DEFAULT 'P2',
        assigned_to TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deadline INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        tags TEXT,
        workflow_id TEXT,
        workflow_phase INTEGER,
        parent_task_id TEXT,
        metadata TEXT,
        goal_id TEXT
      )
    `);
  });

  // ---------------------------------------------------------------------------
  // Helpers for seeding data
  // ---------------------------------------------------------------------------

  function insertBudget(overrides: Partial<Record<string, unknown>> = {}) {
    const now = Date.now();
    const defaults: Record<string, unknown> = {
      id: "b1",
      project_id: "p1",
      agent_id: null,
      daily_limit_cents: 5000,
      daily_spent_cents: 1500,
      daily_limit_tokens: 2000000,
      daily_spent_tokens: 500000,
      daily_limit_requests: 100,
      daily_spent_requests: 30,
      monthly_limit_cents: 100000,
      monthly_limit_tokens: 50000000,
      reserved_cents: 200,
      reserved_tokens: 50000,
      reserved_requests: 5,
      daily_reset_at: now + 86400000,
      created_at: now,
      updated_at: now,
    };

    const row = { ...defaults, ...overrides };
    const cols = Object.keys(row);
    const placeholders = cols.map(() => "?").join(", ");
    db.prepare(
      `INSERT INTO budgets (${cols.join(", ")}) VALUES (${placeholders})`,
    ).run(...Object.values(row));
  }

  function insertCostRecord(
    id: string,
    createdAt: number,
    costCents: number,
    inputTokens = 1000,
    outputTokens = 500,
    taskId: string | null = null,
  ) {
    db.prepare(
      `INSERT INTO cost_records (id, project_id, agent_id, task_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, source, created_at)
       VALUES (?, 'p1', 'a1', ?, ?, ?, 0, 0, ?, 'dispatch', ?)`,
    ).run(id, taskId, inputTokens, outputTokens, costCents, createdAt);
  }

  function insertGoal(
    id: string,
    title: string,
    allocation: number | null = null,
    parentGoalId: string | null = null,
  ) {
    db.prepare(
      `INSERT INTO goals (id, project_id, title, status, parent_goal_id, created_by, created_at, allocation)
       VALUES (?, 'p1', ?, 'active', ?, 'system', ?, ?)`,
    ).run(id, title, parentGoalId, Date.now(), allocation);
  }

  function insertTask(id: string, goalId: string | null = null) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, goal_id)
       VALUES (?, 'p1', 'task', 'OPEN', 'P2', 'system', ?, ?, ?)`,
    ).run(id, now, now, goalId);
  }

  // ---------------------------------------------------------------------------
  // computeDailySnapshot
  // ---------------------------------------------------------------------------

  describe("computeDailySnapshot", () => {
    it("returns per-dimension utilization from budget counters", () => {
      insertBudget();
      const snap = computeDailySnapshot("p1", db);

      expect(snap.cents.limit).toBe(5000);
      expect(snap.cents.spent).toBe(1500);
      expect(snap.cents.reserved).toBe(200);
      expect(snap.cents.remaining).toBe(3300); // 5000 - 1500 - 200
      expect(snap.cents.utilization).toBe(30); // 1500/5000 = 30%

      expect(snap.tokens.limit).toBe(2000000);
      expect(snap.tokens.spent).toBe(500000);
      expect(snap.tokens.reserved).toBe(50000);
      expect(snap.tokens.remaining).toBe(1450000);

      expect(snap.requests.limit).toBe(100);
      expect(snap.requests.spent).toBe(30);
      expect(snap.requests.reserved).toBe(5);
      expect(snap.requests.remaining).toBe(65);
    });

    it("estimates sessions remaining from average cost per session", () => {
      insertBudget({ daily_spent_cents: 400, reserved_cents: 0 });

      // Insert 4 records today at 100 cents each -> avg = 100
      const todayMs = new Date();
      todayMs.setHours(0, 0, 0, 0);
      const todayStart = todayMs.getTime();
      for (let i = 0; i < 4; i++) {
        insertCostRecord(`cr${i}`, todayStart + i * 60000, 100);
      }

      const snap = computeDailySnapshot("p1", db);
      // remaining = 5000 - 400 - 0 = 4600, avg = 100, sessions = floor(4600/100) = 46
      expect(snap.sessionsRemaining).toBe(46);
    });

    it("returns 0 sessions remaining when no cost records today", () => {
      insertBudget();
      const snap = computeDailySnapshot("p1", db);
      expect(snap.sessionsRemaining).toBe(0);
    });

    it("includes per-initiative breakdown from goal tree", () => {
      insertBudget({ daily_limit_cents: 10000, reserved_cents: 0 });
      insertGoal("g1", "Feature A", 60);
      insertGoal("g1-child", "Sub-feature A1", null, "g1");
      insertGoal("g2", "Feature B", 40);

      insertTask("t1", "g1-child");
      insertTask("t2", "g2");

      const todayMs = new Date();
      todayMs.setHours(0, 0, 0, 0);
      const todayStart = todayMs.getTime();

      insertCostRecord("cr1", todayStart + 1000, 300, 5000, 2000, "t1");
      insertCostRecord("cr2", todayStart + 2000, 200, 3000, 1000, "t2");

      const snap = computeDailySnapshot("p1", db);
      expect(snap.initiatives).toHaveLength(2);

      const initA = snap.initiatives.find((i) => i.id === "g1");
      expect(initA).toBeDefined();
      expect(initA!.name).toBe("Feature A");
      expect(initA!.allocation).toBe(60);
      expect(initA!.spent.cents).toBe(300); // task t1 under g1-child -> g1 tree
      expect(initA!.spent.tokens).toBeGreaterThan(0);

      const initB = snap.initiatives.find((i) => i.id === "g2");
      expect(initB).toBeDefined();
      expect(initB!.spent.cents).toBe(200);
    });

    it("handles missing budget gracefully", () => {
      const snap = computeDailySnapshot("p1", db);
      expect(snap.cents.limit).toBe(0);
      expect(snap.cents.spent).toBe(0);
      expect(snap.sessionsRemaining).toBe(0);
      expect(snap.exhaustionEta).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // computeWeeklyTrend
  // ---------------------------------------------------------------------------

  describe("computeWeeklyTrend", () => {
    it("calculates daily averages from last 7 days", () => {
      insertBudget();

      // Insert cost records over 7 days
      const now = Date.now();
      for (let day = 0; day < 7; day++) {
        const dayMs = now - (6 - day) * 86400000;
        insertCostRecord(`cr-${day}`, dayMs, 100 + day * 10, 2000, 1000);
      }

      const trend = computeWeeklyTrend("p1", db);
      expect(trend.dailyAverage.cents).toBeGreaterThan(0);
      expect(trend.dailyAverage.tokens).toBeGreaterThan(0);
      expect(trend.dailyAverage.requests).toBeGreaterThan(0);
    });

    it("detects upward trend when recent days cost more", () => {
      insertBudget();
      const now = Date.now();

      // Previous 4 days: low spend (50 cents each)
      for (let day = 0; day < 4; day++) {
        const dayMs = now - (6 - day) * 86400000;
        insertCostRecord(`cr-prev-${day}`, dayMs, 50, 1000, 500);
      }

      // Recent 3 days: high spend (200 cents each) — 300% increase
      for (let day = 0; day < 3; day++) {
        const dayMs = now - (2 - day) * 86400000;
        insertCostRecord(`cr-recent-${day}`, dayMs, 200, 4000, 2000);
      }

      const trend = computeWeeklyTrend("p1", db);
      expect(trend.direction.cents).toBe("up");
      expect(trend.changePercent.cents).toBeGreaterThan(10);
    });

    it("detects downward trend when recent days cost less", () => {
      insertBudget();
      const now = Date.now();

      // Previous 4 days: high spend (200 cents each)
      for (let day = 0; day < 4; day++) {
        const dayMs = now - (6 - day) * 86400000;
        insertCostRecord(`cr-prev-${day}`, dayMs, 200, 4000, 2000);
      }

      // Recent 3 days: low spend (50 cents each)
      for (let day = 0; day < 3; day++) {
        const dayMs = now - (2 - day) * 86400000;
        insertCostRecord(`cr-recent-${day}`, dayMs, 50, 1000, 500);
      }

      const trend = computeWeeklyTrend("p1", db);
      expect(trend.direction.cents).toBe("down");
      expect(trend.changePercent.cents).toBeLessThan(-10);
    });

    it("reports stable when change is within 10%", () => {
      insertBudget();
      const now = Date.now();

      // All 7 days: same spend (100 cents)
      for (let day = 0; day < 7; day++) {
        const dayMs = now - (6 - day) * 86400000;
        insertCostRecord(`cr-${day}`, dayMs, 100, 2000, 1000);
      }

      const trend = computeWeeklyTrend("p1", db);
      expect(trend.direction.cents).toBe("stable");
    });

    it("includes per-initiative breakdown", () => {
      insertBudget({ daily_limit_cents: 10000 });
      insertGoal("g1", "Feature A", 60);
      insertTask("t1", "g1");

      const now = Date.now();
      for (let day = 0; day < 7; day++) {
        const dayMs = now - (6 - day) * 86400000;
        insertCostRecord(`cr-${day}`, dayMs, 100, 2000, 1000, "t1");
      }

      const trend = computeWeeklyTrend("p1", db);
      expect(trend.perInitiative).toHaveLength(1);
      expect(trend.perInitiative[0].id).toBe("g1");
      expect(trend.perInitiative[0].dailyAverage.cents).toBeGreaterThan(0);
    });

    it("handles no cost records gracefully", () => {
      insertBudget();
      const trend = computeWeeklyTrend("p1", db);
      expect(trend.dailyAverage.cents).toBe(0);
      expect(trend.direction.cents).toBe("stable");
      expect(trend.direction.tokens).toBe("stable");
    });
  });

  // ---------------------------------------------------------------------------
  // computeMonthlyProjection
  // ---------------------------------------------------------------------------

  describe("computeMonthlyProjection", () => {
    it("projects monthly total based on daily average", () => {
      insertBudget({ monthly_limit_cents: 100000 });

      // Insert records spread across the current month
      const now = new Date();
      const monthStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        1,
      ).getTime();

      for (let day = 0; day < now.getDate(); day++) {
        insertCostRecord(
          `cr-${day}`,
          monthStart + day * 86400000 + 3600000,
          500,
          10000,
          5000,
        );
      }

      const projection = computeMonthlyProjection("p1", db);
      expect(projection.projectedTotal.cents).toBeGreaterThan(0);
      expect(projection.projectedTotal.tokens).toBeGreaterThan(0);
      expect(projection.monthlyLimit.cents).toBe(100000);
    });

    it("calculates exhaustion day when projection exceeds limit", () => {
      // Set a low monthly limit that will be exceeded
      insertBudget({ monthly_limit_cents: 5000, monthly_limit_tokens: null });

      const now = new Date();
      const monthStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        1,
      ).getTime();

      // Spend aggressively: 1000 cents per day so far
      for (let day = 0; day < now.getDate(); day++) {
        insertCostRecord(
          `cr-${day}`,
          monthStart + day * 86400000 + 3600000,
          1000,
          10000,
          5000,
        );
      }

      const projection = computeMonthlyProjection("p1", db);
      // Already spent now.getDate() * 1000 cents which is > 5000 for most dates
      // So exhaustion day should be set
      if (now.getDate() * 1000 < 5000) {
        // Early in month — exhaustion day should be within month
        expect(projection.exhaustionDay).toBeGreaterThan(0);
      } else {
        // Already exceeded — exhaustion day is null since we've already blown past it
        // (remaining budget < 0 means daysUntilExhaustion < 0)
        expect(projection.exhaustionDay).toBeNull();
      }
    });

    it("returns null exhaustion day when within limits", () => {
      insertBudget({ monthly_limit_cents: 9999999 });

      const now = new Date();
      const monthStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        1,
      ).getTime();

      insertCostRecord("cr-1", monthStart + 3600000, 10, 500, 200);

      const projection = computeMonthlyProjection("p1", db);
      expect(projection.exhaustionDay).toBeNull();
    });

    it("handles no monthly limit set", () => {
      insertBudget({ monthly_limit_cents: null, monthly_limit_tokens: null });

      const now = new Date();
      const monthStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        1,
      ).getTime();
      insertCostRecord("cr-1", monthStart + 3600000, 500, 10000, 5000);

      const projection = computeMonthlyProjection("p1", db);
      expect(projection.monthlyLimit.cents).toBeNull();
      expect(projection.exhaustionDay).toBeNull();
    });

    it("includes per-initiative projections", () => {
      insertBudget({ monthly_limit_cents: 100000 });
      insertGoal("g1", "Feature A", 60);
      insertTask("t1", "g1");

      const now = new Date();
      const monthStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        1,
      ).getTime();

      for (let day = 0; day < now.getDate(); day++) {
        insertCostRecord(
          `cr-${day}`,
          monthStart + day * 86400000 + 3600000,
          100,
          2000,
          1000,
          "t1",
        );
      }

      const projection = computeMonthlyProjection("p1", db);
      expect(projection.perInitiative).toHaveLength(1);
      expect(projection.perInitiative[0].id).toBe("g1");
      expect(projection.perInitiative[0].projectedTotal).toBeGreaterThan(0);
      expect(projection.perInitiative[0].allocation).toBe(60);
    });

    it("handles no cost records gracefully", () => {
      insertBudget();
      const projection = computeMonthlyProjection("p1", db);
      expect(projection.projectedTotal.cents).toBe(0);
      expect(projection.projectedTotal.tokens).toBe(0);
    });
  });
});
