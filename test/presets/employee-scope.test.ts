import { describe, expect, it } from "vitest";
import { DEFAULT_ACTION_SCOPES, getAllowedActionsForTool } from "../../src/profiles.js";

describe("employee action scope", () => {
  const employeeScope = DEFAULT_ACTION_SCOPES.employee!;

  it("employee scope exists", () => {
    expect(employeeScope).toBeDefined();
  });

  it("employee has no clawforce_task tool", () => {
    expect(getAllowedActionsForTool(employeeScope, "clawforce_task")).toBeNull();
  });

  it("employee has no clawforce_log tool", () => {
    expect(getAllowedActionsForTool(employeeScope, "clawforce_log")).toBeNull();
  });

  it("employee has no clawforce_ops tool", () => {
    expect(getAllowedActionsForTool(employeeScope, "clawforce_ops")).toBeNull();
  });

  it("employee has no clawforce_verify tool", () => {
    expect(getAllowedActionsForTool(employeeScope, "clawforce_verify")).toBeNull();
  });

  it("employee has no clawforce_compact tool", () => {
    expect(getAllowedActionsForTool(employeeScope, "clawforce_compact")).toBeNull();
  });

  it("employee has no clawforce_setup tool", () => {
    expect(getAllowedActionsForTool(employeeScope, "clawforce_setup")).toBeNull();
  });

  it("employee has no clawforce_context tool", () => {
    expect(getAllowedActionsForTool(employeeScope, "clawforce_context")).toBeNull();
  });

  it("employee has no clawforce_message tool", () => {
    expect(getAllowedActionsForTool(employeeScope, "clawforce_message")).toBeNull();
  });

  it("employee has no clawforce_goal tool", () => {
    expect(getAllowedActionsForTool(employeeScope, "clawforce_goal")).toBeNull();
  });

  it("employee has no clawforce_channel tool", () => {
    expect(getAllowedActionsForTool(employeeScope, "clawforce_channel")).toBeNull();
  });

  it("employee retains memory_search access", () => {
    expect(getAllowedActionsForTool(employeeScope, "memory_search")).toBe("*");
  });

  it("employee retains memory_get access", () => {
    expect(getAllowedActionsForTool(employeeScope, "memory_get")).toBe("*");
  });

  it("manager still has clawforce tools", () => {
    const managerScope = DEFAULT_ACTION_SCOPES.manager!;
    expect(getAllowedActionsForTool(managerScope, "clawforce_task")).toBe("*");
    expect(getAllowedActionsForTool(managerScope, "clawforce_log")).toBe("*");
    expect(getAllowedActionsForTool(managerScope, "clawforce_ops")).toBe("*");
  });
});
