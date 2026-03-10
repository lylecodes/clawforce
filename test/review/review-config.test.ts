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

const { validateWorkforceConfig } = await import("../../src/config-validator.js");
const { loadWorkforceConfig, registerWorkforceConfig, getExtendedProjectConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");

import type { WorkforceConfig, AgentConfig } from "../../src/types.js";

function makeAgent(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    extends: "employee",
    expectations: [{ tool: "clawforce_log", action: "outcome", min_calls: 1 }],
    briefing: [],
    performance_policy: { action: "log" },
    ...overrides,
  } as AgentConfig;
}

function makeConfig(overrides?: Partial<WorkforceConfig>): WorkforceConfig {
  return {
    name: "test-project",
    agents: {
      "agent-1": makeAgent(),
      "qa-bot": makeAgent(),
    },
    ...overrides,
  } as WorkforceConfig;
}

describe("review config", () => {
  afterEach(() => {
    resetEnforcementConfigForTest();
  });

  describe("normalization", () => {
    it("normalizes all review config fields via registerWorkforceConfig", () => {
      const config = makeConfig({
        review: {
          verifierAgent: "qa-bot",
          autoEscalateAfterHours: 4,
          selfReviewAllowed: true,
          selfReviewMaxPriority: "P3",
        },
      });

      registerWorkforceConfig("norm-test-1", config, "/tmp/test");
      const ext = getExtendedProjectConfig("norm-test-1");
      expect(ext?.review).toEqual({
        verifierAgent: "qa-bot",
        autoEscalateAfterHours: 4,
        selfReviewAllowed: true,
        selfReviewMaxPriority: "P3",
      });
    });

    it("stores undefined review when not provided", () => {
      const config = makeConfig();
      // No review field

      registerWorkforceConfig("norm-test-2", config, "/tmp/test");
      const ext = getExtendedProjectConfig("norm-test-2");
      expect(ext?.review).toBeUndefined();
    });
  });

  describe("validation", () => {
    it("errors on nonexistent verifier_agent", () => {
      const config = makeConfig({
        review: { verifierAgent: "nonexistent-agent" },
      });

      const warnings = validateWorkforceConfig(config);
      expect(warnings.some(w =>
        w.level === "error" && w.message.includes("verifier_agent") && w.message.includes("nonexistent-agent"),
      )).toBe(true);
    });

    it("no error when verifier_agent exists in agents", () => {
      const config = makeConfig({
        review: { verifierAgent: "qa-bot" },
      });

      const warnings = validateWorkforceConfig(config);
      expect(warnings.some(w => w.message.includes("verifier_agent"))).toBe(false);
    });

    it("errors on non-positive auto_escalate_after_hours", () => {
      const config = makeConfig({
        review: { autoEscalateAfterHours: 0 },
      });

      const warnings = validateWorkforceConfig(config);
      expect(warnings.some(w =>
        w.level === "error" && w.message.includes("auto_escalate_after_hours"),
      )).toBe(true);
    });

    it("warns on selfReviewAllowed without selfReviewMaxPriority", () => {
      const config = makeConfig({
        review: { selfReviewAllowed: true },
      });

      const warnings = validateWorkforceConfig(config);
      expect(warnings.some(w =>
        w.level === "warn" && w.message.includes("self_review_max_priority") && w.message.includes("defaults to P3"),
      )).toBe(true);
    });

    it("warns on selfReviewMaxPriority without selfReviewAllowed", () => {
      const config = makeConfig({
        review: { selfReviewMaxPriority: "P2" },
      });

      const warnings = validateWorkforceConfig(config);
      expect(warnings.some(w =>
        w.level === "warn" && w.message.includes("self_review_allowed is false"),
      )).toBe(true);
    });

    it("no warnings for complete valid review config", () => {
      const config = makeConfig({
        review: {
          verifierAgent: "qa-bot",
          autoEscalateAfterHours: 4,
          selfReviewAllowed: true,
          selfReviewMaxPriority: "P3",
        },
      });

      const warnings = validateWorkforceConfig(config);
      const reviewWarnings = warnings.filter(w => w.message.includes("review."));
      expect(reviewWarnings).toHaveLength(0);
    });
  });

  describe("storage", () => {
    it("review config stored and retrievable via getExtendedProjectConfig", () => {
      const config = makeConfig({
        review: {
          verifierAgent: "qa-bot",
          autoEscalateAfterHours: 4,
          selfReviewAllowed: true,
          selfReviewMaxPriority: "P3",
        },
      });

      registerWorkforceConfig("test-review-proj", config, "/tmp/test");

      const extConfig = getExtendedProjectConfig("test-review-proj");
      expect(extConfig?.review).toEqual({
        verifierAgent: "qa-bot",
        autoEscalateAfterHours: 4,
        selfReviewAllowed: true,
        selfReviewMaxPriority: "P3",
      });
    });
  });
});
