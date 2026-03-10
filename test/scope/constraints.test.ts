import { describe, expect, it } from "vitest";
import { getAllowedActionsForTool, getConstraintsForTool } from "../../src/profiles.js";
import type { ActionScope } from "../../src/types.js";

describe("ActionConstraint support", () => {
  it("getAllowedActionsForTool extracts actions from ActionConstraint", () => {
    const scope: ActionScope = {
      clawforce_task: {
        actions: ["get", "list"],
        constraints: { own_tasks_only: true },
      },
    };
    expect(getAllowedActionsForTool(scope, "clawforce_task")).toEqual(["get", "list"]);
  });

  it("getAllowedActionsForTool handles wildcard ActionConstraint", () => {
    const scope: ActionScope = {
      clawforce_task: {
        actions: "*",
        constraints: { department_only: true },
      },
    };
    expect(getAllowedActionsForTool(scope, "clawforce_task")).toBe("*");
  });

  it("getAllowedActionsForTool handles plain string[] as before", () => {
    const scope: ActionScope = {
      clawforce_task: ["get", "list"],
    };
    expect(getAllowedActionsForTool(scope, "clawforce_task")).toEqual(["get", "list"]);
  });

  it("getAllowedActionsForTool handles plain * as before", () => {
    const scope: ActionScope = {
      clawforce_task: "*",
    };
    expect(getAllowedActionsForTool(scope, "clawforce_task")).toBe("*");
  });

  it("getAllowedActionsForTool returns null for missing tool", () => {
    const scope: ActionScope = {
      clawforce_task: "*",
    };
    expect(getAllowedActionsForTool(scope, "clawforce_log")).toBeNull();
  });

  it("getConstraintsForTool returns constraints from ActionConstraint", () => {
    const scope: ActionScope = {
      clawforce_task: {
        actions: ["get", "list"],
        constraints: { own_tasks_only: true, department_only: false },
      },
    };
    expect(getConstraintsForTool(scope, "clawforce_task")).toEqual({
      own_tasks_only: true,
      department_only: false,
    });
  });

  it("getConstraintsForTool returns undefined for plain string[]", () => {
    const scope: ActionScope = {
      clawforce_task: ["get"],
    };
    expect(getConstraintsForTool(scope, "clawforce_task")).toBeUndefined();
  });

  it("getConstraintsForTool returns undefined for wildcard", () => {
    const scope: ActionScope = {
      clawforce_task: "*",
    };
    expect(getConstraintsForTool(scope, "clawforce_task")).toBeUndefined();
  });

  it("getConstraintsForTool returns undefined for missing tool", () => {
    const scope: ActionScope = {};
    expect(getConstraintsForTool(scope, "clawforce_task")).toBeUndefined();
  });
});
