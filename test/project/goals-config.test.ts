import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkforceConfig, resetEnforcementConfigForTest } from "../../src/project.js";

describe("goals config parsing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-goals-config-"));
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

  it("parses goals section from config", () => {
    const configPath = writeYaml(`
name: test-project
agents:
  manager:
    extends: manager
goals:
  ui-improvements:
    allocation: 40
    description: "Dashboard UX improvements"
    department: engineering
  outreach:
    allocation: 30
    description: "Customer outreach"
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).toBeDefined();
    expect(config!.goals).toBeDefined();
    expect(config!.goals!["ui-improvements"]).toEqual({
      allocation: 40,
      description: "Dashboard UX improvements",
      department: "engineering",
      team: undefined,
      acceptance_criteria: undefined,
      owner_agent_id: undefined,
    });
    expect(config!.goals!["outreach"]!.allocation).toBe(30);
  });

  it("validates allocations sum to <= 100", () => {
    const configPath = writeYaml(`
name: test-project
agents:
  manager:
    extends: manager
goals:
  a:
    allocation: 60
  b:
    allocation: 50
`);
    expect(() => loadWorkforceConfig(configPath)).toThrow(/exceed 100/);
  });

  it("works without goals section", () => {
    const configPath = writeYaml(`
name: test-project
agents:
  manager:
    extends: manager
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).toBeDefined();
    expect(config!.goals).toBeUndefined();
  });

  it("allows goals without allocation", () => {
    const configPath = writeYaml(`
name: test-project
agents:
  manager:
    extends: manager
goals:
  ad-hoc-work:
    description: "Miscellaneous tasks"
`);
    const config = loadWorkforceConfig(configPath);
    expect(config!.goals).toBeDefined();
    expect(config!.goals!["ad-hoc-work"]!.allocation).toBeUndefined();
  });
});
