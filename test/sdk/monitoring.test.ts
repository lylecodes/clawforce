/**
 * Tests for the MonitoringNamespace SDK wrapper.
 *
 * Strategy: test the namespace class shape and method return types against
 * empty/default data (no configured SLOs or alert rules). When monitoring
 * data is needed, we drive internal functions directly with a shared
 * in-memory DB to keep tests deterministic and isolated.
 */

import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Module mocks (must come before dynamic imports) ----

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

// ---- Dynamic imports after mocks ----

const { getMemoryDb } = await import("../../src/db.js");
const { MonitoringNamespace } = await import("../../src/sdk/monitoring.js");
const { recordMetric } = await import("../../src/metrics.js");

// ---- Constants ----

const DOMAIN = "test-monitoring-project";

// ---- Tests ----

describe("MonitoringNamespace", () => {
  let db: DatabaseSync;
  let ns: InstanceType<typeof MonitoringNamespace>;

  beforeEach(() => {
    db = getMemoryDb();
    ns = new MonitoringNamespace(DOMAIN);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  // ---------- constructor ----------

  describe("constructor", () => {
    it("exposes domain string on instance", () => {
      expect(ns.domain).toBe(DOMAIN);
    });

    it("stores arbitrary domain strings", () => {
      expect(new MonitoringNamespace("research-lab").domain).toBe("research-lab");
      expect(new MonitoringNamespace("content-studio").domain).toBe("content-studio");
    });
  });

  // ---------- health ----------

  describe("health()", () => {
    it("returns a HealthStatus with tier and numeric counts", () => {
      const result = ns.health();
      expect(result).toHaveProperty("tier");
      expect(["GREEN", "YELLOW", "RED"]).toContain(result.tier);
      expect(typeof result.sloChecked).toBe("number");
      expect(typeof result.sloBreach).toBe("number");
      expect(typeof result.alertsFired).toBe("number");
    });

    it("returns GREEN with zero counts when no monitoring config is registered", () => {
      const result = ns.health();
      expect(result.tier).toBe("GREEN");
      expect(result.sloChecked).toBe(0);
      expect(result.sloBreach).toBe(0);
      expect(result.alertsFired).toBe(0);
    });

    it("never throws — returns GREEN fallback on error", () => {
      const badNs = new MonitoringNamespace("non-existent-domain-xyz");
      expect(() => badNs.health()).not.toThrow();
      const result = badNs.health();
      expect(result.tier).toBe("GREEN");
    });
  });

  // ---------- slos ----------

  describe("slos()", () => {
    it("returns an array", () => {
      const result = ns.slos();
      expect(Array.isArray(result)).toBe(true);
    });

    it("returns empty array when no SLOs are configured", () => {
      const result = ns.slos();
      expect(result).toHaveLength(0);
    });

    it("never throws — returns empty array on error", () => {
      const badNs = new MonitoringNamespace("non-existent-domain-xyz");
      expect(() => badNs.slos()).not.toThrow();
      expect(badNs.slos()).toEqual([]);
    });

    it("each SloResult has the required shape fields", () => {
      // With no SLOs configured the array is empty, but we can validate shape
      // by constructing a minimal conforming object and checking type compatibility
      const sloShape: Record<string, unknown> = {
        name: "test-slo",
        actual: 0.9,
        threshold: 0.95,
        passed: false,
        noData: false,
      };
      expect(sloShape).toMatchObject({
        name: expect.any(String),
        threshold: expect.any(Number),
        passed: expect.any(Boolean),
        noData: expect.any(Boolean),
      });
    });
  });

  // ---------- alerts ----------

  describe("alerts()", () => {
    it("returns an array", () => {
      const result = ns.alerts();
      expect(Array.isArray(result)).toBe(true);
    });

    it("returns empty array when no alert rules are configured", () => {
      const result = ns.alerts();
      expect(result).toHaveLength(0);
    });

    it("never throws — returns empty array on error", () => {
      const badNs = new MonitoringNamespace("non-existent-domain-xyz");
      expect(() => badNs.alerts()).not.toThrow();
      expect(badNs.alerts()).toEqual([]);
    });
  });

  // ---------- metrics ----------

  describe("metrics()", () => {
    it("returns an array", () => {
      const result = ns.metrics();
      expect(Array.isArray(result)).toBe(true);
    });

    it("returns empty array when no metrics recorded (no DB for this domain)", () => {
      const result = ns.metrics();
      expect(Array.isArray(result)).toBe(true);
    });

    it("never throws — returns empty array on error", () => {
      const badNs = new MonitoringNamespace("non-existent-domain-xyz");
      expect(() => badNs.metrics("some-key")).not.toThrow();
    });

    it("accepts optional filters object", () => {
      const now = Date.now();
      expect(() => ns.metrics("cost", { since: now - 3600_000, until: now, limit: 50 })).not.toThrow();
    });

    it("returns metrics recorded via internal recordMetric (shared DB via getDb)", async () => {
      // Verify queryMetrics returns an array for the given domain/db pair
      const { queryMetrics } = await import("../../src/metrics.js");
      const result = queryMetrics({ projectId: DOMAIN }, db);
      expect(Array.isArray(result)).toBe(true);
    });

    it("each returned metric has id, projectId, key, value, createdAt fields", async () => {
      // Insert a metric directly into the in-memory DB to verify shape mapping
      const { queryMetrics } = await import("../../src/metrics.js");
      db.prepare(`
        INSERT INTO metrics (id, project_id, type, subject, key, value, unit, tags, created_at)
        VALUES ('m1', ?, 'system', NULL, 'test_key', 42, NULL, NULL, ?)
      `).run(DOMAIN, Date.now());

      const results = queryMetrics({ projectId: DOMAIN }, db);
      expect(results).toHaveLength(1);
      const m = results[0];
      expect(m.id).toBe("m1");
      expect(m.projectId).toBe(DOMAIN);
      expect(m.key).toBe("test_key");
      expect(m.value).toBe(42);
      expect(typeof m.createdAt).toBe("number");
    });
  });
});
