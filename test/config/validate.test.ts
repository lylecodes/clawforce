import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { validateAllConfigs } = await import("../../src/config/validate.js");

describe("config/validate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-validate-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(content: string) {
    fs.writeFileSync(path.join(tmpDir, "project.yaml"), content, "utf-8");
  }

  it("returns error when project.yaml is missing", () => {
    const report = validateAllConfigs(tmpDir);
    expect(report.valid).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.code).toBe("FILE_NOT_FOUND");
  });

  it("detects YAML parse errors", () => {
    writeYaml("agents:\n  cf-lead:\n    extends: manager\n  bad indent\nstuff");
    const report = validateAllConfigs(tmpDir);
    expect(report.valid).toBe(false);
    expect(report.issues.some(i => i.code === "YAML_PARSE_ERROR")).toBe(true);
  });

  it("detects unknown top-level keys", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  lead:
    extends: manager
mystery_key: true
domain:
  agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "YAML_UNKNOWN_KEY" && i.message.includes("mystery_key"))).toBe(true);
  });

  it("detects unknown agent config keys", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  lead:
    extends: manager
    bogus_field: true
domain:
  agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "YAML_UNKNOWN_KEY" && i.message.includes("bogus_field"))).toBe(true);
  });

  it("detects domain agent not in global agents", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  lead:
    extends: manager
domain:
  agents: [lead, ghost]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.valid).toBe(false);
    expect(report.issues.some(i => i.code === "DOMAIN_AGENT_NOT_GLOBAL" && i.agentId === "ghost")).toBe(true);
  });

  it("detects orphan agents", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  lead:
    extends: manager
  orphan:
    extends: employee
domain:
  agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "ORPHAN_AGENT" && i.agentId === "orphan")).toBe(true);
  });

  it("detects expectation override conflict", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  worker:
    extends: employee
    expectations: []
domain:
  agents: [worker]
  defaults:
    expectations:
      - tool: clawforce_log
        action: write
        min: 1
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "EXPECTATION_OVERRIDE_CONFLICT")).toBe(true);
  });

  it("detects unknown preset", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  lead:
    extends: nonexistent_preset
domain:
  agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "UNKNOWN_PRESET")).toBe(true);
  });

  it("passes validation for valid config", () => {
    writeYaml(`
version: "1"
project_id: test
name: Test Project
agents:
  lead:
    extends: manager
    title: Lead
  worker:
    extends: employee
    title: Worker
domain:
  agents: [lead, worker]
  manager: lead
  worker_agents: [worker]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.valid).toBe(true);
    expect(report.issues.filter(i => i.severity === "error")).toHaveLength(0);
  });

  it("detects manager not in domain agents", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  lead:
    extends: manager
  worker:
    extends: employee
domain:
  agents: [worker]
  manager: lead
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "ORCHESTRATOR_NOT_IN_DOMAIN")).toBe(true);
  });
});
