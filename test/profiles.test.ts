import { describe, expect, it } from "vitest";
import {
  applyProfile,
  DEFAULT_ACTION_SCOPES,
  generateDefaultScopePolicies,
  getToolNamesFromScope,
  getAllowedActionsForTool,
} from "../src/profiles.js";
import { BUILTIN_AGENT_PRESETS } from "../src/presets.js";

describe("DEFAULT_ACTION_SCOPES", () => {
  it("manager has all clawforce tools with wildcard access", () => {
    const scope = DEFAULT_ACTION_SCOPES.manager!;
    const toolNames = getToolNamesFromScope(scope);
    expect(toolNames).toContain("clawforce_task");
    expect(toolNames).toContain("clawforce_log");
    expect(toolNames).toContain("clawforce_verify");
    expect(toolNames).toContain("clawforce_compact");
    expect(toolNames).toContain("clawforce_workflow");
    expect(toolNames).toContain("clawforce_ops");
    expect(toolNames).toContain("clawforce_setup");
    expect(toolNames).toContain("clawforce_goal");
    // All tools have wildcard access for manager
    for (const tool of toolNames) {
      expect(getAllowedActionsForTool(scope, tool)).toBe("*");
    }
  });

  it("employee has no clawforce tools (auto-lifecycle)", () => {
    const scope = DEFAULT_ACTION_SCOPES.employee!;
    const toolNames = getToolNamesFromScope(scope);
    expect(toolNames).not.toContain("clawforce_task");
    expect(toolNames).not.toContain("clawforce_log");
    expect(toolNames).not.toContain("clawforce_verify");
    expect(toolNames).not.toContain("clawforce_compact");
    expect(toolNames).not.toContain("clawforce_setup");
    expect(toolNames).not.toContain("clawforce_goal");
    expect(toolNames).not.toContain("clawforce_ops");
    expect(toolNames).not.toContain("clawforce_workflow");
    expect(toolNames).toContain("memory_search");
    expect(toolNames).toContain("memory_get");
  });
});

describe("generateDefaultScopePolicies", () => {
  it("generates policies per agent preset with ActionScope format", () => {
    const agents = {
      leon: { extends: "manager" },
      coder: { extends: "employee" },
    };

    const policies = generateDefaultScopePolicies(agents);
    expect(policies).toHaveLength(2);

    const coderPolicy = policies.find((p) => p.target === "coder")!;
    expect(coderPolicy).toBeDefined();
    expect(coderPolicy.type).toBe("action_scope");
    // Should be object format, not array
    const allowedTools = coderPolicy.config.allowed_tools as Record<string, unknown>;
    expect(typeof allowedTools).toBe("object");
    expect(Array.isArray(allowedTools)).toBe(false);
    expect(allowedTools.memory_search).toEqual(DEFAULT_ACTION_SCOPES.employee!.memory_search);
  });

  it("defaults to employee scope when extends is not specified", () => {
    const agents = {
      worker: {},
    };

    const policies = generateDefaultScopePolicies(agents);
    expect(policies).toHaveLength(1);
    const allowedTools = policies[0]!.config.allowed_tools as Record<string, unknown>;
    expect(allowedTools.memory_search).toEqual(DEFAULT_ACTION_SCOPES.employee!.memory_search);
  });

  it("does not override explicit action_scope policies", () => {
    const agents = {
      leon: { extends: "manager" },
      coder: { extends: "employee" },
    };
    const existingPolicies = [
      { type: "action_scope", target: "coder" },
    ];

    const policies = generateDefaultScopePolicies(agents, existingPolicies);
    // coder should be skipped because it already has an explicit policy
    expect(policies).toHaveLength(1);
    expect(policies[0]!.target).toBe("leon");
  });

  it("returns empty array when all agents are covered", () => {
    const agents = { coder: { extends: "employee" } };
    const existingPolicies = [{ type: "action_scope", target: "coder" }];

    const policies = generateDefaultScopePolicies(agents, existingPolicies);
    expect(policies).toHaveLength(0);
  });
});

describe("applyProfile", () => {
  it("adds baseline context sources when user provides none", () => {
    const result = applyProfile("manager", {
      briefing: [],
      exclude_briefing: [],
      expectations: null,
      performance_policy: null,
    });

    const sourceNames = result.briefing.map((s) => s.source);
    expect(sourceNames).toContain("task_board");
    expect(sourceNames).toContain("project_md");
    expect(sourceNames).toContain("escalations");
  });

  it("deduplicates when user already includes a baseline source", () => {
    const result = applyProfile("manager", {
      briefing: [{ source: "task_board" }],
      exclude_briefing: [],
      expectations: null,
      performance_policy: null,
    });

    const taskBoardCount = result.briefing.filter((s) => s.source === "task_board").length;
    expect(taskBoardCount).toBe(1);
  });

  it("user sources come after baseline sources", () => {
    const result = applyProfile("manager", {
      briefing: [{ source: "custom", content: "hello" }],
      exclude_briefing: [],
      expectations: null,
      performance_policy: null,
    });

    const lastSource = result.briefing[result.briefing.length - 1];
    expect(lastSource!.source).toBe("custom");
  });

  it("excludes specified baseline sources", () => {
    const result = applyProfile("manager", {
      briefing: [],
      exclude_briefing: ["cost_summary", "trust_scores"],
      expectations: null,
      performance_policy: null,
    });

    const sourceNames = result.briefing.map((s) => s.source);
    expect(sourceNames).not.toContain("cost_summary");
    expect(sourceNames).not.toContain("trust_scores");
    expect(sourceNames).toContain("task_board"); // not excluded
  });

  it("exclusion does not remove explicitly added user sources", () => {
    const result = applyProfile("manager", {
      briefing: [{ source: "cost_summary" }],
      exclude_briefing: ["cost_summary"],
      expectations: null,
      performance_policy: null,
    });

    const sourceNames = result.briefing.map((s) => s.source);
    expect(sourceNames).toContain("cost_summary");
  });

  it("inherits expectations when agent provides null", () => {
    const result = applyProfile("employee", {
      briefing: [],
      exclude_briefing: [],
      expectations: null,
      performance_policy: null,
    });

    expect(result.expectations).toEqual(BUILTIN_AGENT_PRESETS.employee!.expectations);
  });

  it("replaces expectations when agent provides them", () => {
    const custom = [{ tool: "clawforce_task", action: "propose" as string | string[], min_calls: 2 }];
    const result = applyProfile("manager", {
      briefing: [],
      exclude_briefing: [],
      expectations: custom,
      performance_policy: null,
    });

    expect(result.expectations).toEqual(custom);
  });

  it("inherits performance_policy when agent provides null", () => {
    const result = applyProfile("employee", {
      briefing: [],
      exclude_briefing: [],
      expectations: null,
      performance_policy: null,
    });

    expect(result.performance_policy).toEqual(BUILTIN_AGENT_PRESETS.employee!.performance_policy);
  });

  it("replaces performance_policy when agent provides it", () => {
    const custom = { action: "terminate_and_alert" as const };
    const result = applyProfile("employee", {
      briefing: [],
      exclude_briefing: [],
      expectations: null,
      performance_policy: custom,
    });

    expect(result.performance_policy).toEqual(custom);
  });

  it("employee baseline includes assigned_task", () => {
    const result = applyProfile("employee", {
      briefing: [],
      exclude_briefing: [],
      expectations: null,
      performance_policy: null,
    });

    const sourceNames = result.briefing.map((s) => s.source);
    expect(sourceNames).toContain("assigned_task");
  });

  it("unknown preset returns agent config as-is with defaults", () => {
    const result = applyProfile("nonexistent", {
      briefing: [{ source: "custom", content: "hi" }],
      exclude_briefing: [],
      expectations: null,
      performance_policy: null,
    });

    expect(result.briefing).toHaveLength(1);
    expect(result.briefing[0]!.source).toBe("custom");
    expect(result.expectations).toEqual([]);
    expect(result.performance_policy).toEqual({ action: "alert" });
  });
});

describe("getToolNamesFromScope", () => {
  it("returns tool names from an ActionScope", () => {
    const names = getToolNamesFromScope({ tool_a: "*", tool_b: ["x", "y"] });
    expect(names).toEqual(["tool_a", "tool_b"]);
  });

  it("returns empty array for empty scope", () => {
    expect(getToolNamesFromScope({})).toEqual([]);
  });
});

describe("getAllowedActionsForTool", () => {
  it("returns '*' for wildcard tools", () => {
    expect(getAllowedActionsForTool({ clawforce_task: "*" }, "clawforce_task")).toBe("*");
  });

  it("returns string[] for restricted tools", () => {
    const actions = getAllowedActionsForTool({ clawforce_task: ["get", "list"] }, "clawforce_task");
    expect(actions).toEqual(["get", "list"]);
  });

  it("returns null for tools not in scope", () => {
    expect(getAllowedActionsForTool({ clawforce_task: "*" }, "clawforce_ops")).toBeNull();
  });
});
