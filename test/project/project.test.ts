import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateWorkforceProject,
  getAgentConfig,
  getRegisteredAgentIds,
  loadWorkforceConfig,
  registerWorkforceConfig,
  resetEnforcementConfigForTest,
  resolveOpenClawAgentId,
  resolveProjectDir,
} from "../../src/project.js";
import { emitDiagnosticEvent } from "../../src/diagnostics.js";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

describe("resolveProjectDir", () => {
  it("expands ~ to home directory", () => {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    const result = resolveProjectDir("~/projects/my-project");
    expect(result).toBe(path.join(home, "projects/my-project"));
  });

  it("resolves absolute paths as-is", () => {
    const result = resolveProjectDir("/absolute/path/to/project");
    expect(result).toBe("/absolute/path/to/project");
  });

  it("resolves relative paths to absolute", () => {
    const result = resolveProjectDir("relative/path");
    expect(path.isAbsolute(result)).toBe(true);
  });
});

describe("parseProjectYaml via loadWorkforceConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-project-test-"));
    resetEnforcementConfigForTest();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetEnforcementConfigForTest();
  });

  function writeYaml(content: string): string {
    const p = path.join(tmpDir, "workforce.yaml");
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("parses valid YAML with agents", () => {
    const configPath = writeYaml(`
name: test-project
agents:
  worker1:
    extends: employee
    expectations:
      - tool: clawforce_log
        action: write
        min_calls: 1
    performance_policy:
      action: alert
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.name).toBe("test-project");
    expect(config!.agents.worker1).toBeDefined();
    expect(config!.agents.worker1!.extends).toBe("employee");
  });

  it("throws for missing agents section", () => {
    const configPath = writeYaml(`
name: test-project
`);
    expect(() => loadWorkforceConfig(configPath)).toThrow("Config must define an agents object.");
  });

  it("throws for empty YAML", () => {
    const configPath = writeYaml("");
    expect(() => loadWorkforceConfig(configPath)).toThrow("Config is empty or not an object.");
  });

  it("throws when an agent is missing extends", () => {
    const configPath = writeYaml(`
name: test
agents:
  orch:
    title: Lead
`);
    expect(() => loadWorkforceConfig(configPath)).toThrow('Agent "orch" is missing required field "extends".');
  });

  it("falls back to 'custom' for unknown context source and emits diagnostic warning", () => {
    const configPath = writeYaml(`
name: test
agents:
  src_agent:
    extends: employee
    briefing:
      - source: nonexistent_source
`);
    const config = loadWorkforceConfig(configPath);
    const briefing = config!.agents.src_agent!.briefing;
    // The custom source should be present in the briefing (plus instructions injected)
    const customSources = briefing.filter((s) => s.source === "custom");
    expect(customSources.length).toBeGreaterThan(0);

    expect(emitDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "config_warning",
        message: expect.stringContaining("nonexistent_source"),
      }),
    );
  });

  it("keeps budget_plan as a known context source", () => {
    const configPath = writeYaml(`
name: test
agents:
  worker:
    extends: employee
    briefing:
      - source: budget_plan
`);
    const config = loadWorkforceConfig(configPath);
    const sources = config!.agents.worker!.briefing.map((entry) => entry.source);
    expect(sources).toContain("budget_plan");
    expect(sources).not.toContain("custom");
  });
});

describe("registerWorkforceConfig + getAgentConfig", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-runtime-project-"));
    const { setProjectsDir } = await import("../../src/db.js");
    setProjectsDir(projectDir);
    resetEnforcementConfigForTest();
  });

  afterEach(async () => {
    const { closeAllDbs } = await import("../../src/db.js");
    const { resetManagerConfigForTest } = await import("../../src/manager-config.js");
    const { resetCustomTopicsForTest } = await import("../../src/skills/registry.js");
    const { resetPolicyRegistryForTest } = await import("../../src/policy/registry.js");
    closeAllDbs();
    try {
      fs.rmSync(projectDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    resetEnforcementConfigForTest();
    resetManagerConfigForTest();
    resetCustomTopicsForTest();
    resetPolicyRegistryForTest();
  });

  it("registers and retrieves agent config", () => {
    registerWorkforceConfig("proj1", {
      name: "test",
      agents: {
        worker1: {
          extends: "employee",
          briefing: [{ source: "instructions" }],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
        },
      },
    });

    const entry = getAgentConfig("worker1");
    expect(entry).not.toBeNull();
    expect(entry!.projectId).toBe("proj1");
    expect(entry!.config.extends).toBe("employee");
  });

  it("returns null for unregistered agent", () => {
    expect(getAgentConfig("nonexistent")).toBeNull();
  });

  it("keeps colliding agent IDs isolated by domain", () => {
    registerWorkforceConfig("proj1", {
      name: "one",
      agents: {
        lead: {
          extends: "manager",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    });

    registerWorkforceConfig("proj2", {
      name: "two",
      agents: {
        lead: {
          extends: "employee",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    });

    expect(getAgentConfig("proj1:lead")?.projectId).toBe("proj1");
    expect(getAgentConfig("proj1:lead")?.config.extends).toBe("manager");
    expect(getAgentConfig("proj2:lead")?.projectId).toBe("proj2");
    expect(getAgentConfig("proj2:lead")?.config.extends).toBe("employee");
    expect(getAgentConfig("lead")).toBeNull();
    expect(getRegisteredAgentIds("proj1")).toEqual(["lead"]);
    expect(getRegisteredAgentIds("proj2")).toEqual(["lead"]);
    expect(getRegisteredAgentIds()).toContain("proj1:lead");
    expect(getRegisteredAgentIds()).toContain("proj2:lead");
  });

  it("keeps legacy colon-delimited bare agent IDs project-scoped", () => {
    registerWorkforceConfig("proj1", {
      name: "one",
      agents: {
        "agent:verifier": {
          extends: "employee",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    });

    expect(getAgentConfig("agent:verifier")?.projectId).toBe("proj1");
    expect(getAgentConfig("agent:verifier", "proj1")?.projectId).toBe("proj1");
    expect(getAgentConfig("proj1:agent:verifier", "proj1")?.projectId).toBe("proj1");
    expect(getRegisteredAgentIds("proj1")).toEqual(["agent:verifier"]);
  });

  it("resolves runtimeRef aliases back to the governed ClawForce agent", () => {
    registerWorkforceConfig("proj1", {
      name: "one",
      agents: {
        lead: {
          extends: "manager",
          runtimeRef: "openclaw-lead",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    });

    expect(getAgentConfig("openclaw-lead")?.projectId).toBe("proj1");
    expect(getAgentConfig("openclaw-lead")?.agentId).toBe("lead");
    expect(getAgentConfig("openclaw-lead", "proj1")?.agentId).toBe("lead");
    expect(resolveOpenClawAgentId("lead", "proj1")).toBe("openclaw-lead");
  });

  it("replaces project-scoped runtime config on reload", async () => {
    const { getApprovalPolicy, getExtendedProjectConfig } = await import("../../src/project.js");
    const { getManagerForAgent } = await import("../../src/manager-config.js");
    const { getCustomTopics } = await import("../../src/skills/registry.js");
    const { getDb } = await import("../../src/db.js");

    fs.writeFileSync(path.join(projectDir, "review.md"), "# Review\n", "utf-8");

    registerWorkforceConfig("proj1", {
      name: "one",
      approval: { required: true, threshold: "always" },
      dispatch: { mode: "event-driven" },
      budgets: {
        project: { daily: { cents: 1000 } },
        agents: {
          lead: { daily: { cents: 250 } },
        },
      },
      skills: {
        review_playbook: {
          title: "Review Playbook",
          description: "Review workflow",
          path: "review.md",
        },
      },
      manager: {
        enabled: true,
        agentId: "lead",
        directives: [],
      },
      agents: {
        lead: {
          extends: "manager",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    }, projectDir);

    expect(getApprovalPolicy("proj1")).not.toBeNull();
    expect(getExtendedProjectConfig("proj1")?.dispatch?.mode).toBe("event-driven");
    expect(getManagerForAgent("lead")?.projectId).toBe("proj1");
    expect(getCustomTopics("proj1")).toHaveLength(1);

    registerWorkforceConfig("proj1", {
      name: "two",
      agents: {
        lead: {
          extends: "manager",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    }, projectDir);

    expect(getApprovalPolicy("proj1")).toBeNull();
    expect(getExtendedProjectConfig("proj1")).toMatchObject({
      projectDir,
      storageDir: undefined,
      dispatch: undefined,
    });
    expect(getManagerForAgent("lead")).toBeNull();
    expect(getCustomTopics("proj1")).toHaveLength(0);

    const budgetRows = getDb("proj1")
      .prepare("SELECT COUNT(*) AS count FROM budgets WHERE project_id = ?")
      .get("proj1") as { count: number };
    expect(budgetRows.count).toBe(0);
  });

  it("rolls back agent registration when activation fails", async () => {
    const dbModule = await import("../../src/db.js");
    const getDbSpy = vi.spyOn(dbModule, "getDb").mockImplementation(() => {
      throw new Error("sqlite unavailable");
    });

    expect(() =>
      activateWorkforceProject("broken-proj", {
        name: "broken",
        agents: {
          worker1: {
            extends: "employee",
            briefing: [],
            expectations: [],
            performance_policy: { action: "alert" },
          },
        },
      }),
    ).toThrow("sqlite unavailable");

    expect(getAgentConfig("worker1", "broken-proj")).toBeNull();
    expect(getRegisteredAgentIds("broken-proj")).toEqual([]);

    getDbSpy.mockRestore();
  });
});

describe("getRegisteredAgentIds", () => {
  beforeEach(() => {
    resetEnforcementConfigForTest();
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
  });

  it("returns empty when no agents registered", () => {
    expect(getRegisteredAgentIds()).toEqual([]);
  });

  it("returns single registered agent", () => {
    registerWorkforceConfig("proj1", {
      name: "test",
      agents: {
        worker1: {
          extends: "employee",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    });

    expect(getRegisteredAgentIds()).toEqual(["worker1"]);
  });

  it("returns multiple registered agents", () => {
    registerWorkforceConfig("proj1", {
      name: "test",
      agents: {
        manager1: {
          extends: "manager",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
        worker1: {
          extends: "employee",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
        cron1: {
          extends: "employee",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    });

    const ids = getRegisteredAgentIds();
    expect(ids).toHaveLength(3);
    expect(ids).toContain("manager1");
    expect(ids).toContain("worker1");
    expect(ids).toContain("cron1");
  });
});
