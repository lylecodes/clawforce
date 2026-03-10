import { describe, expect, it } from "vitest";
import { validatePolicyConfigs } from "../../src/policy/normalizer.js";

describe("validatePolicyConfigs", () => {
  it("accepts valid action_scope policy with known tools", () => {
    const errors = validatePolicyConfigs([
      { name: "scope1", type: "action_scope", config: { allowed_tools: ["clawforce_task"] } },
    ], ["clawforce_task", "clawforce_log"]);

    expect(errors).toHaveLength(0);
  });

  it("reports unknown tool in allowed_tools when validTools is provided", () => {
    const errors = validatePolicyConfigs([
      { name: "scope1", type: "action_scope", config: { allowed_tools: ["nonexistent_tool"] } },
    ], ["clawforce_task", "clawforce_log"]);

    const toolErrors = errors.filter((e) => e.message.includes("Unknown tool"));
    expect(toolErrors).toHaveLength(1);
    expect(toolErrors[0]!.message).toContain("nonexistent_tool");
  });

  it("reports unknown tool in denied_tools when validTools is provided", () => {
    const errors = validatePolicyConfigs([
      { name: "scope1", type: "action_scope", config: { denied_tools: ["fake_tool"] } },
    ], ["clawforce_task"]);

    const toolErrors = errors.filter((e) => e.message.includes("Unknown tool"));
    expect(toolErrors).toHaveLength(1);
    expect(toolErrors[0]!.message).toContain("fake_tool");
  });

  it("does not validate tool names when validTools is empty", () => {
    const errors = validatePolicyConfigs([
      { name: "scope1", type: "action_scope", config: { allowed_tools: ["anything"] } },
    ], []);

    expect(errors).toHaveLength(0);
  });

  it("still reports overlap even with unknown tools", () => {
    const errors = validatePolicyConfigs([
      { name: "scope1", type: "action_scope", config: { allowed_tools: ["tool_a"], denied_tools: ["tool_a"] } },
    ], ["tool_a"]);

    const overlapErrors = errors.filter((e) => e.message.includes("both allow and deny"));
    expect(overlapErrors).toHaveLength(1);
  });

  it("reports missing allowed_tools and denied_tools", () => {
    const errors = validatePolicyConfigs([
      { name: "empty_scope", type: "action_scope", config: {} },
    ], []);

    expect(errors.some((e) => e.message.includes("must have allowed_tools or denied_tools"))).toBe(true);
  });

  it("rejects unknown policy type", () => {
    const errors = validatePolicyConfigs([
      { name: "bad", type: "unknown_type", config: {} },
    ], []);

    expect(errors.some((e) => e.message.includes("Unknown policy type"))).toBe(true);
  });

  it("accepts valid ActionScope object format", () => {
    const errors = validatePolicyConfigs([
      {
        name: "scope1",
        type: "action_scope",
        config: {
          allowed_tools: {
            clawforce_task: ["get", "list"],
            clawforce_log: "*",
          },
        },
      },
    ], ["clawforce_task", "clawforce_log"]);

    expect(errors).toHaveLength(0);
  });

  it("reports invalid action value in ActionScope format", () => {
    const errors = validatePolicyConfigs([
      {
        name: "scope1",
        type: "action_scope",
        config: {
          allowed_tools: {
            clawforce_task: 42,
          },
        },
      },
    ], ["clawforce_task"]);

    expect(errors.some((e) => e.message.includes("Invalid action value"))).toBe(true);
  });

  it("reports unknown tool in ActionScope object keys", () => {
    const errors = validatePolicyConfigs([
      {
        name: "scope1",
        type: "action_scope",
        config: {
          allowed_tools: {
            nonexistent_tool: "*",
          },
        },
      },
    ], ["clawforce_task"]);

    expect(errors.some((e) => e.message.includes("Unknown tool") && e.message.includes("nonexistent_tool"))).toBe(true);
  });

  it("legacy string[] format still accepted", () => {
    const errors = validatePolicyConfigs([
      { name: "scope1", type: "action_scope", config: { allowed_tools: ["clawforce_task"] } },
    ], ["clawforce_task"]);

    expect(errors).toHaveLength(0);
  });

  it("detects allow/deny overlap with ActionScope object format", () => {
    const errors = validatePolicyConfigs([
      {
        name: "scope1",
        type: "action_scope",
        config: {
          allowed_tools: { clawforce_task: "*" },
          denied_tools: ["clawforce_task"],
        },
      },
    ], ["clawforce_task"]);

    expect(errors.some((e) => e.message.includes("both allow and deny"))).toBe(true);
  });
});
