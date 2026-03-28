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

  // --- Briefing source validation ---

  it("warns on unknown agent briefing source", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  lead:
    extends: manager
    briefing:
      - source: assinged_task
      - source: instructions
domain:
  agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "UNKNOWN_BRIEFING_SOURCE" && i.message.includes("assinged_task"))).toBe(true);
  });

  it("does not warn on valid briefing sources", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  lead:
    extends: manager
    briefing:
      - source: assigned_task
      - source: instructions
      - source: task_board
domain:
  agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "UNKNOWN_BRIEFING_SOURCE")).toBe(false);
  });

  it("warns on unknown job briefing source", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  lead:
    extends: manager
    jobs:
      review:
        cron: "0 18 * * *"
        briefing:
          - source: teem_status
domain:
  agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "UNKNOWN_BRIEFING_SOURCE" && i.message.includes("teem_status"))).toBe(true);
  });

  // --- Expectation tool validation ---

  it("warns on unknown expectation tool", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  worker:
    extends: employee
    expectations:
      - tool: clawforce_logg
        action: write
        min_calls: 1
domain:
  agents: [worker]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "UNKNOWN_EXPECTATION_TOOL" && i.message.includes("clawforce_logg"))).toBe(true);
  });

  it("does not warn on valid expectation tools", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  worker:
    extends: employee
    expectations:
      - tool: clawforce_log
        action: write
        min_calls: 1
      - tool: memory_search
        action: search
        min_calls: 1
domain:
  agents: [worker]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "UNKNOWN_EXPECTATION_TOOL")).toBe(false);
  });

  // --- Job field validation ---

  it("warns on invalid job frequency format", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  lead:
    extends: manager
    jobs:
      sweep:
        frequency: "5 times daily"
domain:
  agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "INVALID_FREQUENCY" && i.message.includes("5 times daily"))).toBe(true);
  });

  it("does not warn on valid frequency formats", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  lead:
    extends: manager
    jobs:
      sweep:
        frequency: "3/day"
      check:
        frequency: "1/hour"
      weekly:
        frequency: "2/week"
domain:
  agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "INVALID_FREQUENCY")).toBe(false);
  });

  // --- Type coercion edge cases ---

  it("errors when skillCap is a string", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  lead:
    extends: manager
    skillCap: "10"
domain:
  agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "TYPE_COERCION" && i.message.includes("skillCap"))).toBe(true);
  });

  it("errors when contextBudgetChars is a string", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  lead:
    extends: manager
    contextBudgetChars: "30000"
domain:
  agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "TYPE_COERCION" && i.message.includes("contextBudgetChars"))).toBe(true);
  });

  it("warns on numeric agent IDs", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  123:
    extends: employee
domain:
  agents: ["123"]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "NUMERIC_AGENT_ID")).toBe(true);
  });

  it("errors when agents is an array instead of object", () => {
    writeYaml(`
version: "1"
project_id: test
agents:
  - extends: employee
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "TYPE_COERCION" && i.message.includes("agents") && i.message.includes("array"))).toBe(true);
  });
});
