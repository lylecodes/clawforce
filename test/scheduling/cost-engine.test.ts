import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");

function insertGoal(db: DatabaseSync, projectId: string, title: string, allocation?: number, parentGoalId?: string): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO goals (id, project_id, title, status, parent_goal_id, created_by, created_at, allocation)
    VALUES (?, ?, ?, 'active', ?, 'test', ?, ?)
  `).run(id, projectId, title, parentGoalId ?? null, now, allocation ?? null);
  return id;
}

function insertTaskWithGoal(db: DatabaseSync, projectId: string, goalId: string, assignedTo: string): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, state, priority, goal_id, assigned_to, created_by, created_at, updated_at, retry_count, max_retries)
    VALUES (?, ?, 'Test', 'DONE', 'P2', ?, ?, 'test', ?, ?, 0, 3)
  `).run(id, projectId, goalId, assignedTo, now, now);
  return id;
}

function insertCostRecord(db: DatabaseSync, projectId: string, taskId: string, agentId: string, costCents: number, model: string = "claude-sonnet-4-6"): void {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO cost_records (id, project_id, agent_id, task_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, source, model, created_at)
    VALUES (?, ?, ?, ?, 1000, 500, 0, 0, ?, 'dispatch', ?, ?)
  `).run(id, projectId, agentId, taskId, costCents, model, Date.now());
}

describe("getCostEstimate", () => {
  let db: DatabaseSync;
  const PROJECT = "cost-engine-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("returns initiative + agent + model average when enough data (medium confidence at 5 sessions)", async () => {
    const { getCostEstimate } = await import("../../src/scheduling/cost-engine.js");

    const goalId = insertGoal(db, PROJECT, "UI Work", 40);
    for (let i = 0; i < 5; i++) {
      const taskId = insertTaskWithGoal(db, PROJECT, goalId, "agent-a");
      insertCostRecord(db, PROJECT, taskId, "agent-a", 100 + i * 10, "claude-sonnet-4-6");
    }

    const estimate = getCostEstimate(PROJECT, goalId, "agent-a", "claude-sonnet-4-6", db);
    expect(estimate.averageCents).toBeGreaterThan(0);
    expect(estimate.sessionCount).toBe(5);
    expect(estimate.confidence).toBe("medium");
  });

  it("falls back to initiative + model when agent data is sparse", async () => {
    const { getCostEstimate } = await import("../../src/scheduling/cost-engine.js");

    const goalId = insertGoal(db, PROJECT, "UI Work", 40);
    for (let i = 0; i < 5; i++) {
      const taskId = insertTaskWithGoal(db, PROJECT, goalId, "agent-a");
      insertCostRecord(db, PROJECT, taskId, "agent-a", 200, "claude-opus-4-6");
    }

    const estimate = getCostEstimate(PROJECT, goalId, "agent-b", "claude-opus-4-6", db);
    expect(estimate.averageCents).toBe(200);
    expect(estimate.confidence).toBe("medium");
  });

  it("falls back to global default when no data exists", async () => {
    const { getCostEstimate } = await import("../../src/scheduling/cost-engine.js");

    const goalId = insertGoal(db, PROJECT, "Brand New Initiative", 20);

    const estimate = getCostEstimate(PROJECT, goalId, "agent-x", "claude-sonnet-4-6", db);
    expect(estimate.averageCents).toBe(150);
    expect(estimate.sessionCount).toBe(0);
    expect(estimate.confidence).toBe("low");
  });

  it("returns high confidence with 10+ sessions at finest granularity", async () => {
    const { getCostEstimate } = await import("../../src/scheduling/cost-engine.js");

    const goalId = insertGoal(db, PROJECT, "Well-known Work", 50);
    for (let i = 0; i < 12; i++) {
      const taskId = insertTaskWithGoal(db, PROJECT, goalId, "agent-a");
      insertCostRecord(db, PROJECT, taskId, "agent-a", 150, "claude-sonnet-4-6");
    }

    const estimate = getCostEstimate(PROJECT, goalId, "agent-a", "claude-sonnet-4-6", db);
    expect(estimate.confidence).toBe("high");
    expect(estimate.sessionCount).toBe(12);
  });
});
