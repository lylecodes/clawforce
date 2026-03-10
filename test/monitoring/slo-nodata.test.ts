import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { recordMetric } = await import("../../src/metrics.js");
const { evaluateSlos } = await import("../../src/monitoring/slo.js");

describe("evaluateSlos no-data behavior", () => {
  let db: DatabaseSync;
  const PROJECT = "slo-nodata-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  it("returns passed=true with noData=true when no data exists", () => {
    const results = evaluateSlos(PROJECT, {
      empty_slo: {
        name: "empty_slo",
        metricType: "task_cycle",
        metricKey: "nonexistent_metric",
        aggregation: "avg",
        condition: "lt",
        threshold: 1000,
        windowMs: 3600000,
        severity: "warning",
      },
    }, db);

    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.noData).toBe(true);
    expect(results[0]!.actual).toBeNull();
  });

  it("returns passed without noData field when data exists and within threshold", () => {
    recordMetric({ projectId: PROJECT, type: "task_cycle", key: "cycle_time", value: 500 }, db);

    const results = evaluateSlos(PROJECT, {
      normal_slo: {
        name: "normal_slo",
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
    // noData should not be present (or undefined) when data exists
    expect(results[0]!.noData).toBeUndefined();
    expect(results[0]!.actual).toBe(500);
  });

  it("returns passed=false with noData=true when noDataPolicy is 'fail'", () => {
    const results = evaluateSlos(PROJECT, {
      strict_slo: {
        name: "strict_slo",
        metricType: "task_cycle",
        metricKey: "nonexistent_metric",
        aggregation: "avg",
        condition: "lt",
        threshold: 1000,
        windowMs: 3600000,
        severity: "critical",
        noDataPolicy: "fail",
      },
    }, db);

    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.noData).toBe(true);
    expect(results[0]!.actual).toBeNull();
  });

  it("returns passed=true with noData=true when noDataPolicy is 'warn'", () => {
    const results = evaluateSlos(PROJECT, {
      warn_slo: {
        name: "warn_slo",
        metricType: "task_cycle",
        metricKey: "nonexistent_metric",
        aggregation: "avg",
        condition: "lt",
        threshold: 1000,
        windowMs: 3600000,
        severity: "warning",
        noDataPolicy: "warn",
      },
    }, db);

    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.noData).toBe(true);
  });

  it("defaults to pass when noDataPolicy is not set", () => {
    const results = evaluateSlos(PROJECT, {
      default_slo: {
        name: "default_slo",
        metricType: "task_cycle",
        metricKey: "nonexistent_metric",
        aggregation: "avg",
        condition: "lt",
        threshold: 1000,
        windowMs: 3600000,
        severity: "warning",
      },
    }, db);

    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.noData).toBe(true);
  });

  it("returns passed=false without noData when data breaches threshold", () => {
    recordMetric({ projectId: PROJECT, type: "task_cycle", key: "cycle_time", value: 5000 }, db);
    recordMetric({ projectId: PROJECT, type: "task_cycle", key: "cycle_time", value: 8000 }, db);

    const results = evaluateSlos(PROJECT, {
      breach_slo: {
        name: "breach_slo",
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
    expect(results[0]!.noData).toBeUndefined();
    expect(results[0]!.actual).toBe(6500);
  });
});
