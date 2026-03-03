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
const { aggregateMetrics, recordMetric } = await import("../src/metrics.js");

let db: ReturnType<typeof getMemoryDb>;

beforeEach(() => {
  db = getMemoryDb();
  // Seed metrics with different subjects and types
  recordMetric({ projectId: "p1", type: "task_cycle", subject: "agent-a", key: "cycle_time", value: 1000 }, db);
  recordMetric({ projectId: "p1", type: "task_cycle", subject: "agent-b", key: "cycle_time", value: 2000 }, db);
  recordMetric({ projectId: "p1", type: "dispatch", subject: "agent-a", key: "cycle_time", value: 3000 }, db);
});

afterEach(() => {
  try { db.close(); } catch {}
});

describe("aggregateMetrics — groupBy whitelist", () => {
  it("groupBy='subject' works and groups by subject", () => {
    const results = aggregateMetrics({ projectId: "p1", key: "cycle_time", groupBy: "subject" }, db);
    expect(results.length).toBe(2);
    const agentA = results.find(r => r.key === "agent-a");
    const agentB = results.find(r => r.key === "agent-b");
    expect(agentA).toBeTruthy();
    expect(agentB).toBeTruthy();
    // agent-a has two entries: 1000 + 3000
    expect(agentA!.count).toBe(2);
    expect(agentA!.sum).toBe(4000);
    // agent-b has one entry: 2000
    expect(agentB!.count).toBe(1);
    expect(agentB!.sum).toBe(2000);
  });

  it("groupBy='type' works and groups by type", () => {
    const results = aggregateMetrics({ projectId: "p1", key: "cycle_time", groupBy: "type" }, db);
    expect(results.length).toBe(2);
    const taskCycle = results.find(r => r.key === "task_cycle");
    const dispatch = results.find(r => r.key === "dispatch");
    expect(taskCycle).toBeTruthy();
    expect(dispatch).toBeTruthy();
    expect(taskCycle!.count).toBe(2);
    expect(dispatch!.count).toBe(1);
  });

  it("default groupBy (key) works", () => {
    const results = aggregateMetrics({ projectId: "p1", key: "cycle_time" }, db);
    // All three metrics share the same key, so one group
    expect(results).toHaveLength(1);
    expect(results[0]!.count).toBe(3);
    expect(results[0]!.sum).toBe(6000);
    expect(results[0]!.key).toBe("cycle_time");
  });

  it("throws on SQL injection attempt like 'id; DROP TABLE'", () => {
    expect(() =>
      aggregateMetrics({ projectId: "p1", key: "cycle_time", groupBy: "id; DROP TABLE" as any }, db),
    ).toThrow("Invalid groupBy column");
  });

  it("throws on arbitrary string groupBy", () => {
    expect(() =>
      aggregateMetrics({ projectId: "p1", key: "cycle_time", groupBy: "nonexistent_column" as any }, db),
    ).toThrow("Invalid groupBy column");
  });
});
