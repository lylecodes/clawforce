import { describe, expect, it } from "vitest";
import {
  applyProfile,
  BUILTIN_PROFILES,
  CRITICAL_SOURCES,
  DEFAULT_ACTION_SCOPES,
  generateDefaultScopePolicies,
} from "../src/profiles.js";

describe("BUILTIN_PROFILES", () => {
  it("manager has expected baseline context sources", () => {
    const sourceNames = BUILTIN_PROFILES.manager.briefing.map((s) => s.source);
    expect(sourceNames).toContain("project_md");
    expect(sourceNames).toContain("task_board");
    expect(sourceNames).toContain("escalations");
    expect(sourceNames).toContain("workflows");
    expect(sourceNames).toContain("activity");
    expect(sourceNames).toContain("sweep_status");
    expect(sourceNames).toContain("proposals");
    // instructions handled separately, should NOT be in baseline
    expect(sourceNames).not.toContain("instructions");
  });

  it("manager has clawforce_log write and clawforce_compact update_doc required", () => {
    const outputs = BUILTIN_PROFILES.manager.expectations;
    expect(outputs).toHaveLength(2);
    expect(outputs[0]!.tool).toBe("clawforce_log");
    expect(outputs[0]!.action).toBe("write");
    expect(outputs[1]!.tool).toBe("clawforce_compact");
    expect(outputs[1]!.action).toBe("update_doc");
  });

  it("manager defaults to alert on failure", () => {
    expect(BUILTIN_PROFILES.manager.performance_policy.action).toBe("alert");
  });

  it("employee has assigned_task in baseline", () => {
    const sourceNames = BUILTIN_PROFILES.employee.briefing.map((s) => s.source);
    expect(sourceNames).toContain("assigned_task");
    expect(sourceNames).not.toContain("instructions");
  });

  it("employee has transition/fail, log, and memory required", () => {
    const outputs = BUILTIN_PROFILES.employee.expectations;
    expect(outputs).toHaveLength(3);
    expect(outputs.some((o) => o.tool === "clawforce_task")).toBe(true);
    expect(outputs.some((o) => o.tool === "clawforce_log")).toBe(true);
    expect(outputs.some((o) => o.tool === "clawforce_memory")).toBe(true);
  });

  it("employee defaults to retry then alert", () => {
    const failure = BUILTIN_PROFILES.employee.performance_policy;
    expect(failure.action).toBe("retry");
    expect(failure.max_retries).toBe(3);
    expect(failure.then).toBe("alert");
  });

  it("scheduled has memory in baseline context", () => {
    expect(BUILTIN_PROFILES.scheduled.briefing).toHaveLength(1);
    expect(BUILTIN_PROFILES.scheduled.briefing[0]!.source).toBe("memory");
  });

  it("scheduled has clawforce_log outcome and memory save required", () => {
    const outputs = BUILTIN_PROFILES.scheduled.expectations;
    expect(outputs).toHaveLength(2);
    expect(outputs.some((o) => o.tool === "clawforce_log" && o.action === "outcome")).toBe(true);
    expect(outputs.some((o) => o.tool === "clawforce_memory")).toBe(true);
  });

  it("scheduled defaults to retry then terminate_and_alert", () => {
    const failure = BUILTIN_PROFILES.scheduled.performance_policy;
    expect(failure.action).toBe("retry");
    expect(failure.max_retries).toBe(3);
    expect(failure.then).toBe("terminate_and_alert");
  });

  it("manager has compaction enabled by default", () => {
    expect(BUILTIN_PROFILES.manager.compaction).toBe(true);
  });

  it("employee has compaction disabled by default", () => {
    expect(BUILTIN_PROFILES.employee.compaction).toBe(false);
  });

  it("scheduled has compaction disabled by default", () => {
    expect(BUILTIN_PROFILES.scheduled.compaction).toBe(false);
  });
});

describe("CRITICAL_SOURCES", () => {
  it("task_board is critical for manager", () => {
    expect(CRITICAL_SOURCES.manager).toContain("task_board");
  });

  it("assigned_task is critical for employee", () => {
    expect(CRITICAL_SOURCES.employee).toContain("assigned_task");
  });

  it("scheduled has no critical sources", () => {
    expect(CRITICAL_SOURCES.scheduled).toBeUndefined();
  });
});

describe("DEFAULT_ACTION_SCOPES", () => {
  it("manager has all clawforce tools", () => {
    const scope = DEFAULT_ACTION_SCOPES.manager;
    expect(scope).toContain("clawforce_task");
    expect(scope).toContain("clawforce_log");
    expect(scope).toContain("clawforce_verify");
    expect(scope).toContain("clawforce_compact");
    expect(scope).toContain("clawforce_workflow");
    expect(scope).toContain("clawforce_ops");
    expect(scope).toContain("clawforce_setup");
  });

  it("employee has limited tools", () => {
    const scope = DEFAULT_ACTION_SCOPES.employee;
    expect(scope).toContain("clawforce_task");
    expect(scope).toContain("clawforce_log");
    expect(scope).toContain("clawforce_verify");
    expect(scope).toContain("clawforce_compact");
    expect(scope).not.toContain("clawforce_setup");
    expect(scope).not.toContain("clawforce_ops");
  });

  it("scheduled has minimal tools", () => {
    const scope = DEFAULT_ACTION_SCOPES.scheduled;
    expect(scope).toContain("clawforce_log");
    expect(scope).not.toContain("clawforce_task");
    expect(scope).not.toContain("clawforce_setup");
  });
});

describe("generateDefaultScopePolicies", () => {
  it("generates policies per agent role", () => {
    const agents = {
      leon: { role: "manager" as const },
      coder: { role: "employee" as const },
      cron1: { role: "scheduled" as const },
    };

    const policies = generateDefaultScopePolicies(agents);
    expect(policies).toHaveLength(3);

    const coderPolicy = policies.find((p) => p.target === "coder")!;
    expect(coderPolicy).toBeDefined();
    expect(coderPolicy.type).toBe("action_scope");
    expect(coderPolicy.config.allowed_tools).toEqual(DEFAULT_ACTION_SCOPES.employee);
  });

  it("does not override explicit action_scope policies", () => {
    const agents = {
      leon: { role: "manager" as const },
      coder: { role: "employee" as const },
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
    const agents = { coder: { role: "employee" as const } };
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
      exclude_briefing: ["sweep_status", "proposals"],
      expectations: null,
      performance_policy: null,
    });

    const sourceNames = result.briefing.map((s) => s.source);
    expect(sourceNames).not.toContain("sweep_status");
    expect(sourceNames).not.toContain("proposals");
    expect(sourceNames).toContain("task_board"); // not excluded
  });

  it("exclusion does not remove explicitly added user sources", () => {
    const result = applyProfile("manager", {
      briefing: [{ source: "sweep_status" }],
      exclude_briefing: ["sweep_status"],
      expectations: null,
      performance_policy: null,
    });

    const sourceNames = result.briefing.map((s) => s.source);
    expect(sourceNames).toContain("sweep_status");
  });

  it("inherits expectations when agent provides null", () => {
    const result = applyProfile("employee", {
      briefing: [],
      exclude_briefing: [],
      expectations: null,
      performance_policy: null,
    });

    expect(result.expectations).toEqual(BUILTIN_PROFILES.employee.expectations);
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

    expect(result.performance_policy).toEqual(BUILTIN_PROFILES.employee.performance_policy);
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

  it("scheduled baseline has memory, user sources merge on top", () => {
    const result = applyProfile("scheduled", {
      briefing: [{ source: "custom", content: "hi" }],
      exclude_briefing: [],
      expectations: null,
      performance_policy: null,
    });

    expect(result.briefing).toHaveLength(2);
    expect(result.briefing.some((s) => s.source === "memory")).toBe(true);
    expect(result.briefing.some((s) => s.source === "custom")).toBe(true);
  });
});
