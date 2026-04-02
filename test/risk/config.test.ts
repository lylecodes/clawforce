import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_CONFIG, getRiskConfig } from "../../src/risk/config.js";
import type { RiskTierConfig } from "../../src/types.js";

describe("risk/config", () => {
  describe("DEFAULT_RISK_CONFIG", () => {
    it("has risk disabled by default", () => {
      expect(DEFAULT_RISK_CONFIG.enabled).toBe(false);
    });

    it("defaults to low tier", () => {
      expect(DEFAULT_RISK_CONFIG.defaultTier).toBe("low");
    });

    it("has policies for all four tiers", () => {
      expect(DEFAULT_RISK_CONFIG.policies.low).toBeDefined();
      expect(DEFAULT_RISK_CONFIG.policies.medium).toBeDefined();
      expect(DEFAULT_RISK_CONFIG.policies.high).toBeDefined();
      expect(DEFAULT_RISK_CONFIG.policies.critical).toBeDefined();
    });

    it("low tier gate is none", () => {
      expect(DEFAULT_RISK_CONFIG.policies.low.gate).toBe("none");
    });

    it("medium tier gate is delay with 30s", () => {
      expect(DEFAULT_RISK_CONFIG.policies.medium.gate).toBe("delay");
      expect(DEFAULT_RISK_CONFIG.policies.medium.delayMs).toBe(30000);
    });

    it("high tier gate is approval", () => {
      expect(DEFAULT_RISK_CONFIG.policies.high.gate).toBe("approval");
    });

    it("critical tier gate is human_approval", () => {
      expect(DEFAULT_RISK_CONFIG.policies.critical.gate).toBe("human_approval");
    });

    it("has empty patterns array", () => {
      expect(DEFAULT_RISK_CONFIG.patterns).toEqual([]);
    });
  });

  describe("getRiskConfig", () => {
    it("returns default config when undefined is passed", () => {
      const config = getRiskConfig(undefined);
      expect(config).toEqual(DEFAULT_RISK_CONFIG);
    });

    it("returns provided config when defined", () => {
      const custom: RiskTierConfig = {
        enabled: true,
        defaultTier: "medium",
        policies: {
          low: { gate: "none" },
          medium: { gate: "none" },
          high: { gate: "delay", delayMs: 10000 },
          critical: { gate: "approval" },
        },
        patterns: [{ match: { action_type: "deploy" }, tier: "high" }],
      };

      const config = getRiskConfig(custom);
      expect(config).toBe(custom);
      expect(config.enabled).toBe(true);
      expect(config.defaultTier).toBe("medium");
      expect(config.patterns).toHaveLength(1);
    });

    it("does not mutate default config", () => {
      const config = getRiskConfig(undefined);
      expect(config.enabled).toBe(false);
      // Verify it's the same reference
      expect(config).toBe(DEFAULT_RISK_CONFIG);
    });
  });
});
