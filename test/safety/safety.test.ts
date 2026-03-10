import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const {
  getSafetyDefaults,
  checkSpawnDepth,
  checkCostCircuitBreaker,
  checkLoopDetection,
  checkMeetingConcurrency,
  checkMessageRate,
  resetMessageRateTracking,
} = await import("../../src/safety.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-safety";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
  resetMessageRateTracking();
});

describe("getSafetyDefaults", () => {
  it("returns conservative defaults", () => {
    const defaults = getSafetyDefaults();
    expect(defaults.maxSpawnDepth).toBe(3);
    expect(defaults.costCircuitBreaker).toBe(1.5);
    expect(defaults.loopDetectionThreshold).toBe(3);
    expect(defaults.maxConcurrentMeetings).toBe(2);
    expect(defaults.maxMessageRate).toBe(60);
  });
});

describe("checkSpawnDepth", () => {
  it("allows when no task", () => {
    const result = checkSpawnDepth(PROJECT, undefined, db);
    expect(result.ok).toBe(true);
  });

  it("allows when task has no goal", () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, state, priority, created_by, created_at, updated_at, retry_count, max_retries)
      VALUES (?, ?, ?, 'OPEN', 'P2', 'agent', ?, ?, 0, 3)
    `).run("t1", PROJECT, "Test task", now, now);

    const result = checkSpawnDepth(PROJECT, "t1", db);
    expect(result.ok).toBe(true);
  });

  it("allows shallow goal chains", () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, status, created_by, created_at)
      VALUES (?, ?, ?, ?, 'active', 'agent', ?)
    `).run("g1", PROJECT, "Top goal", "Top goal", now);

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, status, parent_goal_id, created_by, created_at)
      VALUES (?, ?, ?, ?, 'active', ?, 'agent', ?)
    `).run("g2", PROJECT, "Sub goal", "Sub goal", "g1", now);

    db.prepare(`
      INSERT INTO tasks (id, project_id, title, state, priority, created_by, goal_id, created_at, updated_at, retry_count, max_retries)
      VALUES (?, ?, ?, 'OPEN', 'P2', 'agent', ?, ?, ?, 0, 3)
    `).run("t1", PROJECT, "Task", "g2", now, now);

    const result = checkSpawnDepth(PROJECT, "t1", db);
    expect(result.ok).toBe(true);
  });
});

describe("checkCostCircuitBreaker", () => {
  it("allows when no budget set", () => {
    const result = checkCostCircuitBreaker(PROJECT, undefined, db);
    expect(result.ok).toBe(true);
  });

  it("allows when under threshold", () => {
    const now = Date.now();
    const nextMidnight = now + 86_400_000;
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
    `).run("b1", PROJECT, 1000, 100, nextMidnight, now, now);

    const result = checkCostCircuitBreaker(PROJECT, undefined, db);
    expect(result.ok).toBe(true);
  });

  it("blocks when over circuit breaker threshold", () => {
    const now = Date.now();
    const nextMidnight = now + 86_400_000;
    // Default circuit breaker is 1.5x, limit is 1000, so threshold is 1500
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
    `).run("b1", PROJECT, 1000, 1500, nextMidnight, now, now);

    const result = checkCostCircuitBreaker(PROJECT, undefined, db);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("circuit breaker");
  });

  it("checks agent-level budget when agentId provided", () => {
    const now = Date.now();
    const nextMidnight = now + 86_400_000;
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("b1", PROJECT, "agent1", 500, 800, nextMidnight, now, now);

    const result = checkCostCircuitBreaker(PROJECT, "agent1", db);
    expect(result.ok).toBe(false);
  });
});

describe("checkLoopDetection", () => {
  it("allows when no failed tasks", () => {
    const result = checkLoopDetection(PROJECT, "Build feature", db);
    expect(result.ok).toBe(true);
  });

  it("allows when below threshold", () => {
    const now = Date.now();
    // Create 2 failed tasks with same title (threshold is 3)
    for (let i = 0; i < 2; i++) {
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, created_by, retry_count, max_retries, created_at, updated_at)
        VALUES (?, ?, ?, 'FAILED', 'P2', 'agent', 3, 3, ?, ?)
      `).run(`t${i}`, PROJECT, "Fix bug", now, now);
    }

    const result = checkLoopDetection(PROJECT, "Fix bug", db);
    expect(result.ok).toBe(true);
  });

  it("blocks when at or above threshold", () => {
    const now = Date.now();
    // Create 3 failed tasks with same title (threshold is 3)
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, created_by, retry_count, max_retries, created_at, updated_at)
        VALUES (?, ?, ?, 'FAILED', 'P2', 'agent', 3, 3, ?, ?)
      `).run(`t${i}`, PROJECT, "Fix bug", now, now);
    }

    const result = checkLoopDetection(PROJECT, "Fix bug", db);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("Loop detected");
    expect(result.ok === false && result.reason).toContain("Fix bug");
  });

  it("ignores tasks not fully exhausted", () => {
    const now = Date.now();
    // Create 5 failed tasks but with retries remaining
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, created_by, retry_count, max_retries, created_at, updated_at)
        VALUES (?, ?, ?, 'FAILED', 'P2', 'agent', 1, 3, ?, ?)
      `).run(`t${i}`, PROJECT, "Fix bug", now, now);
    }

    const result = checkLoopDetection(PROJECT, "Fix bug", db);
    expect(result.ok).toBe(true);
  });
});

describe("checkMeetingConcurrency", () => {
  it("allows when no active meetings", () => {
    const result = checkMeetingConcurrency(PROJECT, db);
    expect(result.ok).toBe(true);
  });

  it("allows when below limit", () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO channels (id, project_id, name, type, members, status, created_by, created_at)
      VALUES (?, ?, ?, 'meeting', '[]', 'active', 'agent', ?)
    `).run("ch1", PROJECT, "standup", now);

    const result = checkMeetingConcurrency(PROJECT, db);
    expect(result.ok).toBe(true);
  });

  it("blocks when at limit", () => {
    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      db.prepare(`
        INSERT INTO channels (id, project_id, name, type, members, status, created_by, created_at)
        VALUES (?, ?, ?, 'meeting', '[]', 'active', 'agent', ?)
      `).run(`ch${i}`, PROJECT, `meeting-${i}`, now);
    }

    const result = checkMeetingConcurrency(PROJECT, db);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("Meeting limit");
  });

  it("ignores concluded meetings", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO channels (id, project_id, name, type, members, status, created_by, created_at)
        VALUES (?, ?, ?, 'meeting', '[]', 'concluded', 'agent', ?)
      `).run(`ch${i}`, PROJECT, `meeting-${i}`, now);
    }

    const result = checkMeetingConcurrency(PROJECT, db);
    expect(result.ok).toBe(true);
  });
});

describe("checkMessageRate", () => {
  it("allows messages within rate limit", () => {
    for (let i = 0; i < 5; i++) {
      const result = checkMessageRate(PROJECT, "channel-1");
      expect(result.ok).toBe(true);
    }
  });

  it("blocks when rate limit exceeded", () => {
    // Send 60 messages (default limit)
    for (let i = 0; i < 60; i++) {
      checkMessageRate(PROJECT, "channel-1");
    }

    const result = checkMessageRate(PROJECT, "channel-1");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("rate limit");
  });

  it("isolates rate tracking per channel", () => {
    for (let i = 0; i < 60; i++) {
      checkMessageRate(PROJECT, "channel-1");
    }

    // Different channel should be fine
    const result = checkMessageRate(PROJECT, "channel-2");
    expect(result.ok).toBe(true);
  });
});
