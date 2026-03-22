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
  activateEmergencyStop,
  deactivateEmergencyStop,
  isEmergencyStopActive,
  checkEmergencyStop,
  checkSpendRateWarning,
  getConsecutiveFailures,
  checkQueueDepth,
} = await import("../../src/safety.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-safety-rails";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

// --- Emergency stop ---

describe("emergency stop", () => {
  it("is not active by default", () => {
    expect(isEmergencyStopActive(PROJECT, db)).toBe(false);
  });

  it("blocks dispatch when activated", () => {
    activateEmergencyStop(PROJECT, db);
    expect(isEmergencyStopActive(PROJECT, db)).toBe(true);

    const result = checkEmergencyStop(PROJECT, db);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("Emergency stop");
  });

  it("allows dispatch after deactivation", () => {
    activateEmergencyStop(PROJECT, db);
    expect(isEmergencyStopActive(PROJECT, db)).toBe(true);

    deactivateEmergencyStop(PROJECT, db);
    expect(isEmergencyStopActive(PROJECT, db)).toBe(false);

    const result = checkEmergencyStop(PROJECT, db);
    expect(result.ok).toBe(true);
  });

  it("persists across multiple checks", () => {
    activateEmergencyStop(PROJECT, db);

    // Multiple checks should all return active
    expect(isEmergencyStopActive(PROJECT, db)).toBe(true);
    expect(isEmergencyStopActive(PROJECT, db)).toBe(true);

    deactivateEmergencyStop(PROJECT, db);
    expect(isEmergencyStopActive(PROJECT, db)).toBe(false);
  });

  it("is project-scoped — does not affect other projects", () => {
    activateEmergencyStop(PROJECT, db);
    expect(isEmergencyStopActive("other-project", db)).toBe(false);
  });
});

// --- Max queue depth ---

describe("max queue depth", () => {
  it("allows enqueue when queue is empty", () => {
    const result = checkQueueDepth(PROJECT, db);
    expect(result.ok).toBe(true);
  });

  it("blocks enqueue when queue is at limit", () => {
    // Default maxQueueDepth is 50 — insert 50 queued items
    const now = Date.now();
    for (let i = 0; i < 50; i++) {
      db.prepare(`
        INSERT INTO dispatch_queue (id, project_id, task_id, priority, status, dispatch_attempts, max_dispatch_attempts, created_at)
        VALUES (?, ?, ?, 2, 'queued', 0, 3, ?)
      `).run(`q${i}`, PROJECT, `t${i}`, now);
    }

    const result = checkQueueDepth(PROJECT, db);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("Queue depth limit reached");
    expect(result.ok === false && result.reason).toContain("50/50");
  });

  it("counts leased items toward depth", () => {
    const now = Date.now();
    // 25 queued + 25 leased = 50 total
    for (let i = 0; i < 25; i++) {
      db.prepare(`
        INSERT INTO dispatch_queue (id, project_id, task_id, priority, status, dispatch_attempts, max_dispatch_attempts, created_at)
        VALUES (?, ?, ?, 2, 'queued', 0, 3, ?)
      `).run(`q${i}`, PROJECT, `tq${i}`, now);
    }
    for (let i = 0; i < 25; i++) {
      db.prepare(`
        INSERT INTO dispatch_queue (id, project_id, task_id, priority, status, dispatch_attempts, max_dispatch_attempts, created_at)
        VALUES (?, ?, ?, 2, 'leased', 0, 3, ?)
      `).run(`l${i}`, PROJECT, `tl${i}`, now);
    }

    const result = checkQueueDepth(PROJECT, db);
    expect(result.ok).toBe(false);
  });

  it("does not count completed/failed items toward depth", () => {
    const now = Date.now();
    for (let i = 0; i < 50; i++) {
      db.prepare(`
        INSERT INTO dispatch_queue (id, project_id, task_id, priority, status, dispatch_attempts, max_dispatch_attempts, created_at)
        VALUES (?, ?, ?, 2, 'completed', 1, 3, ?)
      `).run(`c${i}`, PROJECT, `tc${i}`, now);
    }

    const result = checkQueueDepth(PROJECT, db);
    expect(result.ok).toBe(true);
  });
});

// --- Spend rate warning ---

describe("spend rate warning", () => {
  it("returns no warning when no budget set", () => {
    const result = checkSpendRateWarning(PROJECT, undefined, db);
    expect(result.warning).toBe(false);
    expect(result.pct).toBe(0);
  });

  it("returns no warning when under threshold", () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
    `).run("b1", PROJECT, 1000, 500, now + 86_400_000, now, now);

    const result = checkSpendRateWarning(PROJECT, undefined, db);
    expect(result.warning).toBe(false);
    expect(result.pct).toBe(50);
  });

  it("fires warning at 80% threshold", () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
    `).run("b1", PROJECT, 1000, 800, now + 86_400_000, now, now);

    const result = checkSpendRateWarning(PROJECT, undefined, db);
    expect(result.warning).toBe(true);
    expect(result.pct).toBe(80);
    expect(result.reason).toContain("Spend rate warning");
    expect(result.reason).toContain("80%");
  });

  it("checks agent-level spend", () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("b1", PROJECT, "agent1", 500, 450, now + 86_400_000, now, now);

    const result = checkSpendRateWarning(PROJECT, "agent1", db);
    expect(result.warning).toBe(true);
    expect(result.pct).toBe(90);
  });
});

// --- Consecutive failures ---

describe("max consecutive failures", () => {
  it("returns 0 when no audit runs", () => {
    const count = getConsecutiveFailures(PROJECT, "agent1", db);
    expect(count).toBe(0);
  });

  it("counts consecutive non-success runs", () => {
    const now = Date.now();
    // Insert 3 consecutive failures
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, started_at, ended_at, duration_ms)
        VALUES (?, ?, ?, ?, 'non_compliant', ?, ?, 1000)
      `).run(`r${i}`, PROJECT, "agent1", `s${i}`, now - (3 - i) * 1000, now - (3 - i) * 1000 + 500);
    }

    const count = getConsecutiveFailures(PROJECT, "agent1", db);
    expect(count).toBe(3);
  });

  it("resets count on success", () => {
    const now = Date.now();
    // 2 failures, then 1 success, then 1 failure
    db.prepare(`
      INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, started_at, ended_at, duration_ms)
      VALUES (?, ?, ?, ?, 'non_compliant', ?, ?, 1000)
    `).run("r0", PROJECT, "agent1", "s0", now - 4000, now - 3500);
    db.prepare(`
      INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, started_at, ended_at, duration_ms)
      VALUES (?, ?, ?, ?, 'non_compliant', ?, ?, 1000)
    `).run("r1", PROJECT, "agent1", "s1", now - 3000, now - 2500);
    db.prepare(`
      INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, started_at, ended_at, duration_ms)
      VALUES (?, ?, ?, ?, 'success', ?, ?, 1000)
    `).run("r2", PROJECT, "agent1", "s2", now - 2000, now - 1500);
    db.prepare(`
      INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, started_at, ended_at, duration_ms)
      VALUES (?, ?, ?, ?, 'non_compliant', ?, ?, 1000)
    `).run("r3", PROJECT, "agent1", "s3", now - 1000, now - 500);

    // Only the most recent failure (after success) should count
    const count = getConsecutiveFailures(PROJECT, "agent1", db);
    expect(count).toBe(1);
  });

  it("counts crashed as failures", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, started_at, ended_at, duration_ms)
        VALUES (?, ?, ?, ?, 'crashed', ?, ?, 1000)
      `).run(`r${i}`, PROJECT, "agent1", `s${i}`, now - (5 - i) * 1000, now - (5 - i) * 1000 + 500);
    }

    const count = getConsecutiveFailures(PROJECT, "agent1", db);
    expect(count).toBe(5);
  });

  it("is agent-scoped", () => {
    const now = Date.now();
    // Failures for agent1
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, started_at, ended_at, duration_ms)
        VALUES (?, ?, ?, ?, 'non_compliant', ?, ?, 1000)
      `).run(`a1r${i}`, PROJECT, "agent1", `a1s${i}`, now - (3 - i) * 1000, now - (3 - i) * 1000 + 500);
    }

    // agent2 has no failures
    const count1 = getConsecutiveFailures(PROJECT, "agent1", db);
    const count2 = getConsecutiveFailures(PROJECT, "agent2", db);
    expect(count1).toBe(3);
    expect(count2).toBe(0);
  });
});
