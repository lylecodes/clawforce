import type { DatabaseSync } from "../../src/sqlite-driver.js";
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
const { evaluateAlertRules } = await import("../../src/monitoring/alerts.js");

describe("evaluateAlertRules", () => {
  let db: DatabaseSync;
  const PROJECT = "alert-test";

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

  it("fires alert when metric is above threshold (gt)", () => {
    recordMetric({ projectId: PROJECT, type: "system", key: "error_count", value: 100 }, db);

    const results = evaluateAlertRules(PROJECT, {
      high_errors: {
        name: "high_errors",
        metricType: "system",
        metricKey: "error_count",
        condition: "gt",
        threshold: 50,
        windowMs: 3600000,
        action: "emit_event",
        cooldownMs: 60000,
      },
    }, db);

    expect(results).toHaveLength(1);
    expect(results[0]!.fired).toBe(true);
    expect(results[0]!.name).toBe("high_errors");
    expect(results[0]!.reason).toContain("error_count");
  });

  it("does not fire when metric is below threshold", () => {
    recordMetric({ projectId: PROJECT, type: "system", key: "error_count", value: 10 }, db);

    const results = evaluateAlertRules(PROJECT, {
      high_errors: {
        name: "high_errors",
        metricType: "system",
        metricKey: "error_count",
        condition: "gt",
        threshold: 50,
        windowMs: 3600000,
        action: "emit_event",
        cooldownMs: 60000,
      },
    }, db);

    expect(results).toHaveLength(1);
    expect(results[0]!.fired).toBe(false);
  });

  it("cooldown prevents re-firing within cooldown period", () => {
    recordMetric({ projectId: PROJECT, type: "system", key: "error_count", value: 100 }, db);

    const rule = {
      high_errors: {
        name: "high_errors",
        metricType: "system",
        metricKey: "error_count",
        condition: "gt" as const,
        threshold: 50,
        windowMs: 3600000,
        action: "emit_event" as const,
        cooldownMs: 60000,
      },
    };

    // First evaluation should fire
    const first = evaluateAlertRules(PROJECT, rule, db);
    expect(first[0]!.fired).toBe(true);

    // Second evaluation within cooldown should NOT fire
    const second = evaluateAlertRules(PROJECT, rule, db);
    expect(second[0]!.fired).toBe(false);
    expect(second[0]!.reason).toBe("cooldown");
  });

  it("create_task action creates a task on fire", () => {
    recordMetric({ projectId: PROJECT, type: "system", key: "latency", value: 5000 }, db);

    const results = evaluateAlertRules(PROJECT, {
      high_latency: {
        name: "high_latency",
        metricType: "system",
        metricKey: "latency",
        condition: "gt",
        threshold: 1000,
        windowMs: 3600000,
        action: "create_task",
        actionParams: { taskTitle: "Fix high latency", priority: "P0" },
        cooldownMs: 60000,
      },
    }, db);

    expect(results[0]!.fired).toBe(true);

    // Verify the task was created
    const tasks = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND title = ?").all(PROJECT, "Fix high latency") as Record<string, unknown>[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.priority).toBe("P0");
    expect(tasks[0]!.state).toBe("OPEN");
  });

  it("emit_event action emits an event on fire", () => {
    recordMetric({ projectId: PROJECT, type: "system", key: "cpu_usage", value: 95 }, db);

    const results = evaluateAlertRules(PROJECT, {
      high_cpu: {
        name: "high_cpu",
        metricType: "system",
        metricKey: "cpu_usage",
        condition: "gt",
        threshold: 80,
        windowMs: 3600000,
        action: "emit_event",
        cooldownMs: 60000,
      },
    }, db);

    expect(results[0]!.fired).toBe(true);

    // Verify event was emitted
    const events = db.prepare("SELECT * FROM events WHERE project_id = ? AND type = 'custom'").all(PROJECT) as Record<string, unknown>[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload as string);
    expect(payload.alert).toBe("high_cpu");
    expect(payload.metricKey).toBe("cpu_usage");
  });

  it("escalate action creates a P0 task", () => {
    recordMetric({ projectId: PROJECT, type: "system", key: "critical_errors", value: 200 }, db);

    const results = evaluateAlertRules(PROJECT, {
      critical_alert: {
        name: "critical_alert",
        metricType: "system",
        metricKey: "critical_errors",
        condition: "gt",
        threshold: 100,
        windowMs: 3600000,
        action: "escalate",
        cooldownMs: 60000,
      },
    }, db);

    expect(results[0]!.fired).toBe(true);

    // Verify a P0 task was created
    const tasks = db.prepare(
      "SELECT * FROM tasks WHERE project_id = ? AND title LIKE '%escalation%'",
    ).all(PROJECT) as Record<string, unknown>[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.priority).toBe("P0");
    expect(tasks[0]!.state).toBe("OPEN");
    expect((tasks[0]!.tags as string)).toContain("alert-escalation");

    // Verify the event was also emitted
    const events = db.prepare(
      "SELECT * FROM events WHERE project_id = ? AND type = 'sweep_finding'",
    ).all(PROJECT) as Record<string, unknown>[];
    expect(events.length).toBeGreaterThan(0);
  });

  it("escalate action deduplicates tasks", () => {
    recordMetric({ projectId: PROJECT, type: "system", key: "dedup_metric", value: 200 }, db);

    const rule = {
      dedup_alert: {
        name: "dedup_alert",
        metricType: "system",
        metricKey: "dedup_metric",
        condition: "gt" as const,
        threshold: 100,
        windowMs: 3600000,
        action: "escalate" as const,
        cooldownMs: 0, // disable cooldown for this test
      },
    };

    evaluateAlertRules(PROJECT, rule, db);
    evaluateAlertRules(PROJECT, rule, db);

    const tasks = db.prepare(
      "SELECT * FROM tasks WHERE project_id = ? AND title LIKE '%dedup_alert%'",
    ).all(PROJECT) as Record<string, unknown>[];
    expect(tasks).toHaveLength(1);
  });

  describe("comparison operators", () => {
    it("gt: fires when value > threshold", () => {
      recordMetric({ projectId: PROJECT, type: "system", key: "m_gt", value: 51 }, db);
      const results = evaluateAlertRules(PROJECT, {
        r: { name: "r", metricType: "system", metricKey: "m_gt", condition: "gt", threshold: 50, windowMs: 3600000, action: "emit_event", cooldownMs: 0 },
      }, db);
      expect(results[0]!.fired).toBe(true);
    });

    it("gt: does not fire when value == threshold", () => {
      recordMetric({ projectId: PROJECT, type: "system", key: "m_gt_eq", value: 50 }, db);
      const results = evaluateAlertRules(PROJECT, {
        r: { name: "r", metricType: "system", metricKey: "m_gt_eq", condition: "gt", threshold: 50, windowMs: 3600000, action: "emit_event", cooldownMs: 0 },
      }, db);
      expect(results[0]!.fired).toBe(false);
    });

    it("lt: fires when value < threshold", () => {
      recordMetric({ projectId: PROJECT, type: "system", key: "m_lt", value: 10 }, db);
      const results = evaluateAlertRules(PROJECT, {
        r: { name: "r", metricType: "system", metricKey: "m_lt", condition: "lt", threshold: 50, windowMs: 3600000, action: "emit_event", cooldownMs: 0 },
      }, db);
      expect(results[0]!.fired).toBe(true);
    });

    it("lt: does not fire when value == threshold", () => {
      recordMetric({ projectId: PROJECT, type: "system", key: "m_lt_eq", value: 50 }, db);
      const results = evaluateAlertRules(PROJECT, {
        r: { name: "r", metricType: "system", metricKey: "m_lt_eq", condition: "lt", threshold: 50, windowMs: 3600000, action: "emit_event", cooldownMs: 0 },
      }, db);
      expect(results[0]!.fired).toBe(false);
    });

    it("gte: fires when value >= threshold", () => {
      recordMetric({ projectId: PROJECT, type: "system", key: "m_gte", value: 50 }, db);
      const results = evaluateAlertRules(PROJECT, {
        r: { name: "r", metricType: "system", metricKey: "m_gte", condition: "gte", threshold: 50, windowMs: 3600000, action: "emit_event", cooldownMs: 0 },
      }, db);
      expect(results[0]!.fired).toBe(true);
    });

    it("lte: fires when value <= threshold", () => {
      recordMetric({ projectId: PROJECT, type: "system", key: "m_lte", value: 50 }, db);
      const results = evaluateAlertRules(PROJECT, {
        r: { name: "r", metricType: "system", metricKey: "m_lte", condition: "lte", threshold: 50, windowMs: 3600000, action: "emit_event", cooldownMs: 0 },
      }, db);
      expect(results[0]!.fired).toBe(true);
    });

    it("eq: fires when value == threshold", () => {
      recordMetric({ projectId: PROJECT, type: "system", key: "m_eq", value: 50 }, db);
      const results = evaluateAlertRules(PROJECT, {
        r: { name: "r", metricType: "system", metricKey: "m_eq", condition: "eq", threshold: 50, windowMs: 3600000, action: "emit_event", cooldownMs: 0 },
      }, db);
      expect(results[0]!.fired).toBe(true);
    });

    it("eq: does not fire when value != threshold", () => {
      recordMetric({ projectId: PROJECT, type: "system", key: "m_eq_ne", value: 51 }, db);
      const results = evaluateAlertRules(PROJECT, {
        r: { name: "r", metricType: "system", metricKey: "m_eq_ne", condition: "eq", threshold: 50, windowMs: 3600000, action: "emit_event", cooldownMs: 0 },
      }, db);
      expect(results[0]!.fired).toBe(false);
    });
  });
});
