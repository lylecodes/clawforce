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

// We test scanAndRegisterProjects by importing from index.ts indirectly.
// Instead, test the underlying functions directly.
const { loadWorkforceConfig, loadProject, registerWorkforceConfig, getAgentConfig, resetEnforcementConfigForTest } =
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

  function writeProjectYaml(projectName: string, yaml: string): string {
    const dir = path.join(tmpDir, projectName);
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "project.yaml");
    fs.writeFileSync(configPath, yaml);
    return configPath;
  }

  it("loads enforcement config from a project.yaml", () => {
    const configPath = writeProjectYaml("test-project", `
id: test-project
name: Test Project
dir: .
agents:
  coder:
    role: worker
    context_in:
      - source: instructions
    required_outputs:
      - tool: clawforce_task
        action: [transition, fail]
        min_calls: 1
    on_failure:
      action: retry
      max_retries: 3
      then: alert
  leon:
    role: orchestrator
    context_in:
      - source: instructions
      - source: task_board
    required_outputs:
      - tool: clawforce_task
        action: propose
        min_calls: 1
    on_failure:
      action: alert
`);

    const enfConfig = loadWorkforceConfig(configPath);
    expect(enfConfig).not.toBeNull();
    expect(enfConfig!.name).toBe("Test Project");
    expect(Object.keys(enfConfig!.agents)).toEqual(["coder", "leon"]);
    expect(enfConfig!.agents.coder!.extends).toBe("employee");
    expect(enfConfig!.agents.leon!.extends).toBe("manager");
  });

  it("validates enforcement config and warns on issues", () => {
    const configPath = writeProjectYaml("warn-project", `
id: warn-project
name: Warn Project
dir: .
agents:
  coder:
    role: worker
    context_in:
      - source: instructions
    required_outputs: []
    on_failure:
      action: retry
`);

    const enfConfig = loadWorkforceConfig(configPath)!;
    const warnings = validateWorkforceConfig(enfConfig);
    expect(warnings.length).toBeGreaterThan(0);
    // Should warn about no expectations
    expect(warnings.some((w) => w.message.includes("expectations"))).toBe(true);
    // Should warn about retry without max_retries
    expect(warnings.some((w) => w.message.includes("max_retries"))).toBe(true);
  });

  it("registers enforcement config and makes agents queryable", () => {
    const configPath = writeProjectYaml("reg-project", `
id: reg-project
name: Reg Project
dir: .
agents:
  my-agent:
    role: worker
    context_in:
      - source: instructions
    required_outputs:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    on_failure:
      action: alert
`);

    const enfConfig = loadWorkforceConfig(configPath)!;
    registerWorkforceConfig("reg-project", enfConfig, tmpDir);

    const entry = getAgentConfig("my-agent");
    expect(entry).not.toBeNull();
    expect(entry!.projectId).toBe("reg-project");
    expect(entry!.config.extends).toBe("employee");
    expect(entry!.projectDir).toBe(tmpDir);
  });

  it("returns null for project.yaml without enforcement agents", () => {
    const configPath = writeProjectYaml("legacy-project", `
id: legacy-project
name: Legacy Project
dir: .
agents:
  project: my-project
  workers:
    - type: claude-code
`);

    const enfConfig = loadWorkforceConfig(configPath);
    expect(enfConfig).toBeNull();
  });

  it("loads project config for DB init", () => {
    const configPath = writeProjectYaml("db-project", `
id: db-project
name: DB Project
dir: ${tmpDir}
agents:
  project: db-project
  workers:
    - type: claude-code
defaults:
  maxRetries: 5
  priority: P1
`);

    const config = loadProject(configPath);
    expect(config.id).toBe("db-project");
    expect(config.name).toBe("DB Project");
    expect(config.defaults.maxRetries).toBe(5);
    expect(config.defaults.priority).toBe("P1");
  });

  it("handles reports_to in enforcement config", () => {
    const configPath = writeProjectYaml("escalation-project", `
id: escalation-project
name: Escalation Project
dir: .
agents:
  coder:
    role: worker
    reports_to: leon
    context_in:
      - source: instructions
    required_outputs:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    on_failure:
      action: retry
      max_retries: 2
      then: alert
  leon:
    role: orchestrator
    context_in:
      - source: instructions
    required_outputs:
      - tool: clawforce_task
        action: propose
        min_calls: 1
    on_failure:
      action: alert
`);

    const enfConfig = loadWorkforceConfig(configPath)!;
    expect(enfConfig.agents.coder!.reports_to).toBe("leon");
    expect(enfConfig.agents.leon!.reports_to).toBeUndefined();

    const warnings = validateWorkforceConfig(enfConfig);
    // Should NOT warn since leon exists as a peer agent
    expect(warnings.some((w) => w.message.includes("reports_to"))).toBe(false);
  });
});
