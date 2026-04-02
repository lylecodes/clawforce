import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { getMemoryDb } = await import("../../src/db.js");
const { applyRiskGate } = await import("../../src/risk/gate.js");

import type { RiskClassification, RiskTierConfig } from "../../src/types.js";

const baseConfig: RiskTierConfig = {
  enabled: true,
  defaultTier: "low",
  policies: {
    low: { gate: "none" },
    medium: { gate: "delay", delayMs: 30000 },
    high: { gate: "approval" },
    critical: { gate: "human_approval" },
  },
  patterns: [],
};

describe("risk/gate — applyRiskGate", () => {
  let db: DatabaseSync;
  const PROJECT = "risk-gate-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  function makeContext(tier: RiskClassification["tier"], reasons: string[] = ["test"], config?: RiskTierConfig) {
    return {
      projectId: PROJECT,
      actionType: "test_action",
      actionDetail: "some detail",
      actor: "worker-1",
      classification: { tier, reasons } as RiskClassification,
      config: config ?? baseConfig,
      dbOverride: db,
    };
  }

  // --- Gate actions by tier ---

  it("returns allow for low tier (gate: none)", () => {
    const result = applyRiskGate(makeContext("low"));
    expect(result.action).toBe("allow");
  });

  it("returns delay for medium tier (gate: delay)", () => {
    const result = applyRiskGate(makeContext("medium"));
    expect(result.action).toBe("delay");
    if (result.action === "delay") {
      expect(result.delayMs).toBe(30000);
    }
  });

  it("returns require_approval for high tier (gate: approval)", () => {
    const result = applyRiskGate(makeContext("high"));
    expect(result.action).toBe("require_approval");
    if (result.action === "require_approval") {
      expect(result.proposalTitle).toContain("Risk gate");
      expect(result.proposalTitle).toContain("high");
    }
  });

  it("returns block for critical tier (gate: human_approval)", () => {
    const result = applyRiskGate(makeContext("critical", ["reason1", "reason2"]));
    expect(result.action).toBe("block");
    if (result.action === "block") {
      expect(result.reason).toContain("human approval");
      expect(result.reason).toContain("critical");
      expect(result.reason).toContain("reason1; reason2");
    }
  });

  // --- Confirm gate ---

  it("returns require_approval for confirm gate", () => {
    const confirmConfig: RiskTierConfig = {
      ...baseConfig,
      policies: {
        ...baseConfig.policies,
        medium: { gate: "confirm" },
      },
    };
    const result = applyRiskGate(makeContext("medium", ["test"], confirmConfig));
    expect(result.action).toBe("require_approval");
    if (result.action === "require_approval") {
      expect(result.proposalTitle).toContain("Confirm");
    }
  });

  // --- Default delay time ---

  it("uses default 30000ms delay when delayMs not specified in policy", () => {
    const noDelayConfig: RiskTierConfig = {
      ...baseConfig,
      policies: {
        ...baseConfig.policies,
        medium: { gate: "delay" },
      },
    };
    const result = applyRiskGate(makeContext("medium", ["test"], noDelayConfig));
    expect(result.action).toBe("delay");
    if (result.action === "delay") {
      expect(result.delayMs).toBe(30000);
    }
  });

  it("uses custom delayMs when specified", () => {
    const customDelayConfig: RiskTierConfig = {
      ...baseConfig,
      policies: {
        ...baseConfig.policies,
        medium: { gate: "delay", delayMs: 60000 },
      },
    };
    const result = applyRiskGate(makeContext("medium", ["test"], customDelayConfig));
    if (result.action === "delay") {
      expect(result.delayMs).toBe(60000);
    }
  });

  // --- Unknown gate type defaults to allow ---

  it("defaults to allow for unknown gate type", () => {
    const unknownGateConfig: RiskTierConfig = {
      ...baseConfig,
      policies: {
        ...baseConfig.policies,
        low: { gate: "nonexistent" as any },
      },
    };
    const result = applyRiskGate(makeContext("low", ["test"], unknownGateConfig));
    expect(result.action).toBe("allow");
  });

  // --- Records assessment to DB ---

  it("records assessment to risk_assessments table", () => {
    applyRiskGate(makeContext("high", ["pattern match"]));

    const row = db.prepare(
      "SELECT * FROM risk_assessments WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(PROJECT) as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!.risk_tier).toBe("high");
    expect(row!.decision).toBe("pending_approval");
    expect(row!.actor).toBe("worker-1");
    expect(row!.action_type).toBe("test_action");
    expect(row!.action_detail).toBe("some detail");
  });

  it("records allowed decision for low tier", () => {
    applyRiskGate(makeContext("low"));

    const row = db.prepare(
      "SELECT decision FROM risk_assessments WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(PROJECT) as Record<string, unknown>;

    expect(row.decision).toBe("allowed");
  });

  it("records delayed decision for medium tier", () => {
    applyRiskGate(makeContext("medium"));

    const row = db.prepare(
      "SELECT decision FROM risk_assessments WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(PROJECT) as Record<string, unknown>;

    expect(row.decision).toBe("delayed");
  });

  it("records blocked decision for critical tier", () => {
    applyRiskGate(makeContext("critical"));

    const row = db.prepare(
      "SELECT decision FROM risk_assessments WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(PROJECT) as Record<string, unknown>;

    expect(row.decision).toBe("blocked");
  });

  it("includes classification reasons in DB record", () => {
    applyRiskGate(makeContext("high", ["reason A", "reason B"]));

    const row = db.prepare(
      "SELECT classification_reason FROM risk_assessments WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(PROJECT) as Record<string, unknown>;

    expect(row.classification_reason).toBe("reason A; reason B");
  });
});
