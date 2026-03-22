import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_PRESETS } from "../../src/presets.js";

describe("employee preset expectations", () => {
  const emp = BUILTIN_AGENT_PRESETS.employee;

  it("employee expectations is an empty array", () => {
    expect(emp.expectations).toEqual([]);
  });

  it("employee expectations has no clawforce_task expectation", () => {
    const expectations = emp.expectations as Array<{ tool: string }>;
    const hasCfTask = expectations.some((e) => e.tool === "clawforce_task");
    expect(hasCfTask).toBe(false);
  });

  it("employee expectations has no clawforce_log expectation", () => {
    const expectations = emp.expectations as Array<{ tool: string }>;
    const hasCfLog = expectations.some((e) => e.tool === "clawforce_log");
    expect(hasCfLog).toBe(false);
  });
});
