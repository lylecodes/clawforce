import { describe, expect, it } from "vitest";
import { classifyRisk } from "../../src/risk/classifier.js";
import type { RiskTierConfig } from "../../src/types.js";

const baseConfig: RiskTierConfig = {
  enabled: true,
  defaultTier: "low",
  policies: {
    low: { gate: "none" },
    medium: { gate: "delay", delayMs: 30000 },
    high: { gate: "approval" },
    critical: { gate: "human_approval" },
  },
  patterns: [
    { match: { action_type: "dispatch" }, tier: "medium" },
    { match: { action_type: "transition", to_state: "CANCELLED", task_priority: "P0" }, tier: "critical" },
    { match: { tool_name: "clawforce_ops", tool_action: "disable_agent" }, tier: "high" },
  ],
};

describe("classifyRisk", () => {
  it("returns default tier when no patterns match", () => {
    const result = classifyRisk({
      actionType: "transition",
      toState: "IN_PROGRESS",
      actor: "worker-1",
    }, baseConfig);

    expect(result.tier).toBe("low");
    expect(result.reasons).toContain("default tier: low");
  });

  it("matches dispatch pattern", () => {
    const result = classifyRisk({
      actionType: "dispatch",
      actor: "dispatcher:abc",
    }, baseConfig);

    expect(result.tier).toBe("medium");
    expect(result.reasons.some((r) => r.includes("dispatch"))).toBe(true);
  });

  it("matches complex pattern (P0 cancellation)", () => {
    const result = classifyRisk({
      actionType: "transition",
      toState: "CANCELLED",
      taskPriority: "P0",
      actor: "worker-1",
    }, baseConfig);

    expect(result.tier).toBe("critical");
  });

  it("matches tool action pattern", () => {
    const result = classifyRisk({
      actionType: "tool_call",
      toolName: "clawforce_ops",
      toolAction: "disable_agent",
      actor: "orchestrator",
    }, baseConfig);

    expect(result.tier).toBe("high");
  });

  it("bypasses classification for system actors", () => {
    const result = classifyRisk({
      actionType: "transition",
      toState: "CANCELLED",
      taskPriority: "P0",
      actor: "system:sweep",
    }, baseConfig);

    expect(result.tier).toBe("low");
    expect(result.reasons).toContain("system actor bypass");
  });

  it("escalates P0 tasks by one tier", () => {
    const result = classifyRisk({
      actionType: "transition",
      toState: "IN_PROGRESS",
      taskPriority: "P0",
      actor: "worker-1",
    }, baseConfig);

    // Default low → bumped to medium due to P0
    expect(result.tier).toBe("medium");
    expect(result.reasons.some((r) => r.includes("P0 task priority"))).toBe(true);
  });

  it("does not escalate P0 past high", () => {
    const result = classifyRisk({
      actionType: "dispatch",
      taskPriority: "P0",
      actor: "dispatcher:1",
    }, baseConfig);

    // dispatch matches medium, P0 bumps to high (not critical)
    expect(result.tier).toBe("high");
  });

  it("returns default tier when disabled", () => {
    const disabledConfig: RiskTierConfig = { ...baseConfig, enabled: false };

    const result = classifyRisk({
      actionType: "dispatch",
      actor: "dispatcher:1",
    }, disabledConfig);

    expect(result.tier).toBe("low");
    expect(result.reasons).toContain("risk tiers disabled");
  });

  it("picks highest matching tier when multiple patterns match", () => {
    const config: RiskTierConfig = {
      ...baseConfig,
      patterns: [
        { match: { action_type: "transition" }, tier: "medium" },
        { match: { action_type: "transition", to_state: "CANCELLED" }, tier: "high" },
      ],
    };

    const result = classifyRisk({
      actionType: "transition",
      toState: "CANCELLED",
      actor: "worker-1",
    }, config);

    expect(result.tier).toBe("high");
  });
});
