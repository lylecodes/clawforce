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

  function writeGlobalYaml(content: string) {
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), content, "utf-8");
  }

  function writeDomainYaml(content: string, name = "test") {
    const domainsDir = path.join(tmpDir, "domains");
    fs.mkdirSync(domainsDir, { recursive: true });
    fs.writeFileSync(path.join(domainsDir, `${name}.yaml`), content, "utf-8");
  }

  it("returns error when config.yaml is missing", () => {
    const report = validateAllConfigs(tmpDir);
    expect(report.valid).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.code).toBe("FILE_NOT_FOUND");
  });

  it("detects YAML parse errors", () => {
    writeGlobalYaml("agents:\n  cf-lead:\n    extends: manager\n  bad indent\nstuff");
    const report = validateAllConfigs(tmpDir);
    expect(report.valid).toBe(false);
    expect(report.issues.some(i => i.code === "YAML_PARSE_ERROR")).toBe(true);
  });

  it("detects unknown top-level keys", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
mystery_key: true
`);
    writeDomainYaml(`
domain: test
agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "YAML_UNKNOWN_KEY" && i.message.includes("mystery_key"))).toBe(true);
  });

  it("detects unknown agent config keys", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
    bogus_field: true
`);
    writeDomainYaml(`
domain: test
agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "YAML_UNKNOWN_KEY" && i.message.includes("bogus_field"))).toBe(true);
  });

  it("detects domain agent not in global agents", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
`);
    writeDomainYaml(`
domain: test
agents: [lead, ghost]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.valid).toBe(false);
    expect(report.issues.some(i => i.code === "DOMAIN_AGENT_NOT_GLOBAL" && i.agentId === "ghost")).toBe(true);
  });

  it("detects orphan agents", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
  orphan:
    extends: employee
`);
    writeDomainYaml(`
domain: test
agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "ORPHAN_AGENT" && i.agentId === "orphan")).toBe(true);
  });

  it("detects expectation override conflict", () => {
    writeGlobalYaml(`
agents:
  worker:
    extends: employee
    expectations: []
`);
    writeDomainYaml(`
domain: test
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
    writeGlobalYaml(`
agents:
  lead:
    extends: nonexistent_preset
`);
    writeDomainYaml(`
domain: test
agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "UNKNOWN_PRESET")).toBe(true);
  });

  it("passes validation for valid config", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
    title: Lead
  worker:
    extends: employee
    title: Worker
`);
    writeDomainYaml(`
domain: test
agents: [lead, worker]
manager:
  agentId: lead
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.valid).toBe(true);
    expect(report.issues.filter(i => i.severity === "error")).toHaveLength(0);
  });

  it("validates domain entity lifecycle config", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
`);
    writeDomainYaml(`
domain: test
agents: [lead]
entities:
  jurisdiction:
    states:
      proposed:
        initial: true
      active: {}
    transitions:
      - from: proposed
        to: active
    health:
      values: [healthy, blocked]
      default: healthy
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "INVALID_ENTITY_CONFIG")).toBe(false);
    expect(report.valid).toBe(true);
  });

  it("allows entity state signals to target configured agents", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
`);
    writeDomainYaml(`
domain: test
agents: [lead]
entities:
  jurisdiction:
    runtimeCreate: true
    states:
      proposed:
        initial: true
      bootstrapping: {}
    transitions:
      - from: proposed
        to: bootstrapping
    health:
      values: [healthy, warning, blocked]
      default: warning
      clear: healthy
    issues:
      types:
        onboarding_request:
          defaultSeverity: medium
      stateSignals:
        - id: proposed-onboarding-request
          whenStates: [proposed]
          ownerPresence: missing
          issueType: onboarding_request
          ownerAgentId: lead
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.valid).toBe(true);
    expect(
      report.issues.some((i) =>
        i.code === "INVALID_ENTITY_CONFIG" && i.message.includes("ownerAgentId references unknown agent"),
      ),
    ).toBe(false);
  });

  it("detects invalid domain entity lifecycle config", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
`);
    writeDomainYaml(`
domain: test
agents: [lead]
entities:
  jurisdiction:
    states:
      proposed:
        initial: true
      active:
        initial: true
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.valid).toBe(false);
    expect(report.issues.some(i => i.code === "INVALID_ENTITY_CONFIG")).toBe(true);
  });

  it("validates domain skill topics against the project path", () => {
    const projectDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(path.join(projectDir, ".clawforce", "skills"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".clawforce", "skills", "runbook.md"),
      "# Runbook\n",
      "utf-8",
    );

    writeGlobalYaml(`
agents:
  lead:
    extends: manager
`);
    writeDomainYaml(`
domain: test
paths:
  - ${projectDir}
agents: [lead]
skills:
  runbook:
    title: Runbook
    description: "Operating instructions"
    path: .clawforce/skills/runbook.md
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.valid).toBe(true);
    expect(report.issues.some(i => i.code === "SKILL_FILE_NOT_FOUND")).toBe(false);
  });

  it("errors when domain skills are defined without a project path", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
`);
    writeDomainYaml(`
domain: test
agents: [lead]
skills:
  runbook:
    title: Runbook
    description: "Operating instructions"
    path: .clawforce/skills/runbook.md
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.valid).toBe(false);
    expect(report.issues.some(i => i.code === "DOMAIN_SKILLS_REQUIRE_PATHS")).toBe(true);
  });

  it("detects manager not in domain agents", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
  worker:
    extends: employee
`);
    writeDomainYaml(`
domain: test
agents: [worker]
manager:
  agentId: lead
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "MANAGER_NOT_IN_DOMAIN")).toBe(true);
  });

  it("ignores disabled manager routing when validating domain agents", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
  worker:
    extends: employee
`);
    writeDomainYaml(`
domain: test
agents: [worker]
manager:
  enabled: false
  agentId: lead
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "MANAGER_NOT_IN_DOMAIN")).toBe(false);
  });

  // --- Briefing source validation ---

  it("warns on unknown agent briefing source", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
    briefing:
      - source: assinged_task
      - source: instructions
`);
    writeDomainYaml(`
domain: test
agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "UNKNOWN_BRIEFING_SOURCE" && i.message.includes("assinged_task"))).toBe(true);
  });

  it("does not warn on valid briefing sources", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
    briefing:
      - source: assigned_task
      - source: instructions
      - source: task_board
`);
    writeDomainYaml(`
domain: test
agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "UNKNOWN_BRIEFING_SOURCE")).toBe(false);
  });

  it("warns on unknown job briefing source", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
    jobs:
      review:
        cron: "0 18 * * *"
        briefing:
          - source: teem_status
`);
    writeDomainYaml(`
domain: test
agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "UNKNOWN_BRIEFING_SOURCE" && i.message.includes("teem_status"))).toBe(true);
  });

  // --- Expectation tool validation ---

  it("warns on unknown expectation tool", () => {
    writeGlobalYaml(`
agents:
  worker:
    extends: employee
    expectations:
      - tool: clawforce_logg
        action: write
        min_calls: 1
`);
    writeDomainYaml(`
domain: test
agents: [worker]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "UNKNOWN_EXPECTATION_TOOL" && i.message.includes("clawforce_logg"))).toBe(true);
  });

  it("does not warn on valid expectation tools", () => {
    writeGlobalYaml(`
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
`);
    writeDomainYaml(`
domain: test
agents: [worker]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "UNKNOWN_EXPECTATION_TOOL")).toBe(false);
  });

  // --- Job field validation ---

  it("warns on invalid job frequency format", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
    jobs:
      sweep:
        frequency: "5 times daily"
`);
    writeDomainYaml(`
domain: test
agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "INVALID_FREQUENCY" && i.message.includes("5 times daily"))).toBe(true);
  });

  it("does not warn on valid frequency formats", () => {
    writeGlobalYaml(`
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
`);
    writeDomainYaml(`
domain: test
agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "INVALID_FREQUENCY")).toBe(false);
  });

  // --- Type coercion edge cases ---

  it("errors when skillCap is a string", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
    skillCap: "10"
`);
    writeDomainYaml(`
domain: test
agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "TYPE_COERCION" && i.message.includes("skillCap"))).toBe(true);
  });

  it("errors when contextBudgetChars is a string", () => {
    writeGlobalYaml(`
agents:
  lead:
    extends: manager
    contextBudgetChars: "30000"
`);
    writeDomainYaml(`
domain: test
agents: [lead]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "TYPE_COERCION" && i.message.includes("contextBudgetChars"))).toBe(true);
  });

  it("warns on numeric agent IDs", () => {
    writeGlobalYaml(`
agents:
  123:
    extends: employee
`);
    writeDomainYaml(`
domain: test
agents: ["123"]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "NUMERIC_AGENT_ID")).toBe(true);
  });

  it("errors when agents is an array instead of object", () => {
    writeGlobalYaml(`
agents:
  - extends: employee
`);
    writeDomainYaml(`
domain: test
agents: []
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "TYPE_COERCION" && i.message.includes("agents") && i.message.includes("array"))).toBe(true);
  });
});
