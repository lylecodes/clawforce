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
const { recordMetric } = await import("../../src/metrics.js");
const { evaluateSlos } = await import("../../src/monitoring/slo.js");

let db: ReturnType<typeof getMemoryDb>;

beforeEach(() => {
  db = getMemoryDb();
});

afterEach(() => {
  try { db.close(); } catch {}
});

describe("evaluateSlos", () => {
  it("passes when metric is within threshold", () => {
    // Record metrics with values below 1000
    recordMetric({ projectId: "p1", type: "task_cycle", key: "cycle_time", value: 500 }, db);
    recordMetric({ projectId: "p1", type: "task_cycle", key: "cycle_time", value: 800 }, db);

    const results = evaluateSlos("p1", {
      task_resolution: {
        name: "task_resolution",
        metricType: "task_cycle",
        metricKey: "cycle_time",
        aggregation: "avg",
        condition: "lt",
        threshold: 1000,
        windowMs: 3600000,
        severity: "warning",
      },
    }, db);

    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.actual).toBe(650);
  });

  it("breaches when metric exceeds threshold", () => {
    recordMetric({ projectId: "p1", type: "task_cycle", key: "cycle_time", value: 5000 }, db);
    recordMetric({ projectId: "p1", type: "task_cycle", key: "cycle_time", value: 8000 }, db);

    const results = evaluateSlos("p1", {
      fast_resolution: {
        name: "fast_resolution",
        metricType: "task_cycle",
        metricKey: "cycle_time",
        aggregation: "avg",
        condition: "lt",
        threshold: 3000,
        windowMs: 3600000,
        severity: "critical",
      },
    }, db);

    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.actual).toBe(6500);
  });

  it("handles no metrics gracefully (vacuous pass)", () => {
    const results = evaluateSlos("p1", {
      empty_check: {
        name: "empty_check",
        metricType: "task_cycle",
        metricKey: "nonexistent",
        aggregation: "avg",
        condition: "lt",
        threshold: 1000,
        windowMs: 3600000,
        severity: "warning",
      },
    }, db);

    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.actual).toBeNull();
  });

  it("creates breach task on failure with onBreach config", () => {
    recordMetric({ projectId: "p1", type: "task_cycle", key: "cycle_time", value: 5000 }, db);

    const results = evaluateSlos("p1", {
      slow_resolution: {
        name: "slow_resolution",
        metricType: "task_cycle",
        metricKey: "cycle_time",
        aggregation: "avg",
        condition: "lt",
        threshold: 1000,
        windowMs: 3600000,
        severity: "critical",
        onBreach: {
          action: "create_task",
          taskTitle: "SLO breach: resolution time",
          taskPriority: "P1",
        },
      },
    }, db);

    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.breachTaskId).toBeTruthy();

    // Verify task was created
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(results[0]!.breachTaskId) as Record<string, unknown>;
    expect(task).toBeTruthy();
    expect(task.title).toBe("SLO breach: resolution time");
    expect(task.priority).toBe("P1");
  });

  it("deduplicates breach tasks", () => {
    recordMetric({ projectId: "p1", type: "task_cycle", key: "cycle_time", value: 5000 }, db);

    const sloConfig = {
      slow: {
        name: "slow",
        metricType: "task_cycle" as const,
        metricKey: "cycle_time",
        aggregation: "avg" as const,
        condition: "lt" as const,
        threshold: 1000,
        windowMs: 3600000,
        severity: "critical" as const,
        onBreach: { action: "create_task" as const, taskTitle: "SLO breach" },
      },
    };

    const results1 = evaluateSlos("p1", sloConfig, db);
    const results2 = evaluateSlos("p1", sloConfig, db);

    // Both should reference the same task
    expect(results1[0]!.breachTaskId).toBe(results2[0]!.breachTaskId);

    // Only one task should exist
    const tasks = db.prepare("SELECT * FROM tasks WHERE title = 'SLO breach'").all() as Record<string, unknown>[];
    expect(tasks).toHaveLength(1);
  });

  it("records evaluation to DB", () => {
    recordMetric({ projectId: "p1", type: "task_cycle", key: "cycle_time", value: 500 }, db);

    evaluateSlos("p1", {
      check: {
        name: "check",
        metricType: "task_cycle",
        metricKey: "cycle_time",
        aggregation: "avg",
        condition: "lt",
        threshold: 1000,
        windowMs: 3600000,
        severity: "warning",
      },
    }, db);

    const rows = db.prepare("SELECT * FROM slo_evaluations WHERE project_id = 'p1'").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slo_name).toBe("check");
    expect(rows[0]!.passed).toBe(1);
  });
});
