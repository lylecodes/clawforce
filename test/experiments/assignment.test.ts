/**
 * Tests for experiment variant assignment strategies.
 */

import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "k",
    identityToken: "t",
    issuedAt: 0,
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createExperiment, startExperiment } = await import("../../src/experiments/lifecycle.js");
const { assignVariant, getActiveExperimentForProject, getVariantConfig } = await import("../../src/experiments/assignment.js");

const PROJECT = "test-project";

function makeVariants() {
  return [
    { name: "control", isControl: true, config: { persona: "default" } },
    { name: "treatment", isControl: false, config: { persona: "concise" } },
  ];
}

function createRunningExperiment(
  db: DatabaseSync,
  name: string,
  opts?: {
    strategy?: any;
    variants?: Array<{ name: string; isControl?: boolean; config: any }>;
  },
) {
  const exp = createExperiment(PROJECT, {
    name,
    createdBy: "admin",
    assignmentStrategy: opts?.strategy ?? { type: "random" },
    variants: opts?.variants ?? makeVariants(),
  }, db);
  startExperiment(PROJECT, exp.id, db);
  return exp;
}

describe("experiment assignment", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* ok */ }
  });

  // --- getActiveExperimentForProject ---

  describe("getActiveExperimentForProject", () => {
    it("returns null when no running experiments", () => {
      const result = getActiveExperimentForProject(PROJECT, db);
      expect(result).toBeNull();
    });

    it("returns the running experiment", () => {
      const exp = createRunningExperiment(db, "active-exp");
      const result = getActiveExperimentForProject(PROJECT, db);
      expect(result).toBeDefined();
      expect(result!.experimentId).toBe(exp.id);
    });

    it("ignores draft experiments", () => {
      createExperiment(PROJECT, {
        name: "draft-only",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      const result = getActiveExperimentForProject(PROJECT, db);
      expect(result).toBeNull();
    });
  });

  // --- random strategy ---

  describe("random assignment", () => {
    it("assigns a variant to a session", () => {
      const exp = createRunningExperiment(db, "random-test");

      const result = assignVariant(exp.id, "session-1", { agentId: "agent-a" }, db);
      expect(result.variantId).toBeTruthy();
      expect(result.variant.experimentId).toBe(exp.id);
    });

    it("returns the same variant for the same session key (sticky)", () => {
      const exp = createRunningExperiment(db, "sticky-test");

      const r1 = assignVariant(exp.id, "session-sticky", { agentId: "agent-a" }, db);
      const r2 = assignVariant(exp.id, "session-sticky", { agentId: "agent-a" }, db);
      expect(r1.variantId).toBe(r2.variantId);
    });

    it("increments session count on the variant", () => {
      const exp = createRunningExperiment(db, "count-test");

      assignVariant(exp.id, "session-1", { agentId: "agent-a" }, db);
      assignVariant(exp.id, "session-2", { agentId: "agent-b" }, db);

      // Total sessions across variants should be 2
      const rows = db.prepare(
        "SELECT SUM(session_count) as total FROM experiment_variants WHERE experiment_id = ?",
      ).get(exp.id) as { total: number };
      expect(rows.total).toBe(2);
    });
  });

  // --- round_robin strategy ---

  describe("round_robin assignment", () => {
    it("distributes sessions evenly across variants", () => {
      const exp = createRunningExperiment(db, "rr-test", {
        strategy: { type: "round_robin" },
      });

      // Assign 4 sessions
      const results: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = assignVariant(exp.id, `rr-session-${i}`, { agentId: "agent-a" }, db);
        results.push(r.variant.name);
      }

      // Each variant should get exactly 2 sessions
      const controlCount = results.filter(n => n === "control").length;
      const treatmentCount = results.filter(n => n === "treatment").length;
      expect(controlCount).toBe(2);
      expect(treatmentCount).toBe(2);
    });
  });

  // --- weighted strategy ---

  describe("weighted assignment", () => {
    it("assigns according to weights", () => {
      const exp = createRunningExperiment(db, "weighted-test", {
        strategy: { type: "weighted", weights: { control: 1, treatment: 99 } },
      });

      // With heavy weight on treatment, most should go there
      let treatmentCount = 0;
      const n = 20;
      for (let i = 0; i < n; i++) {
        const r = assignVariant(exp.id, `weighted-session-${i}`, { agentId: "agent-a" }, db);
        if (r.variant.name === "treatment") treatmentCount++;
      }

      // Treatment should get most of the 20 sessions (at least 10 with 99:1 odds)
      expect(treatmentCount).toBeGreaterThan(10);
    });
  });

  // --- per_agent strategy ---

  describe("per_agent assignment", () => {
    it("assigns variant based on agent mapping", () => {
      const exp = createRunningExperiment(db, "per-agent-test", {
        strategy: {
          type: "per_agent",
          agentVariantMap: {
            "agent-alpha": "control",
            "agent-beta": "treatment",
          },
        },
      });

      const r1 = assignVariant(exp.id, "s1", { agentId: "agent-alpha" }, db);
      expect(r1.variant.name).toBe("control");

      const r2 = assignVariant(exp.id, "s2", { agentId: "agent-beta" }, db);
      expect(r2.variant.name).toBe("treatment");
    });

    it("falls back to first variant for unmapped agents", () => {
      const exp = createRunningExperiment(db, "per-agent-fallback", {
        strategy: {
          type: "per_agent",
          agentVariantMap: { "agent-alpha": "control" },
        },
      });

      const r = assignVariant(exp.id, "s-unmapped", { agentId: "agent-unknown" }, db);
      expect(r.variant).toBeDefined();
    });
  });

  // --- manual strategy ---

  describe("manual assignment", () => {
    it("assigns first variant by default", () => {
      const exp = createRunningExperiment(db, "manual-test", {
        strategy: { type: "manual" },
      });

      const r = assignVariant(exp.id, "s1", { agentId: "agent-a" }, db);
      expect(r.variant).toBeDefined();
    });
  });

  // --- getVariantConfig ---

  describe("getVariantConfig", () => {
    it("returns the variant config", () => {
      const exp = createRunningExperiment(db, "config-test");
      const variant = exp.variants[0]!;

      const config = getVariantConfig(exp.id, variant.id, db);
      expect(config).toBeDefined();
      expect(config!.persona).toBe("default");
    });

    it("returns null for non-existent variant", () => {
      const exp = createRunningExperiment(db, "no-variant");
      const config = getVariantConfig(exp.id, "fake-id", db);
      expect(config).toBeNull();
    });
  });

  // --- error handling ---

  describe("error handling", () => {
    it("throws when experiment is not running", () => {
      const exp = createExperiment(PROJECT, {
        name: "not-running",
        createdBy: "admin",
        variants: makeVariants(),
      }, db);

      expect(() => assignVariant(exp.id, "s1", { agentId: "agent-a" }, db))
        .toThrow("not running");
    });

    it("throws for non-existent experiment", () => {
      expect(() => assignVariant("fake-id", "s1", { agentId: "agent-a" }, db))
        .toThrow("not found");
    });
  });
});
