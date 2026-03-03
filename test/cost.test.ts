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
const { recordCost, getCostSummary, getTaskCost, calculateCostCents } = await import("../src/cost.js");

let db: ReturnType<typeof getMemoryDb>;

beforeEach(() => {
  db = getMemoryDb();
});

afterEach(() => {
  try { db.close(); } catch {}
});

describe("calculateCostCents", () => {
  it("calculates cost for known model", () => {
    const cost = calculateCostCents({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      model: "sonnet",
    });
    // 300 (input) + 1500 (output) = 1800 cents
    expect(cost).toBe(1800);
  });

  it("applies cache pricing", () => {
    const cost = calculateCostCents({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      model: "sonnet",
    });
    // 30 (cache read) + 375 (cache write) = 405 cents
    expect(cost).toBe(405);
  });

  it("uses default pricing for unknown model", () => {
    const cost = calculateCostCents({
      inputTokens: 1_000_000,
      outputTokens: 0,
      model: "unknown-model",
    });
    // Default pricing = sonnet pricing = 300 cents
    expect(cost).toBe(300);
  });

  it("handles zero tokens", () => {
    const cost = calculateCostCents({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBe(0);
  });
});

describe("recordCost", () => {
  it("writes to cost_records and returns correct shape", () => {
    const record = recordCost({
      projectId: "p1",
      agentId: "worker-1",
      taskId: "task-1",
      inputTokens: 500,
      outputTokens: 200,
      model: "sonnet",
      source: "dispatch",
    }, db);

    expect(record.id).toBeTruthy();
    expect(record.projectId).toBe("p1");
    expect(record.agentId).toBe("worker-1");
    expect(record.taskId).toBe("task-1");
    expect(record.inputTokens).toBe(500);
    expect(record.outputTokens).toBe(200);
    expect(record.costCents).toBeGreaterThanOrEqual(0);
    expect(record.createdAt).toBeGreaterThan(0);
  });

  it("stores record in database", () => {
    recordCost({
      projectId: "p1",
      agentId: "worker-1",
      inputTokens: 1000,
      outputTokens: 500,
    }, db);

    const rows = db.prepare("SELECT * FROM cost_records WHERE project_id = 'p1'").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBe("worker-1");
    expect(rows[0]!.input_tokens).toBe(1000);
  });

  it("also records a metric", () => {
    recordCost({
      projectId: "p1",
      agentId: "worker-1",
      inputTokens: 1000,
      outputTokens: 500,
    }, db);

    const metrics = db.prepare("SELECT * FROM metrics WHERE type = 'cost'").all() as Record<string, unknown>[];
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.key).toBe("cost_cents");
  });
});

describe("getCostSummary", () => {
  beforeEach(() => {
    recordCost({ projectId: "p1", agentId: "a1", taskId: "t1", inputTokens: 1000, outputTokens: 500, model: "sonnet" }, db);
    recordCost({ projectId: "p1", agentId: "a2", taskId: "t2", inputTokens: 2000, outputTokens: 1000, model: "sonnet" }, db);
    recordCost({ projectId: "p2", agentId: "a3", inputTokens: 500, outputTokens: 100 }, db);
  });

  it("returns project-level summary", () => {
    const summary = getCostSummary({ projectId: "p1" }, db);
    expect(summary.recordCount).toBe(2);
    expect(summary.totalCostCents).toBeGreaterThan(0);
    expect(summary.totalInputTokens).toBe(3000);
    expect(summary.totalOutputTokens).toBe(1500);
  });

  it("filters by agent", () => {
    const summary = getCostSummary({ projectId: "p1", agentId: "a1" }, db);
    expect(summary.recordCount).toBe(1);
    expect(summary.totalInputTokens).toBe(1000);
  });

  it("returns zero for unknown project", () => {
    const summary = getCostSummary({ projectId: "unknown" }, db);
    expect(summary.recordCount).toBe(0);
    expect(summary.totalCostCents).toBe(0);
  });
});

describe("getTaskCost", () => {
  it("returns cost for a specific task", () => {
    recordCost({ projectId: "p1", agentId: "a1", taskId: "task-42", inputTokens: 100, outputTokens: 50 }, db);
    recordCost({ projectId: "p1", agentId: "a1", taskId: "task-42", inputTokens: 200, outputTokens: 100 }, db);
    recordCost({ projectId: "p1", agentId: "a1", taskId: "task-99", inputTokens: 999, outputTokens: 999 }, db);

    const cost = getTaskCost("p1", "task-42", db);
    expect(cost.recordCount).toBe(2);
    expect(cost.totalInputTokens).toBe(300);
    expect(cost.totalOutputTokens).toBe(150);
  });
});
