import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

// Test the workforce config parsing functions directly.
const { loadWorkforceConfig, registerWorkforceConfig, getAgentConfig, resetEnforcementConfigForTest } =
  await import("../../src/project.js");
const { validateWorkforceConfig } = await import("../../src/config-validator.js");

describe("project scanning", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-scan-"));
    resetEnforcementConfigForTest();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetEnforcementConfigForTest();
  });

  function writeWorkforceYaml(projectName: string, yaml: string): string {
    const dir = path.join(tmpDir, projectName);
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "workforce.yaml");
    fs.writeFileSync(configPath, yaml);
    return configPath;
  }

  it("loads workforce config from YAML", () => {
    const configPath = writeWorkforceYaml("test-project", `
name: Test Project
agents:
  coder:
    extends: employee
    briefing:
      - source: instructions
    expectations:
      - tool: clawforce_task
        action: [transition, fail]
        min_calls: 1
    performance_policy:
      action: retry
      max_retries: 3
      then: alert
  leon:
    extends: manager
    briefing:
      - source: instructions
      - source: task_board
    expectations:
      - tool: clawforce_task
        action: propose
        min_calls: 1
    performance_policy:
      action: alert
`);

    const enfConfig = loadWorkforceConfig(configPath);
    expect(enfConfig.name).toBe("Test Project");
    expect(Object.keys(enfConfig.agents)).toEqual(["coder", "leon"]);
    expect(enfConfig.agents.coder!.extends).toBe("employee");
    expect(enfConfig.agents.leon!.extends).toBe("manager");
  });

  it("validates workforce config and warns on issues", () => {
    const configPath = writeWorkforceYaml("warn-project", `
name: Warn Project
agents:
  coder:
    extends: employee
    briefing:
      - source: instructions
    expectations: []
    performance_policy:
      action: retry
`);

    const enfConfig = loadWorkforceConfig(configPath);
    const warnings = validateWorkforceConfig(enfConfig);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.message.includes("expectations"))).toBe(true);
    expect(warnings.some((w) => w.message.includes("max_retries"))).toBe(true);
  });

  it("registers workforce config and makes agents queryable", () => {
    const configPath = writeWorkforceYaml("reg-project", `
name: Reg Project
agents:
  my-agent:
    extends: employee
    briefing:
      - source: instructions
    expectations:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    performance_policy:
      action: alert
`);

    const enfConfig = loadWorkforceConfig(configPath);
    registerWorkforceConfig("reg-project", enfConfig, tmpDir);

    const entry = getAgentConfig("my-agent");
    expect(entry).not.toBeNull();
    expect(entry!.projectId).toBe("reg-project");
    expect(entry!.config.extends).toBe("employee");
    expect(entry!.projectDir).toBe(tmpDir);
  });

  it("throws when the config omits canonical workforce agents", () => {
    const configPath = writeWorkforceYaml("invalid-project", `
name: Invalid Project
agents:
  project: my-project
  workers:
    - type: claude-code
`);

    expect(() => loadWorkforceConfig(configPath)).toThrow();
  });

  it("handles reports_to in workforce config", () => {
    const configPath = writeWorkforceYaml("escalation-project", `
name: Escalation Project
agents:
  coder:
    extends: employee
    reports_to: leon
    briefing:
      - source: instructions
    expectations:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    performance_policy:
      action: retry
      max_retries: 2
      then: alert
  leon:
    extends: manager
    briefing:
      - source: instructions
    expectations:
      - tool: clawforce_task
        action: propose
        min_calls: 1
    performance_policy:
      action: alert
`);

    const enfConfig = loadWorkforceConfig(configPath);
    expect(enfConfig.agents.coder!.reports_to).toBe("leon");
    expect(enfConfig.agents.leon!.reports_to).toBeUndefined();

    const warnings = validateWorkforceConfig(enfConfig);
    expect(warnings.some((w) => w.message.includes("reports_to"))).toBe(false);
  });
});
