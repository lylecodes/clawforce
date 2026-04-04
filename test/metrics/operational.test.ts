import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

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
const {
  getAgentSaturation,
  getQueueWaitTime,
  getAgentThroughput,
  getCostEfficiency,
  getSessionEfficiency,
  getTaskCycleTime,
  getFailureRate,
  getRetryRate,
  getAllOperationalMetrics,
} = await import("../../src/metrics/operational.js");

type MemDb = ReturnType<typeof getMemoryDb>;

let db: MemDb;
const PROJECT = "test-project";
const NOW = Date.now();

function insertTask(db: MemDb, overrides: Partial<{
  id: string; state: string; assignedTo: string; priority: string;
  createdAt: number; updatedAt: number; goalId: string;
}> = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, state, priority, assigned_to, created_by, created_at, updated_at, goal_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, PROJECT, `Task ${id.slice(0, 8)}`,
    overrides.state ?? "OPEN",
    overrides.priority ?? "P2",
    overrides.assignedTo ?? null,
    "system",
    overrides.createdAt ?? NOW - 3_600_000,
    overrides.updatedAt ?? NOW,
    overrides.goalId ?? null,
  );
  return id;
}

function insertTransition(db: MemDb, taskId: string, fromState: string, toState: string, actor: string, createdAt: number) {
  db.prepare(`
    INSERT INTO transitions (id, task_id, from_state, to_state, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), taskId, fromState, toState, actor, createdAt);
}

function insertSession(db: MemDb, agentId: string, startedAt: number, endedAt: number) {
  db.prepare(`
    INSERT INTO session_archives (id, session_key, agent_id, project_id, outcome, started_at, ended_at, duration_ms, tool_call_count, error_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    `agent:${agentId}:cron:${crypto.randomUUID()}`,
    agentId, PROJECT, "success",
    startedAt, endedAt, endedAt - startedAt,
    5, 0, startedAt,
  );
}

function insertCostRecord(db: MemDb, agentId: string, costCents: number, createdAt: number) {
  db.prepare(`
    INSERT INTO cost_records (id, project_id, agent_id, model, provider, cost_cents, input_tokens, output_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), PROJECT, agentId, "claude", "anthropic", costCents, 1000, 500, createdAt);
}

function insertQueueItem(db: MemDb, taskId: string, status: string) {
  db.prepare(`
    INSERT INTO dispatch_queue (id, project_id, task_id, status, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), PROJECT, taskId, status, NOW);
}

beforeEach(() => {
  db = getMemoryDb();
});

afterEach(() => {
  try { db.close(); } catch {}
});

describe("getAgentSaturation", () => {
  it("returns empty for projects with no tasks", () => {
    const result = getAgentSaturation(PROJECT, 24, db);
    expect(result).toEqual([]);
  });

  it("computes saturation correctly", () => {
    // Agent has 2 assigned tasks, 1 queued dispatch, completed 3 in 24h
    const t1 = insertTask(db, { state: "ASSIGNED", assignedTo: "worker-1" });
    const t2 = insertTask(db, { state: "IN_PROGRESS", assignedTo: "worker-1" });
    const t3 = insertTask(db, { state: "DONE", assignedTo: "worker-1" });

    // Insert queue item for t1
    insertQueueItem(db, t1, "queued");

    // Completed transitions in window
    insertTransition(db, t3, "IN_PROGRESS", "DONE", "agent:worker-1:cron:x", NOW - 3_600_000);
    const t4 = insertTask(db, { state: "DONE", assignedTo: "worker-1" });
    insertTransition(db, t4, "IN_PROGRESS", "DONE", "agent:worker-1:cron:x", NOW - 7_200_000);
    const t5 = insertTask(db, { state: "DONE", assignedTo: "worker-1" });
    insertTransition(db, t5, "IN_PROGRESS", "DONE", "agent:worker-1:cron:x", NOW - 10_800_000);

    const result = getAgentSaturation(PROJECT, 24, db);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const worker = result.find((r) => r.agentId === "worker-1");
    expect(worker).toBeDefined();
    expect(worker!.assignedTasks).toBe(2);
    expect(worker!.queuedDispatches).toBe(1);
    // 3 completed in 24h = 0.125/hr, saturation = 3 / 0.125 = 24
    expect(worker!.saturation).toBeGreaterThan(0);
  });
});

describe("getQueueWaitTime", () => {
  it("returns empty when no ASSIGNED->IN_PROGRESS transitions exist", () => {
    const result = getQueueWaitTime(PROJECT, 24, db);
    expect(result).toEqual([]);
  });

  it("computes wait time from transitions", () => {
    const t1 = insertTask(db, { state: "IN_PROGRESS", assignedTo: "worker-1" });
    const assignedAt = NOW - 600_000; // 10 min ago
    const inProgressAt = NOW - 300_000; // 5 min ago (5 min wait)
    insertTransition(db, t1, "OPEN", "ASSIGNED", "system", assignedAt);
    insertTransition(db, t1, "ASSIGNED", "IN_PROGRESS", "agent:worker-1:cron:x", inProgressAt);

    const result = getQueueWaitTime(PROJECT, 24, db);
    expect(result.length).toBe(1);
    expect(result[0]!.agentId).toBe("worker-1");
    expect(result[0]!.avgWaitMs).toBe(300_000); // 5 minutes
    expect(result[0]!.sampleCount).toBe(1);
  });
});

describe("getAgentThroughput", () => {
  it("returns empty with no completions", () => {
    const result = getAgentThroughput(PROJECT, db);
    expect(result).toEqual([]);
  });

  it("counts completions in time windows", () => {
    const t1 = insertTask(db, { state: "DONE", assignedTo: "worker-1" });
    insertTransition(db, t1, "IN_PROGRESS", "DONE", "agent:worker-1:cron:x", NOW - 1_800_000); // 30 min ago

    const t2 = insertTask(db, { state: "DONE", assignedTo: "worker-1" });
    insertTransition(db, t2, "IN_PROGRESS", "DONE", "agent:worker-1:cron:x", NOW - 7_200_000); // 2h ago

    const result = getAgentThroughput(PROJECT, db);
    expect(result.length).toBe(1);
    expect(result[0]!.agentId).toBe("worker-1");
    expect(result[0]!.completedLastHour).toBe(1);
    expect(result[0]!.completedLast4Hours).toBe(2);
    expect(result[0]!.completedLast24Hours).toBe(2);
  });
});

describe("getCostEfficiency", () => {
  it("computes cost per completed task", () => {
    const t1 = insertTask(db, { state: "DONE", assignedTo: "worker-1" });
    insertTransition(db, t1, "IN_PROGRESS", "DONE", "agent:worker-1:cron:x", NOW - 1_800_000);
    insertCostRecord(db, "worker-1", 500, NOW - 1_800_000);

    const result = getCostEfficiency(PROJECT, 24, db);
    expect(result.length).toBe(1);
    expect(result[0]!.agentId).toBe("worker-1");
    expect(result[0]!.totalCostCents).toBe(500);
    expect(result[0]!.tasksCompleted).toBe(1);
    expect(result[0]!.costPerTaskCents).toBe(500);
  });
});

describe("getSessionEfficiency", () => {
  it("returns empty with no sessions", () => {
    const result = getSessionEfficiency(PROJECT, 24, db);
    expect(result).toEqual([]);
  });

  it("identifies productive vs empty sessions", () => {
    // Session that produced a transition
    const sessionStart = NOW - 600_000;
    const sessionEnd = NOW - 300_000;
    insertSession(db, "worker-1", sessionStart, sessionEnd);

    const t1 = insertTask(db, { state: "DONE", assignedTo: "worker-1" });
    insertTransition(db, t1, "IN_PROGRESS", "DONE", "agent:worker-1:cron:test", sessionStart + 60_000);

    // Empty session
    insertSession(db, "worker-1", NOW - 200_000, NOW - 100_000);

    const result = getSessionEfficiency(PROJECT, 24, db);
    expect(result.length).toBe(1);
    expect(result[0]!.agentId).toBe("worker-1");
    expect(result[0]!.totalSessions).toBe(2);
    // At least one session should be productive
    expect(result[0]!.productiveSessions).toBeGreaterThanOrEqual(1);
  });
});

describe("getTaskCycleTime", () => {
  it("computes cycle time from task creation to DONE", () => {
    const createdAt = NOW - 3_600_000; // 1 hour ago
    const t1 = insertTask(db, {
      state: "DONE",
      assignedTo: "worker-1",
      priority: "P1",
      createdAt,
    });
    insertTransition(db, t1, "IN_PROGRESS", "DONE", "agent:worker-1:cron:x", NOW);

    const result = getTaskCycleTime(PROJECT, 24, db);
    expect(result.length).toBe(1);
    expect(result[0]!.agentId).toBe("worker-1");
    expect(result[0]!.priority).toBe("P1");
    expect(result[0]!.avgCycleMs).toBeGreaterThanOrEqual(3_500_000);
    expect(result[0]!.sampleCount).toBe(1);
  });
});

describe("getFailureRate", () => {
  it("computes failure rate per agent", () => {
    insertTask(db, { state: "DONE", assignedTo: "worker-1", updatedAt: NOW });
    insertTask(db, { state: "DONE", assignedTo: "worker-1", updatedAt: NOW });
    insertTask(db, { state: "FAILED", assignedTo: "worker-1", updatedAt: NOW });

    const result = getFailureRate(PROJECT, 168, db);
    expect(result.length).toBe(1);
    expect(result[0]!.agentId).toBe("worker-1");
    expect(result[0]!.doneTasks).toBe(2);
    expect(result[0]!.failedTasks).toBe(1);
    expect(result[0]!.failureRatePct).toBe(33);
  });
});

describe("getRetryRate", () => {
  it("counts FAILED -> OPEN cycles", () => {
    const t1 = insertTask(db, { state: "OPEN", assignedTo: "worker-1" });
    insertTransition(db, t1, "IN_PROGRESS", "FAILED", "system", NOW - 3_600_000);
    insertTransition(db, t1, "FAILED", "OPEN", "system:sweep", NOW - 3_500_000);
    insertTransition(db, t1, "IN_PROGRESS", "FAILED", "system", NOW - 1_800_000);
    insertTransition(db, t1, "FAILED", "OPEN", "system:sweep", NOW - 1_700_000);

    const result = getRetryRate(PROJECT, 168, db);
    expect(result.length).toBe(1);
    expect(result[0]!.agentId).toBe("worker-1");
    expect(result[0]!.retryCycles).toBe(2);
    expect(result[0]!.tasksWithRetries).toBe(1);
  });
});

describe("getAllOperationalMetrics", () => {
  it("returns all metric categories", () => {
    const result = getAllOperationalMetrics(PROJECT, 24, db);
    expect(result).toHaveProperty("saturation");
    expect(result).toHaveProperty("queueWaitTime");
    expect(result).toHaveProperty("throughput");
    expect(result).toHaveProperty("costEfficiency");
    expect(result).toHaveProperty("sessionEfficiency");
    expect(result).toHaveProperty("cycleTime");
    expect(result).toHaveProperty("failureRate");
    expect(result).toHaveProperty("retryRate");
    // All should be arrays
    expect(Array.isArray(result.saturation)).toBe(true);
    expect(Array.isArray(result.queueWaitTime)).toBe(true);
    expect(Array.isArray(result.throughput)).toBe(true);
  });
});
