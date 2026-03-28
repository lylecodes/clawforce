/**
 * CO-1/CO-2/CO-3: Config parsing tests for cost optimization fields
 *
 * Validates that normalizeAgentConfig correctly parses:
 * - bootstrap_config / bootstrapConfig (CO-1)
 * - bootstrap_exclude_files / bootstrapExcludeFiles (CO-2)
 * - allowed_tools / allowedTools (CO-3)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadWorkforceConfig,
  resetEnforcementConfigForTest,
} from "../../src/project.js";

describe("cost optimization config parsing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-cost-test-"));
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

  it("CO-1: parses bootstrap_config from YAML (snake_case)", () => {
    const configPath = writeYaml("project.yaml", `
name: test-project
agents:
  worker1:
    extends: employee
    bootstrap_config:
      max_chars: 5000
      total_max_chars: 25000
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker1!;
    expect(agent.bootstrapConfig).toBeDefined();
    expect(agent.bootstrapConfig!.maxChars).toBe(5000);
    expect(agent.bootstrapConfig!.totalMaxChars).toBe(25000);
  });

  it("CO-1: parses bootstrapConfig from YAML (camelCase)", () => {
    const configPath = writeYaml("project.yaml", `
name: test-project
agents:
  worker1:
    extends: employee
    bootstrapConfig:
      maxChars: 6000
      totalMaxChars: 28000
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker1!;
    expect(agent.bootstrapConfig).toBeDefined();
    expect(agent.bootstrapConfig!.maxChars).toBe(6000);
    expect(agent.bootstrapConfig!.totalMaxChars).toBe(28000);
  });

  it("CO-1: inherits bootstrap defaults from employee preset when not specified", () => {
    const configPath = writeYaml("project.yaml", `
name: test-project
agents:
  worker1:
    extends: employee
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker1!;
    // Should inherit from employee preset defaults
    expect(agent.bootstrapConfig).toBeDefined();
    expect(agent.bootstrapConfig!.maxChars).toBe(8000);
    expect(agent.bootstrapConfig!.totalMaxChars).toBe(30000);
  });

  it("CO-1: explicit config overrides preset defaults", () => {
    const configPath = writeYaml("project.yaml", `
name: test-project
agents:
  worker1:
    extends: employee
    bootstrap_config:
      max_chars: 10000
      total_max_chars: 40000
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker1!;
    expect(agent.bootstrapConfig!.maxChars).toBe(10000);
    expect(agent.bootstrapConfig!.totalMaxChars).toBe(40000);
  });

  it("CO-1: parses bootstrapDefaults at project level", () => {
    const configPath = writeYaml("project.yaml", `
name: test-project
bootstrap_defaults:
  max_chars: 7000
  total_max_chars: 20000
agents:
  worker1:
    extends: employee
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.bootstrapDefaults).toBeDefined();
    expect(config!.bootstrapDefaults!.maxChars).toBe(7000);
    expect(config!.bootstrapDefaults!.totalMaxChars).toBe(20000);
  });

  it("CO-2: parses bootstrap_exclude_files from YAML", () => {
    const configPath = writeYaml("project.yaml", `
name: test-project
agents:
  worker1:
    extends: employee
    bootstrap_exclude_files:
      - AGENTS.md
      - HEARTBEAT.md
      - IDENTITY.md
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker1!;
    expect(agent.bootstrapExcludeFiles).toEqual(["AGENTS.md", "HEARTBEAT.md", "IDENTITY.md"]);
  });

  it("CO-2: inherits bootstrapExcludeFiles from employee preset", () => {
    const configPath = writeYaml("project.yaml", `
name: test-project
agents:
  worker1:
    extends: employee
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker1!;
    expect(agent.bootstrapExcludeFiles).toBeDefined();
    expect(agent.bootstrapExcludeFiles).toContain("AGENTS.md");
    expect(agent.bootstrapExcludeFiles).toContain("HEARTBEAT.md");
  });

  it("CO-3: parses allowed_tools from YAML", () => {
    const configPath = writeYaml("project.yaml", `
name: test-project
agents:
  worker1:
    extends: employee
    allowed_tools:
      - Bash
      - Read
      - Edit
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker1!;
    expect(agent.allowedTools).toEqual(["Bash", "Read", "Edit"]);
  });

  it("CO-3: inherits allowedTools from employee preset", () => {
    const configPath = writeYaml("project.yaml", `
name: test-project
agents:
  worker1:
    extends: employee
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker1!;
    expect(agent.allowedTools).toBeDefined();
    expect(agent.allowedTools).toContain("Bash");
    expect(agent.allowedTools).toContain("Read");
    expect(agent.allowedTools).toContain("Edit");
    expect(agent.allowedTools).toContain("Write");
    expect(agent.allowedTools).toContain("WebSearch");
  });

  it("CO-3: verifier inherits read-only tools", () => {
    const configPath = writeYaml("project.yaml", `
name: test-project
agents:
  verifier1:
    extends: verifier
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.verifier1!;
    expect(agent.allowedTools).toBeDefined();
    expect(agent.allowedTools).toContain("Bash");
    expect(agent.allowedTools).toContain("Read");
    expect(agent.allowedTools).toContain("WebSearch");
    expect(agent.allowedTools).not.toContain("Edit");
    expect(agent.allowedTools).not.toContain("Write");
  });

  it("CO-3: explicit tools override preset defaults", () => {
    const configPath = writeYaml("project.yaml", `
name: test-project
agents:
  worker1:
    extends: employee
    allowed_tools:
      - Bash
      - Read
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker1!;
    expect(agent.allowedTools).toEqual(["Bash", "Read"]);
  });

  it("CO-3: manager has no allowedTools restriction", () => {
    const configPath = writeYaml("project.yaml", `
name: test-project
agents:
  lead:
    extends: manager
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.lead!;
    expect(agent.allowedTools).toBeUndefined();
  });
});
