import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAgentConfig,
  getApprovalPolicy,
  loadWorkforceConfig,
  registerWorkforceConfig,
  resetEnforcementConfigForTest,
} from "../../src/project.js";
import { validateWorkforceConfig } from "../../src/config-validator.js";

describe("enforcement config loading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-config-test-"));
    resetEnforcementConfigForTest();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetEnforcementConfigForTest();
  });

  function writeYaml(filename: string, content: string): string {
    const p = path.join(tmpDir, filename);
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("loads a full enforcement config with agents", () => {
    const configPath = writeYaml("project.yaml", `
name: my-project

approval:
  policy: |
    You may proceed without approval for:
    - Routine maintenance tasks
    Everything else requires approval.

agents:
  leon:
    role: orchestrator
    context_in:
      - source: instructions
      - source: custom
        content: "You are the project orchestrator."
    required_outputs:
      - tool: clawforce_task
        action: [propose]
        min_calls: 1
      - tool: clawforce_log
        action: write
        min_calls: 1
    on_failure:
      action: alert
      channel: telegram

  coder:
    role: worker
    context_in:
      - source: instructions
    required_outputs:
      - tool: clawforce_task
        action: [transition, fail]
        min_calls: 1
      - tool: clawforce_log
        action: write
        min_calls: 1
    on_failure:
      action: retry
      max_retries: 3
      then: alert
`);

    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.name).toBe("my-project");

    // Approval policy
    expect(config!.approval?.policy).toContain("Routine maintenance");

    // Leon (manager) — gets role profile defaults merged in
    const leon = config!.agents.leon;
    expect(leon).toBeDefined();
    expect(leon!.role).toBe("manager");
    // Should have manager baseline + user sources (instructions, custom)
    expect(leon!.briefing.some((s) => s.source === "instructions")).toBe(true);
    expect(leon!.briefing.some((s) => s.source === "task_board")).toBe(true);
    expect(leon!.briefing.some((s) => s.source === "project_md")).toBe(true);
    expect(leon!.briefing.some((s) => s.source === "escalations")).toBe(true);
    const customSource = leon!.briefing.find((s) => s.source === "custom");
    expect(customSource).toBeDefined();
    expect(customSource!.content).toBe("You are the project orchestrator.");
    // Explicit expectations replaces profile defaults
    expect(leon!.expectations).toHaveLength(2);
    expect(leon!.expectations[0]!.tool).toBe("clawforce_task");
    expect(leon!.expectations[0]!.action).toEqual(["propose"]);
    expect(leon!.performance_policy.action).toBe("alert");

    // Coder (employee)
    const coder = config!.agents.coder;
    expect(coder).toBeDefined();
    expect(coder!.role).toBe("employee");
    expect(coder!.performance_policy.action).toBe("retry");
    expect(coder!.performance_policy.max_retries).toBe(3);
    expect(coder!.performance_policy.then).toBe("alert");
  });

  it("auto-injects instructions source if missing", () => {
    const configPath = writeYaml("project.yaml", `
name: test
agents:
  agent1:
    role: worker
    context_in:
      - source: custom
        content: "hello"
    required_outputs:
      - tool: clawforce_log
        action: write
        min_calls: 1
    on_failure:
      action: alert
`);

    const config = loadWorkforceConfig(configPath);
    const sources = config!.agents.agent1!.briefing;
    expect(sources[0]!.source).toBe("instructions");
    // Employee profile baseline (assigned_task) + user custom
    expect(sources.some((s) => s.source === "assigned_task")).toBe(true);
    expect(sources.some((s) => s.source === "custom")).toBe(true);
  });

  it("does not duplicate instructions if already present", () => {
    const configPath = writeYaml("project.yaml", `
name: test
agents:
  agent1:
    role: worker
    context_in:
      - source: instructions
    required_outputs:
      - tool: clawforce_log
        action: write
        min_calls: 1
    on_failure:
      action: alert
`);

    const config = loadWorkforceConfig(configPath);
    const instructionSources = config!.agents.agent1!.briefing.filter(
      (s) => s.source === "instructions",
    );
    expect(instructionSources).toHaveLength(1);
  });

  it("returns null for legacy config format (no enforcement agents)", () => {
    const configPath = writeYaml("project.yaml", `
id: test-project
name: Test
agents:
  project: default
  workers:
    - type: claude-code
`);

    const config = loadWorkforceConfig(configPath);
    expect(config).toBeNull();
  });

  it("handles knowledge filter in context sources", () => {
    const configPath = writeYaml("project.yaml", `
name: test
agents:
  agent1:
    role: orchestrator
    context_in:
      - source: knowledge
        filter:
          category: [decision, pattern]
          tags: [architecture]
    required_outputs:
      - tool: clawforce_log
        action: write
        min_calls: 1
    on_failure:
      action: alert
`);

    const config = loadWorkforceConfig(configPath);
    const knowledgeSource = config!.agents.agent1!.briefing.find(
      (s) => s.source === "knowledge",
    );
    expect(knowledgeSource!.filter).toEqual({
      category: ["decision", "pattern"],
      tags: ["architecture"],
    });
  });

  it("handles cron agent config", () => {
    const configPath = writeYaml("project.yaml", `
name: test
agents:
  outreach:
    role: cron
    context_in:
      - source: instructions
    required_outputs:
      - tool: clawforce_log
        action: outcome
        min_calls: 1
    on_failure:
      action: retry
      max_retries: 3
      then: disable_and_alert
`);

    const config = loadWorkforceConfig(configPath);
    const outreach = config!.agents.outreach;
    expect(outreach!.role).toBe("scheduled");
    expect(outreach!.performance_policy.action).toBe("retry");
    expect(outreach!.performance_policy.then).toBe("terminate_and_alert");
  });
});

describe("enforcement config registry", () => {
  beforeEach(() => {
    resetEnforcementConfigForTest();
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
  });

  it("registers and retrieves agent configs", () => {
    registerWorkforceConfig("proj1", {
      name: "test",
      agents: {
        leon: {
          role: "manager",
          briefing: [{ source: "instructions" }],
          expectations: [{ tool: "clawforce_task", action: "propose", min_calls: 1 }],
          performance_policy: { action: "alert" },
        },
      },
    });

    const entry = getAgentConfig("leon");
    expect(entry).not.toBeNull();
    expect(entry!.projectId).toBe("proj1");
    expect(entry!.config.role).toBe("manager");
  });

  it("returns null for unregistered agents", () => {
    expect(getAgentConfig("unknown")).toBeNull();
  });

  it("registers and retrieves approval policies", () => {
    registerWorkforceConfig("proj1", {
      name: "test",
      approval: { policy: "Always require approval." },
      agents: {
        agent1: {
          role: "employee",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    });

    const policy = getApprovalPolicy("proj1");
    expect(policy).not.toBeNull();
    expect(policy!.policy).toBe("Always require approval.");
  });
});

describe("config validation", () => {
  it("returns no warnings for valid config", () => {
    const warnings = validateWorkforceConfig({
      name: "my-project",
      approval: { policy: "Approve everything small." },
      agents: {
        leon: {
          role: "manager",
          briefing: [{ source: "instructions" }],
          expectations: [
            { tool: "clawforce_task", action: ["propose"], min_calls: 1 },
            { tool: "clawforce_log", action: "write", min_calls: 1 },
          ],
          performance_policy: { action: "alert" },
        },
      },
    });

    expect(warnings).toHaveLength(0);
  });

  it("warns when agent has no expectations", () => {
    const warnings = validateWorkforceConfig({
      name: "test",
      agents: {
        agent1: {
          role: "employee",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    });

    expect(warnings.some((w) => w.message.includes("no expectations"))).toBe(true);
  });

  it("warns when retry has no max_retries", () => {
    const warnings = validateWorkforceConfig({
      name: "test",
      agents: {
        agent1: {
          role: "employee",
          briefing: [],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "retry" },
        },
      },
    });

    expect(warnings.some((w) => w.message.includes("no max_retries"))).toBe(true);
  });

  it("warns when scheduled agent lacks clawforce_log outcome", () => {
    const warnings = validateWorkforceConfig({
      name: "test",
      agents: {
        cron1: {
          role: "scheduled",
          briefing: [],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
        },
      },
    });

    expect(warnings.some((w) => w.message.includes("clawforce_log outcome"))).toBe(true);
  });

  it("warns when manager has approval policy but no propose requirement", () => {
    const warnings = validateWorkforceConfig({
      name: "test",
      approval: { policy: "Require approval for everything." },
      agents: {
        orch: {
          role: "manager",
          briefing: [],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
        },
      },
    });

    expect(warnings.some((w) => w.message.includes("get_approval_context"))).toBe(true);
  });

  it("errors when file source has no path", () => {
    const warnings = validateWorkforceConfig({
      name: "test",
      agents: {
        agent1: {
          role: "employee",
          briefing: [{ source: "file" }],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
        },
      },
    });

    expect(warnings.some((w) => w.level === "error" && w.message.includes("path"))).toBe(true);
  });

  it("warns when employee excludes critical source assigned_task", () => {
    const warnings = validateWorkforceConfig({
      name: "test",
      agents: {
        w1: {
          role: "employee",
          briefing: [{ source: "instructions" }],
          exclude_briefing: ["assigned_task"],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
        },
      },
    });

    expect(warnings.some((w) =>
      w.message.includes("assigned_task") && w.message.includes("critical"),
    )).toBe(true);
  });

  it("warns when manager excludes critical source task_board", () => {
    const warnings = validateWorkforceConfig({
      name: "test",
      agents: {
        orch: {
          role: "manager",
          briefing: [{ source: "instructions" }],
          exclude_briefing: ["task_board"],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
        },
      },
    });

    expect(warnings.some((w) =>
      w.message.includes("task_board") && w.message.includes("critical"),
    )).toBe(true);
  });

  it("warns about unknown exclude_briefing values", () => {
    const warnings = validateWorkforceConfig({
      name: "test",
      agents: {
        agent1: {
          role: "employee",
          briefing: [],
          exclude_briefing: ["nonexistent_source"],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
        },
      },
    });

    expect(warnings.some((w) =>
      w.message.includes("nonexistent_source") && w.message.includes("unknown"),
    )).toBe(true);
  });
});

describe("escalation cycle detection", () => {
  it("errors on direct escalation cycle (A→B→C→A)", () => {
    const warnings = validateWorkforceConfig({
      name: "test",
      agents: {
        a: {
          role: "employee",
          briefing: [],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
          reports_to: "b",
        },
        b: {
          role: "manager",
          briefing: [],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
          reports_to: "c",
        },
        c: {
          role: "manager",
          briefing: [],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
          reports_to: "a",
        },
      },
    });

    const cycleErrors = warnings.filter(
      (w) => w.level === "error" && w.message.includes("cycle"),
    );
    expect(cycleErrors.length).toBeGreaterThan(0);
  });

  it("warns on escalation chains deeper than 5 levels", () => {
    const agents: Record<string, {
      role: "employee" | "manager";
      briefing: [];
      expectations: { tool: string; action: string; min_calls: number }[];
      performance_policy: { action: "alert" };
      reports_to?: string;
    }> = {};

    // Create a chain: e0 → e1 → e2 → e3 → e4 → e5 → e6
    for (let i = 0; i <= 6; i++) {
      agents[`e${i}`] = {
        role: i === 0 ? "employee" : "manager",
        briefing: [],
        expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
        performance_policy: { action: "alert" },
        ...(i < 6 ? { reports_to: `e${i + 1}` } : { reports_to: "parent" }),
      };
    }

    const warnings = validateWorkforceConfig({
      name: "test",
      agents,
    });

    const deepWarnings = warnings.filter(
      (w) => w.message.includes("levels deep"),
    );
    expect(deepWarnings.length).toBeGreaterThan(0);
  });

  it("does not warn on valid 3-level chain", () => {
    const warnings = validateWorkforceConfig({
      name: "test",
      agents: {
        worker: {
          role: "employee",
          briefing: [],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
          reports_to: "lead",
        },
        lead: {
          role: "manager",
          briefing: [],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
          reports_to: "director",
        },
        director: {
          role: "manager",
          briefing: [],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
          reports_to: "parent",
        },
      },
    });

    const cycleErrors = warnings.filter((w) => w.message.includes("cycle"));
    const deepWarnings = warnings.filter((w) => w.message.includes("levels deep"));
    expect(cycleErrors).toHaveLength(0);
    expect(deepWarnings).toHaveLength(0);
  });
});

describe("profile defaults via config loading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-profile-test-"));
    resetEnforcementConfigForTest();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetEnforcementConfigForTest();
  });

  function writeYaml(filename: string, content: string): string {
    const p = path.join(tmpDir, filename);
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("manager gets profile defaults when no context_in specified", () => {
    const configPath = writeYaml("project.yaml", `
name: test
agents:
  orch:
    role: orchestrator
    required_outputs:
      - tool: clawforce_log
        action: write
        min_calls: 1
    on_failure:
      action: alert
`);

    const config = loadWorkforceConfig(configPath);
    const orch = config!.agents.orch!;
    const sourceNames = orch.briefing.map((s) => s.source);

    expect(sourceNames).toContain("instructions");
    expect(sourceNames).toContain("task_board");
    expect(sourceNames).toContain("project_md");
    expect(sourceNames).toContain("escalations");
    expect(sourceNames).toContain("workflows");
    expect(sourceNames).toContain("activity");
    expect(sourceNames).toContain("sweep_status");
    expect(sourceNames).toContain("proposals");
  });

  it("employee inherits profile expectations and performance_policy when omitted", () => {
    const configPath = writeYaml("project.yaml", `
name: test
agents:
  w1:
    role: worker
`);

    const config = loadWorkforceConfig(configPath);
    const w1 = config!.agents.w1!;

    // Inherits employee profile defaults
    expect(w1.briefing.some((s) => s.source === "assigned_task")).toBe(true);
    expect(w1.expectations.some((r) => r.tool === "clawforce_task")).toBe(true);
    expect(w1.expectations.some((r) => r.tool === "clawforce_log")).toBe(true);
    expect(w1.performance_policy.action).toBe("retry");
    expect(w1.performance_policy.max_retries).toBe(3);
    expect(w1.performance_policy.then).toBe("alert");
  });

  it("scheduled inherits profile defaults", () => {
    const configPath = writeYaml("project.yaml", `
name: test
agents:
  cron1:
    role: cron
`);

    const config = loadWorkforceConfig(configPath);
    const cron = config!.agents.cron1!;

    // instructions (auto-injected) + memory (scheduled baseline)
    expect(cron.briefing).toHaveLength(2);
    expect(cron.briefing[0]!.source).toBe("instructions");
    expect(cron.briefing[1]!.source).toBe("memory");
    // Inherits scheduled profile expectations
    expect(cron.expectations.some((r) => r.tool === "clawforce_log" &&
      (Array.isArray(r.action) ? r.action.includes("outcome") : r.action === "outcome"),
    )).toBe(true);
    // Inherits scheduled profile performance_policy
    expect(cron.performance_policy.action).toBe("retry");
    expect(cron.performance_policy.then).toBe("terminate_and_alert");
  });

  it("does not duplicate when user explicitly includes a baseline source", () => {
    const configPath = writeYaml("project.yaml", `
name: test
agents:
  orch:
    role: orchestrator
    context_in:
      - source: task_board
    required_outputs:
      - tool: clawforce_log
        action: write
        min_calls: 1
    on_failure:
      action: alert
`);

    const config = loadWorkforceConfig(configPath);
    const orch = config!.agents.orch!;
    const taskBoardSources = orch.briefing.filter((s) => s.source === "task_board");
    expect(taskBoardSources).toHaveLength(1);
  });

  it("respects exclude_context to remove baseline sources", () => {
    const configPath = writeYaml("project.yaml", `
name: test
agents:
  orch:
    role: orchestrator
    exclude_context:
      - sweep_status
      - proposals
    required_outputs:
      - tool: clawforce_log
        action: write
        min_calls: 1
    on_failure:
      action: alert
`);

    const config = loadWorkforceConfig(configPath);
    const orch = config!.agents.orch!;
    const sourceNames = orch.briefing.map((s) => s.source);

    expect(sourceNames).toContain("task_board");
    expect(sourceNames).not.toContain("sweep_status");
    expect(sourceNames).not.toContain("proposals");
    expect(orch.exclude_briefing).toEqual(["sweep_status", "proposals"]);
  });

  it("proposals source is now valid (bug fix)", () => {
    const configPath = writeYaml("project.yaml", `
name: test
agents:
  orch:
    role: orchestrator
    context_in:
      - source: proposals
    required_outputs:
      - tool: clawforce_log
        action: write
        min_calls: 1
    on_failure:
      action: alert
`);

    const config = loadWorkforceConfig(configPath);
    const orch = config!.agents.orch!;
    // proposals should be recognized, not converted to "custom"
    expect(orch.briefing.some((s) => s.source === "proposals")).toBe(true);
  });
});
