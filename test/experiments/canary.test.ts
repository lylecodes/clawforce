/**
 * Tests for canary deployment health checks.
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
const { checkCanaryHealth } = await import("../../src/experiments/canary.js");

const PROJECT = "test-project";

function makeVariants() {
  return [
    { name: "control", isControl: true, config: {} },
    { name: "treatment", isControl: false, config: { persona: "concise" } },
  ];
}

function setVariantStats(
  db: DatabaseSync,
  variantId: string,
  stats: { sessionCount: number; compliantCount: number; totalCostCents?: number },
) {
  db.prepare(`
    UPDATE experiment_variants
    SET session_count = ?, compliant_count = ?, total_cost_cents = ?
    WHERE id = ?
  `).run(stats.sessionCount, stats.compliantCount, stats.totalCostCents ?? 0, variantId);
}

describe("canary health checks", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* ok */ }
  });

  it("returns continue when not enough data", () => {
    const exp = createExperiment(PROJECT, {
      name: "low-data",
      createdBy: "admin",
      variants: makeVariants(),
    }, db);
    startExperiment(PROJECT, exp.id, db);

    // Only 1 session each (below MIN_SESSIONS_FOR_DECISION=3)
    const controlId = exp.variants.find(v => v.name === "control")!.id;
    const treatmentId = exp.variants.find(v => v.name === "treatment")!.id;

    setVariantStats(db, controlId, { sessionCount: 1, compliantCount: 1 });
    setVariantStats(db, treatmentId, { sessionCount: 1, compliantCount: 0 });

    const result = checkCanaryHealth(exp.id, db);
    expect(result.action).toBe("continue");
  });

  it("recommends rollback when treatment compliance is below 50% and control is above", () => {
    const exp = createExperiment(PROJECT, {
      name: "rollback-test",
      createdBy: "admin",
      variants: makeVariants(),
    }, db);
    startExperiment(PROJECT, exp.id, db);

    const controlId = exp.variants.find(v => v.name === "control")!.id;
    const treatmentId = exp.variants.find(v => v.name === "treatment")!.id;

    // Control: 80% compliant (4/5)
    setVariantStats(db, controlId, { sessionCount: 5, compliantCount: 4 });
    // Treatment: 20% compliant (1/5)
    setVariantStats(db, treatmentId, { sessionCount: 5, compliantCount: 1 });

    const result = checkCanaryHealth(exp.id, db);
    expect(result.action).toBe("rollback");
    if (result.action === "rollback") {
      expect(result.reason).toContain("treatment");
      expect(result.reason).toContain("below 50%");
    }
  });

  it("recommends promotion when treatment outperforms control on compliance", () => {
    const exp = createExperiment(PROJECT, {
      name: "promote-test",
      createdBy: "admin",
      variants: makeVariants(),
    }, db);
    startExperiment(PROJECT, exp.id, db);

    const controlId = exp.variants.find(v => v.name === "control")!.id;
    const treatmentId = exp.variants.find(v => v.name === "treatment")!.id;

    // Control: 60% compliant (3/5)
    setVariantStats(db, controlId, { sessionCount: 5, compliantCount: 3 });
    // Treatment: 100% compliant (5/5)
    setVariantStats(db, treatmentId, { sessionCount: 5, compliantCount: 5 });

    const result = checkCanaryHealth(exp.id, db);
    expect(result.action).toBe("promote");
  });

  it("recommends promotion when same compliance but treatment is cheaper", () => {
    const exp = createExperiment(PROJECT, {
      name: "cost-promote",
      createdBy: "admin",
      variants: makeVariants(),
    }, db);
    startExperiment(PROJECT, exp.id, db);

    const controlId = exp.variants.find(v => v.name === "control")!.id;
    const treatmentId = exp.variants.find(v => v.name === "treatment")!.id;

    // Both 80% compliant, but treatment is cheaper
    setVariantStats(db, controlId, { sessionCount: 5, compliantCount: 4, totalCostCents: 100 });
    setVariantStats(db, treatmentId, { sessionCount: 5, compliantCount: 4, totalCostCents: 50 });

    const result = checkCanaryHealth(exp.id, db);
    expect(result.action).toBe("promote");
  });

  it("returns continue when both variants perform similarly", () => {
    const exp = createExperiment(PROJECT, {
      name: "similar-test",
      createdBy: "admin",
      variants: makeVariants(),
    }, db);
    startExperiment(PROJECT, exp.id, db);

    const controlId = exp.variants.find(v => v.name === "control")!.id;
    const treatmentId = exp.variants.find(v => v.name === "treatment")!.id;

    // Both 80% compliant, same cost
    setVariantStats(db, controlId, { sessionCount: 5, compliantCount: 4, totalCostCents: 50 });
    setVariantStats(db, treatmentId, { sessionCount: 5, compliantCount: 4, totalCostCents: 50 });

    const result = checkCanaryHealth(exp.id, db);
    expect(result.action).toBe("continue");
  });

  it("returns continue for non-running experiment", () => {
    const exp = createExperiment(PROJECT, {
      name: "draft-canary",
      createdBy: "admin",
      variants: makeVariants(),
    }, db);

    const result = checkCanaryHealth(exp.id, db);
    expect(result.action).toBe("continue");
  });

  it("returns continue when no control variant exists", () => {
    const exp = createExperiment(PROJECT, {
      name: "no-control",
      createdBy: "admin",
      variants: [
        { name: "variant-a", config: {} },
        { name: "variant-b", config: { persona: "fast" } },
      ],
    }, db);
    startExperiment(PROJECT, exp.id, db);

    const result = checkCanaryHealth(exp.id, db);
    expect(result.action).toBe("continue");
  });

  it("throws for non-existent experiment", () => {
    expect(() => checkCanaryHealth("fake-id", db)).toThrow("not found");
  });
});
