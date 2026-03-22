/**
 * Tests for experiment outcome recording and result computation.
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
const { assignVariant } = await import("../../src/experiments/assignment.js");
const { recordExperimentOutcome, getExperimentResults } = await import("../../src/experiments/results.js");

const PROJECT = "test-project";

function makeVariants() {
  return [
    { name: "control", isControl: true, config: {} },
    { name: "treatment", isControl: false, config: { persona: "concise" } },
  ];
}

function setupRunningExperiment(db: DatabaseSync) {
  const exp = createExperiment(PROJECT, {
    name: "results-test",
    createdBy: "admin",
    variants: makeVariants(),
  }, db);
  startExperiment(PROJECT, exp.id, db);
  return exp;
}

describe("experiment results", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* ok */ }
  });

  // --- recordExperimentOutcome ---

  describe("recordExperimentOutcome", () => {
    it("updates variant aggregate stats", () => {
      const exp = setupRunningExperiment(db);
      const assignment = assignVariant(exp.id, "s1", { agentId: "agent-a" }, db);

      recordExperimentOutcome(exp.id, assignment.variantId, "s1", {
        compliant: true,
        toolCalls: 5,
        errorCount: 0,
        durationMs: 1000,
        costCents: 10,
      }, db);

      const row = db.prepare(
        "SELECT * FROM experiment_variants WHERE id = ?",
      ).get(assignment.variantId) as Record<string, unknown>;

      expect(row.compliant_count).toBe(1);
      expect(row.total_cost_cents).toBe(10);
      expect(row.total_duration_ms).toBe(1000);
    });

    it("accumulates stats across multiple outcomes", () => {
      const exp = setupRunningExperiment(db);

      // Assign two sessions to the same experiment
      const a1 = assignVariant(exp.id, "s1", { agentId: "agent-a" }, db);
      const a2 = assignVariant(exp.id, "s2", { agentId: "agent-b" }, db);

      // Record outcomes for both
      recordExperimentOutcome(exp.id, a1.variantId, "s1", {
        compliant: true,
        toolCalls: 3,
        errorCount: 0,
        durationMs: 500,
        costCents: 5,
      }, db);

      // If both were assigned to same variant, stats accumulate;
      // if different variants, stats are per-variant
      recordExperimentOutcome(exp.id, a2.variantId, "s2", {
        compliant: false,
        toolCalls: 2,
        errorCount: 1,
        durationMs: 800,
        costCents: 8,
      }, db);

      // Check total stats across all variants
      const rows = db.prepare(
        "SELECT SUM(total_cost_cents) as total_cost FROM experiment_variants WHERE experiment_id = ?",
      ).get(exp.id) as { total_cost: number };
      expect(rows.total_cost).toBe(13); // 5 + 8
    });

    it("marks session as completed with outcome", () => {
      const exp = setupRunningExperiment(db);
      const assignment = assignVariant(exp.id, "s1", { agentId: "agent-a" }, db);

      recordExperimentOutcome(exp.id, assignment.variantId, "s1", {
        compliant: true,
        toolCalls: 5,
        errorCount: 0,
        durationMs: 1000,
        costCents: 10,
      }, db);

      const session = db.prepare(
        "SELECT completed_at, outcome FROM experiment_sessions WHERE session_key = ?",
      ).get("s1") as Record<string, unknown>;

      expect(session.completed_at).toBeGreaterThan(0);
      expect(session.outcome).toBeTruthy();
    });
  });

  // --- getExperimentResults ---

  describe("getExperimentResults", () => {
    it("computes compliance rate per variant", () => {
      const exp = setupRunningExperiment(db);
      const controlId = exp.variants.find(v => v.name === "control")!.id;
      const treatmentId = exp.variants.find(v => v.name === "treatment")!.id;

      // Directly insert sessions for control (3/4 compliant)
      for (let i = 0; i < 4; i++) {
        db.prepare(`
          INSERT INTO experiment_sessions (id, experiment_id, variant_id, session_key, agent_id, project_id, assigned_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(`ctrl-sess-${i}`, exp.id, controlId, `ctrl-${i}`, "agent-a", PROJECT, Date.now());
        db.prepare("UPDATE experiment_variants SET session_count = session_count + 1 WHERE id = ?").run(controlId);

        recordExperimentOutcome(exp.id, controlId, `ctrl-${i}`, {
          compliant: i < 3, // 3/4 compliant
          toolCalls: 3,
          errorCount: 0,
          durationMs: 1000,
          costCents: 10,
        }, db);
      }

      // Directly insert sessions for treatment (4/4 compliant)
      for (let i = 0; i < 4; i++) {
        db.prepare(`
          INSERT INTO experiment_sessions (id, experiment_id, variant_id, session_key, agent_id, project_id, assigned_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(`treat-sess-${i}`, exp.id, treatmentId, `treat-${i}`, "agent-b", PROJECT, Date.now());
        db.prepare("UPDATE experiment_variants SET session_count = session_count + 1 WHERE id = ?").run(treatmentId);

        recordExperimentOutcome(exp.id, treatmentId, `treat-${i}`, {
          compliant: true, // 4/4 compliant
          toolCalls: 2,
          errorCount: 0,
          durationMs: 500,
          costCents: 5,
        }, db);
      }

      const results = getExperimentResults(PROJECT, exp.id, db);

      expect(results.variants).toHaveLength(2);

      const controlResult = results.variants.find(v => v.name === "control")!;
      const treatmentResult = results.variants.find(v => v.name === "treatment")!;

      expect(controlResult.complianceRate).toBe(0.75); // 3/4
      expect(treatmentResult.complianceRate).toBe(1.0); // 4/4
    });

    it("picks winner with highest compliance rate", () => {
      const exp = setupRunningExperiment(db);
      const controlId = exp.variants.find(v => v.name === "control")!.id;
      const treatmentId = exp.variants.find(v => v.name === "treatment")!.id;

      // Control: 1/2 compliant
      for (let i = 0; i < 2; i++) {
        db.prepare(`
          INSERT INTO experiment_sessions (id, experiment_id, variant_id, session_key, agent_id, project_id, assigned_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(`c-${i}`, exp.id, controlId, `c-${i}`, "agent-a", PROJECT, Date.now());
        db.prepare("UPDATE experiment_variants SET session_count = session_count + 1 WHERE id = ?").run(controlId);
        recordExperimentOutcome(exp.id, controlId, `c-${i}`, {
          compliant: i === 0,
          toolCalls: 3,
          errorCount: 0,
          durationMs: 1000,
          costCents: 10,
        }, db);
      }

      // Treatment: 2/2 compliant
      for (let i = 0; i < 2; i++) {
        db.prepare(`
          INSERT INTO experiment_sessions (id, experiment_id, variant_id, session_key, agent_id, project_id, assigned_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(`t-${i}`, exp.id, treatmentId, `t-${i}`, "agent-b", PROJECT, Date.now());
        db.prepare("UPDATE experiment_variants SET session_count = session_count + 1 WHERE id = ?").run(treatmentId);
        recordExperimentOutcome(exp.id, treatmentId, `t-${i}`, {
          compliant: true,
          toolCalls: 2,
          errorCount: 0,
          durationMs: 500,
          costCents: 5,
        }, db);
      }

      const results = getExperimentResults(PROJECT, exp.id, db);
      expect(results.winner).toBeDefined();
      expect(results.winner!.name).toBe("treatment");
    });

    it("breaks ties on compliance rate by lowest cost", () => {
      const exp = setupRunningExperiment(db);
      const controlId = exp.variants.find(v => v.name === "control")!.id;
      const treatmentId = exp.variants.find(v => v.name === "treatment")!.id;

      // Both 100% compliant, but control is more expensive
      for (const [vid, key, cost] of [
        [controlId, "c-0", 20],
        [treatmentId, "t-0", 5],
      ] as [string, string, number][]) {
        db.prepare(`
          INSERT INTO experiment_sessions (id, experiment_id, variant_id, session_key, agent_id, project_id, assigned_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(key, exp.id, vid, key, "agent-a", PROJECT, Date.now());
        db.prepare("UPDATE experiment_variants SET session_count = session_count + 1 WHERE id = ?").run(vid);
        recordExperimentOutcome(exp.id, vid, key, {
          compliant: true,
          toolCalls: 3,
          errorCount: 0,
          durationMs: 1000,
          costCents: cost,
        }, db);
      }

      const results = getExperimentResults(PROJECT, exp.id, db);
      expect(results.winner!.name).toBe("treatment"); // cheaper
    });

    it("returns null winner when no variants have sessions", () => {
      const exp = setupRunningExperiment(db);
      const results = getExperimentResults(PROJECT, exp.id, db);
      expect(results.winner).toBeNull();
    });
  });
});
