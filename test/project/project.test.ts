import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAgentConfig,
  getRegisteredAgentIds,
  loadWorkforceConfig,
  registerWorkforceConfig,
  resetEnforcementConfigForTest,
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
    const p = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("parses valid YAML with agents", () => {
    const configPath = writeYaml(`
name: test-project
agents:
  worker1:
    role: employee
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
    expect(config!.agents.worker1!.role).toBe("employee");
  });

  it("returns null for missing agents section", () => {
    const configPath = writeYaml(`
name: test-project
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).toBeNull();
  });

  it("returns null for invalid YAML that produces null", () => {
    const configPath = writeYaml("");
    const config = loadWorkforceConfig(configPath);
    expect(config).toBeNull();
  });

  it("normalizes role aliases", () => {
    const configPath = writeYaml(`
name: test
agents:
  orch:
    role: orchestrator
  w1:
    role: worker
  c1:
    role: cron
`);
    const config = loadWorkforceConfig(configPath);
    expect(config!.agents.orch!.role).toBe("manager");
    expect(config!.agents.w1!.role).toBe("employee");
    expect(config!.agents.c1!.role).toBe("scheduled");
  });

  it("falls back to 'employee' for unknown role and emits diagnostic warning", () => {
    vi.mocked(emitDiagnosticEvent).mockClear();

    const configPath = writeYaml(`
name: test
agents:
  bad_agent:
    role: imaginary_role
`);
    const config = loadWorkforceConfig(configPath);
    expect(config!.agents.bad_agent!.role).toBe("employee");

    // Verify diagnostic event was emitted
    expect(emitDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "config_warning",
        message: expect.stringContaining("imaginary_role"),
      }),
    );
  });

  it("falls back to 'custom' for unknown context source and emits diagnostic warning", () => {
    vi.mocked(emitDiagnosticEvent).mockClear();

    const configPath = writeYaml(`
name: test
agents:
  src_agent:
    role: employee
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
});

describe("registerWorkforceConfig + getAgentConfig", () => {
  beforeEach(() => {
    resetEnforcementConfigForTest();
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
  });

  it("registers and retrieves agent config", () => {
    registerWorkforceConfig("proj1", {
      name: "test",
      agents: {
        worker1: {
          role: "employee",
          briefing: [{ source: "instructions" }],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
        },
      },
    });

    const entry = getAgentConfig("worker1");
    expect(entry).not.toBeNull();
    expect(entry!.projectId).toBe("proj1");
    expect(entry!.config.role).toBe("employee");
  });

  it("returns null for unregistered agent", () => {
    expect(getAgentConfig("nonexistent")).toBeNull();
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
          role: "employee",
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
          role: "manager",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
        worker1: {
          role: "employee",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
        cron1: {
          role: "scheduled",
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
