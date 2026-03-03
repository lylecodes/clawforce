import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

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
const { recordMetric, queryMetrics, aggregateMetrics, recordTaskCycleTime, recordDispatchMetric } = await import("../../src/metrics.js");

let db: ReturnType<typeof getMemoryDb>;

beforeEach(() => {
  db = getMemoryDb();
});

afterEach(() => {
  try { db.close(); } catch {}
});

describe("recordMetric", () => {
  it("writes to DB and returns correct shape", () => {
    const metric = recordMetric({
      projectId: "p1",
      type: "task_cycle",
      subject: "task-1",
      key: "cycle_time",
      value: 5000,
      unit: "ms",
      tags: { agent: "worker-1" },
    }, db);

    expect(metric.id).toBeTruthy();
    expect(metric.projectId).toBe("p1");
    expect(metric.type).toBe("task_cycle");
    expect(metric.subject).toBe("task-1");
    expect(metric.key).toBe("cycle_time");
    expect(metric.value).toBe(5000);
    expect(metric.unit).toBe("ms");
    expect(metric.tags).toEqual({ agent: "worker-1" });
    expect(metric.createdAt).toBeGreaterThan(0);
  });

  it("stores metric in database", () => {
    recordMetric({ projectId: "p1", type: "system", key: "health", value: 1 }, db);
    const rows = db.prepare("SELECT * FROM metrics WHERE project_id = 'p1'").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("health");
  });
});

describe("queryMetrics", () => {
  beforeEach(() => {
    recordMetric({ projectId: "p1", type: "task_cycle", subject: "t1", key: "cycle_time", value: 1000 }, db);
    recordMetric({ projectId: "p1", type: "dispatch", subject: "t2", key: "dispatch_duration", value: 2000 }, db);
    recordMetric({ projectId: "p1", type: "task_cycle", subject: "t3", key: "cycle_time", value: 3000 }, db);
    recordMetric({ projectId: "p2", type: "task_cycle", key: "cycle_time", value: 9999 }, db);
  });

  it("filters by project", () => {
    const results = queryMetrics({ projectId: "p1" }, db);
    expect(results).toHaveLength(3);
    expect(results.every(m => m.projectId === "p1")).toBe(true);
  });

  it("filters by type", () => {
    const results = queryMetrics({ projectId: "p1", type: "dispatch" }, db);
    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe("dispatch");
  });

  it("filters by subject", () => {
    const results = queryMetrics({ projectId: "p1", subject: "t1" }, db);
    expect(results).toHaveLength(1);
    expect(results[0]!.subject).toBe("t1");
  });

  it("filters by since", () => {
    const now = Date.now();
    recordMetric({ projectId: "p1", type: "system", key: "future", value: 42 }, db);
    const results = queryMetrics({ projectId: "p1", since: now - 10 }, db);
    // Should include the one we just created (and possibly the others if fast enough)
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("respects limit", () => {
    const results = queryMetrics({ projectId: "p1", limit: 2 }, db);
    expect(results).toHaveLength(2);
  });
});

describe("aggregateMetrics", () => {
  beforeEach(() => {
    recordMetric({ projectId: "p1", type: "task_cycle", subject: "agent-a", key: "cycle_time", value: 1000 }, db);
    recordMetric({ projectId: "p1", type: "task_cycle", subject: "agent-a", key: "cycle_time", value: 3000 }, db);
    recordMetric({ projectId: "p1", type: "task_cycle", subject: "agent-b", key: "cycle_time", value: 5000 }, db);
  });

  it("aggregates by key", () => {
    const results = aggregateMetrics({ projectId: "p1", key: "cycle_time" }, db);
    expect(results).toHaveLength(1);
    expect(results[0]!.count).toBe(3);
    expect(results[0]!.sum).toBe(9000);
    expect(results[0]!.min).toBe(1000);
    expect(results[0]!.max).toBe(5000);
  });

  it("groups by subject", () => {
    const results = aggregateMetrics({ projectId: "p1", key: "cycle_time", groupBy: "subject" }, db);
    expect(results).toHaveLength(2);
    const agentA = results.find(r => r.key === "agent-a")!;
    expect(agentA.count).toBe(2);
    expect(agentA.avg).toBe(2000);
  });
});

describe("recordTaskCycleTime", () => {
  it("computes correct cycle_time value", () => {
    const createdAt = 1000;
    const completedAt = 6000;
    recordTaskCycleTime("p1", "task-1", createdAt, completedAt, "worker-1", db);

    const metrics = queryMetrics({ projectId: "p1", type: "task_cycle" }, db);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.value).toBe(5000);
    expect(metrics[0]!.subject).toBe("task-1");
    expect(metrics[0]!.unit).toBe("ms");
    expect(metrics[0]!.tags).toEqual({ assignedTo: "worker-1" });
  });
});

describe("recordDispatchMetric", () => {
  it("stores duration and tags", () => {
    recordDispatchMetric("p1", "task-1", {
      durationMs: 30000,
      exitCode: 0,
      profile: "fast",
      model: "claude-sonnet",
    }, db);

    const metrics = queryMetrics({ projectId: "p1", type: "dispatch" }, db);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.value).toBe(30000);
    expect(metrics[0]!.unit).toBe("ms");
    expect(metrics[0]!.tags).toEqual({
      exitCode: 0,
      profile: "fast",
      model: "claude-sonnet",
      success: true,
    });
  });

  it("records failure exit code", () => {
    recordDispatchMetric("p1", "task-2", {
      durationMs: 5000,
      exitCode: 1,
    }, db);

    const metrics = queryMetrics({ projectId: "p1", type: "dispatch" }, db);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.tags!.success).toBe(false);
    expect(metrics[0]!.tags!.exitCode).toBe(1);
  });
});
