import { beforeEach, describe, expect, it } from "vitest";

const { hireAgent } = await import("../../src/adaptation/hire.js");
const { getAgentConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");

beforeEach(() => {
  resetEnforcementConfigForTest();
});

describe("hireAgent", () => {
  it("registers a new agent with the given spec", () => {
    const result = hireAgent("test-project", {
      agentId: "budget-ops",
      extends: "employee",
      title: "Budget Operations Specialist",
      reports_to: "lead",
      observe: ["budget.exceeded", "budget.warning"],
      briefing: [{ source: "instructions" }],
    });

    expect(result.success).toBe(true);
    expect(result.agentId).toBe("budget-ops");

    // Verify it's registered
    const config = getAgentConfig("budget-ops");
    expect(config).not.toBeNull();
    expect(config!.config.title).toBe("Budget Operations Specialist");
    expect(config!.config.observe).toEqual(["budget.exceeded", "budget.warning"]);
  });

  it("rejects hire if agent already exists", () => {
    hireAgent("test-project", {
      agentId: "budget-ops",
      extends: "employee",
      title: "Budget Ops",
      reports_to: "lead",
    });

    const result = hireAgent("test-project", {
      agentId: "budget-ops",
      extends: "employee",
      title: "Budget Ops Duplicate",
      reports_to: "lead",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");
  });

  it("rejects hire if reports_to is not specified", () => {
    const result = hireAgent("test-project", {
      agentId: "orphan",
      extends: "employee",
      title: "Orphan Agent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("reports_to");
  });

  it("defaults to employee preset when extends is not specified", () => {
    const result = hireAgent("test-project", {
      agentId: "generic",
      title: "Generic Worker",
      reports_to: "lead",
    });

    expect(result.success).toBe(true);
    const config = getAgentConfig("generic");
    expect(config!.config.extends).toBe("employee");
  });
});
