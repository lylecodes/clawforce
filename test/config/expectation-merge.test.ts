import { describe, expect, it } from "vitest";

const { mergeDomainDefaults } = await import("../../src/config/init.js");
import type { AgentConfig } from "../../src/types.js";

describe("mergeDomainDefaults expectation override", () => {
  const baseAgent: AgentConfig = {
    extends: "employee",
    title: "Worker",
    briefing: [],
    expectations: [],
    performance_policy: { action: "alert" as const, max_retries: 3, then: "alert" as const },
  };

  const domainDefaults = {
    expectations: [
      { tool: "clawforce_log", action: "write", min: 1 },
    ],
  };

  it("appends domain expectations when user did NOT explicitly set them", () => {
    const result = mergeDomainDefaults(baseAgent, domainDefaults, false);
    expect(result.expectations).toHaveLength(1);
    expect(result.expectations[0]).toMatchObject({ tool: "clawforce_log" });
  });

  it("skips domain expectations when user explicitly set expectations: []", () => {
    const result = mergeDomainDefaults(baseAgent, domainDefaults, true);
    expect(result.expectations).toHaveLength(0);
  });

  it("skips domain expectations when user explicitly set non-empty expectations", () => {
    const agentWithExpectations = {
      ...baseAgent,
      expectations: [{ tool: "custom_tool", action: "run", min: 1 }],
    };
    const result = mergeDomainDefaults(agentWithExpectations, domainDefaults, true);
    // Should keep user's expectations, not append domain defaults
    expect(result.expectations).toHaveLength(1);
    expect(result.expectations[0]).toMatchObject({ tool: "custom_tool" });
  });

  it("still appends when no domain defaults exist", () => {
    const result = mergeDomainDefaults(baseAgent, {}, false);
    expect(result.expectations).toHaveLength(0);
  });
});
