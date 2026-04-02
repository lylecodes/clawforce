import { describe, expect, it } from "vitest";
import { classifyRisk } from "../../src/risk/classifier.js";
import type { RiskTierConfig } from "../../src/types.js";

describe("classifyRisk — extended coverage", () => {
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

  // --- System actor bypass ---

  it("system:cron bypasses classification", () => {
    const config: RiskTierConfig = {
      ...baseConfig,
      patterns: [{ match: { action_type: "dispatch" }, tier: "critical" }],
    };
    const result = classifyRisk({
      actionType: "dispatch",
      actor: "system:cron",
    }, config);

    expect(result.tier).toBe("low");
    expect(result.reasons).toContain("system actor bypass");
  });

  it("system: prefix is the only bypass (not system without colon)", () => {
    const config: RiskTierConfig = {
      ...baseConfig,
      patterns: [{ match: { action_type: "dispatch" }, tier: "medium" }],
    };
    const result = classifyRisk({
      actionType: "dispatch",
      actor: "system-monitor",
    }, config);

    // "system-monitor" does NOT start with "system:", so no bypass
    expect(result.tier).toBe("medium");
  });

  // --- Default tier configuration ---

  it("uses configured default tier when no patterns match", () => {
    const mediumDefaultConfig: RiskTierConfig = {
      ...baseConfig,
      defaultTier: "medium",
    };
    const result = classifyRisk({
      actionType: "something_unknown",
      actor: "worker-1",
    }, mediumDefaultConfig);

    expect(result.tier).toBe("medium");
    expect(result.reasons).toContain("default tier: medium");
  });

  it("returns disabled config default tier when risk is disabled", () => {
    const disabledConfig: RiskTierConfig = {
      ...baseConfig,
      enabled: false,
      defaultTier: "high",
    };
    const result = classifyRisk({
      actionType: "anything",
      actor: "worker-1",
    }, disabledConfig);

    expect(result.tier).toBe("high");
    expect(result.reasons).toContain("risk tiers disabled");
  });

  // --- Pattern matching ---

  it("does not match when pattern field value differs", () => {
    const config: RiskTierConfig = {
      ...baseConfig,
      patterns: [{ match: { action_type: "deploy" }, tier: "high" }],
    };
    const result = classifyRisk({
      actionType: "build",
      actor: "worker-1",
    }, config);

    expect(result.tier).toBe("low"); // default
  });

  it("matches on tool_name field", () => {
    const config: RiskTierConfig = {
      ...baseConfig,
      patterns: [{ match: { tool_name: "clawforce_ops" }, tier: "high" }],
    };
    const result = classifyRisk({
      actionType: "tool_call",
      toolName: "clawforce_ops",
      actor: "manager-1",
    }, config);

    expect(result.tier).toBe("high");
  });

  it("matches on tool_action field", () => {
    const config: RiskTierConfig = {
      ...baseConfig,
      patterns: [{ match: { tool_action: "kill_agent" }, tier: "critical" }],
    };
    const result = classifyRisk({
      actionType: "tool_call",
      toolAction: "kill_agent",
      actor: "worker-1",
    }, config);

    expect(result.tier).toBe("critical");
  });

  it("matches on from_state field", () => {
    const config: RiskTierConfig = {
      ...baseConfig,
      patterns: [{ match: { from_state: "APPROVED" }, tier: "medium" }],
    };
    const result = classifyRisk({
      actionType: "transition",
      fromState: "APPROVED",
      actor: "worker-1",
    }, config);

    expect(result.tier).toBe("medium");
  });

  it("requires all fields in pattern to match (conjunction)", () => {
    const config: RiskTierConfig = {
      ...baseConfig,
      patterns: [{ match: { action_type: "transition", to_state: "DONE" }, tier: "medium" }],
    };

    // Only one field matches
    const result = classifyRisk({
      actionType: "transition",
      toState: "IN_PROGRESS",
      actor: "worker-1",
    }, config);

    expect(result.tier).toBe("low"); // pattern didn't fully match
  });

  it("ignores unknown pattern keys", () => {
    const config: RiskTierConfig = {
      ...baseConfig,
      patterns: [{ match: { unknown_field: "value" }, tier: "high" }],
    };
    const result = classifyRisk({
      actionType: "something",
      actor: "worker-1",
    }, config);

    // unknown_field is in match, switch default case is `continue`,
    // so it skips that field and the pattern matches (all checked fields passed)
    expect(result.tier).toBe("high");
  });

  // --- Higher tier precedence ---

  it("selects highest tier from multiple matching patterns", () => {
    const config: RiskTierConfig = {
      ...baseConfig,
      patterns: [
        { match: { action_type: "deploy" }, tier: "low" },
        { match: { action_type: "deploy" }, tier: "high" },
        { match: { action_type: "deploy" }, tier: "medium" },
      ],
    };
    const result = classifyRisk({
      actionType: "deploy",
      actor: "worker-1",
    }, config);

    expect(result.tier).toBe("high");
  });

  it("does not downgrade tier from later lower-tier patterns", () => {
    const config: RiskTierConfig = {
      ...baseConfig,
      patterns: [
        { match: { action_type: "deploy" }, tier: "critical" },
        { match: { action_type: "deploy" }, tier: "low" },
      ],
    };
    const result = classifyRisk({
      actionType: "deploy",
      actor: "worker-1",
    }, config);

    expect(result.tier).toBe("critical");
  });

  // --- P0 priority escalation ---

  it("P0 bumps low to medium", () => {
    const result = classifyRisk({
      actionType: "anything",
      taskPriority: "P0",
      actor: "worker-1",
    }, baseConfig);

    expect(result.tier).toBe("medium");
    expect(result.reasons).toContain("P0 task priority escalation");
  });

  it("P0 bumps medium to high", () => {
    const config: RiskTierConfig = {
      ...baseConfig,
      patterns: [{ match: { action_type: "deploy" }, tier: "medium" }],
    };
    const result = classifyRisk({
      actionType: "deploy",
      taskPriority: "P0",
      actor: "worker-1",
    }, config);

    expect(result.tier).toBe("high");
  });

  it("P0 does not bump high to critical (only escalates below high)", () => {
    const config: RiskTierConfig = {
      ...baseConfig,
      patterns: [{ match: { action_type: "deploy" }, tier: "high" }],
    };
    const result = classifyRisk({
      actionType: "deploy",
      taskPriority: "P0",
      actor: "worker-1",
    }, config);

    expect(result.tier).toBe("high");
    expect(result.reasons).not.toContain("P0 task priority escalation");
  });

  it("P0 does not bump critical (already at max)", () => {
    const config: RiskTierConfig = {
      ...baseConfig,
      patterns: [{ match: { action_type: "deploy" }, tier: "critical" }],
    };
    const result = classifyRisk({
      actionType: "deploy",
      taskPriority: "P0",
      actor: "worker-1",
    }, config);

    expect(result.tier).toBe("critical");
  });

  it("non-P0 priority does not trigger escalation", () => {
    const result = classifyRisk({
      actionType: "anything",
      taskPriority: "P1",
      actor: "worker-1",
    }, baseConfig);

    expect(result.tier).toBe("low");
    expect(result.reasons).not.toContain("P0 task priority escalation");
  });

  it("no priority does not trigger escalation", () => {
    const result = classifyRisk({
      actionType: "anything",
      actor: "worker-1",
    }, baseConfig);

    expect(result.tier).toBe("low");
    expect(result.reasons).not.toContain("P0 task priority escalation");
  });

  // --- Empty patterns ---

  it("handles config with empty patterns array", () => {
    const result = classifyRisk({
      actionType: "anything",
      actor: "worker-1",
    }, baseConfig);

    expect(result.tier).toBe("low");
    expect(result.reasons).toContain("default tier: low");
  });
});
