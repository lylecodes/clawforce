import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

describe("job triggers parsing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-triggers-"));
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
  });

  afterEach(async () => {
    const { clearRegistry } = await import("../../src/config/registry.js");
    const { resetEnforcementConfigForTest } = await import("../../src/project.js");
    clearRegistry();
    resetEnforcementConfigForTest();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("parses triggers on a job definition", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  mgr:",
      "    extends: manager",
      "    jobs:",
      "      coordination:",
      "        cron: '*/30 * * * *'",
      "        triggers:",
      "          - on: task_failed",
      "          - on: dispatch_failed",
      "            conditions:",
      "              severity: critical",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - mgr",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("mgr");
    expect(entry).not.toBeNull();
    expect(entry!.config.jobs).toBeDefined();
    const coordination = entry!.config.jobs!.coordination;
    expect(coordination.triggers).toHaveLength(2);
    expect(coordination.triggers![0]).toEqual({ on: "task_failed" });
    expect(coordination.triggers![1]).toEqual({
      on: "dispatch_failed",
      conditions: { severity: "critical" },
    });
  });

  it("parses triggers without cron (event-only job)", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  mgr:",
      "    extends: manager",
      "    jobs:",
      "      incident_response:",
      "        triggers:",
      "          - on: task_failed",
      "        nudge: Handle the failed task",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - mgr",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("mgr");
    expect(entry).not.toBeNull();
    const job = entry!.config.jobs!.incident_response;
    expect(job.cron).toBeUndefined();
    expect(job.triggers).toHaveLength(1);
    expect(job.triggers![0].on).toBe("task_failed");
    expect(job.nudge).toBe("Handle the failed task");
  });

  it("skips invalid trigger entries", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  mgr:",
      "    extends: manager",
      "    jobs:",
      "      coordination:",
      "        cron: '*/30 * * * *'",
      "        triggers:",
      "          - on: task_failed",
      "          - not_a_trigger",
      "          - on: ''",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - mgr",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("mgr");
    expect(entry).not.toBeNull();
    // Only the valid trigger should be parsed
    expect(entry!.config.jobs!.coordination.triggers).toHaveLength(1);
    expect(entry!.config.jobs!.coordination.triggers![0].on).toBe("task_failed");
  });

  it("preserves job without triggers", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  mgr:",
      "    extends: manager",
      "    jobs:",
      "      coordination:",
      "        cron: '*/30 * * * *'",
      "        nudge: Check team status",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - mgr",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("mgr");
    expect(entry).not.toBeNull();
    expect(entry!.config.jobs!.coordination.triggers).toBeUndefined();
    expect(entry!.config.jobs!.coordination.cron).toBe("*/30 * * * *");
  });
});

describe("job trigger validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-trigger-validate-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(content: string) {
    fs.writeFileSync(path.join(tmpDir, "project.yaml"), content, "utf-8");
  }

  it("reports error for non-array triggers", async () => {
    const { validateAllConfigs } = await import("../../src/config/validate.js");
    writeYaml(`
version: "1"
project_id: test
agents:
  mgr:
    extends: manager
    jobs:
      coordination:
        cron: "*/30 * * * *"
        triggers: "not-an-array"
domain:
  agents: [mgr]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "INVALID_TRIGGERS")).toBe(true);
  });

  it("reports error for trigger missing on field", async () => {
    const { validateAllConfigs } = await import("../../src/config/validate.js");
    writeYaml(`
version: "1"
project_id: test
agents:
  mgr:
    extends: manager
    jobs:
      coordination:
        cron: "*/30 * * * *"
        triggers:
          - conditions: { severity: critical }
domain:
  agents: [mgr]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "MISSING_TRIGGER_EVENT")).toBe(true);
  });

  it("warns for unknown trigger event type", async () => {
    const { validateAllConfigs } = await import("../../src/config/validate.js");
    writeYaml(`
version: "1"
project_id: test
agents:
  mgr:
    extends: manager
    jobs:
      coordination:
        cron: "*/30 * * * *"
        triggers:
          - on: made_up_event
domain:
  agents: [mgr]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "UNKNOWN_TRIGGER_EVENT" && i.message.includes("made_up_event"))).toBe(true);
  });

  it("passes for valid trigger event types", async () => {
    const { validateAllConfigs } = await import("../../src/config/validate.js");
    writeYaml(`
version: "1"
project_id: test
agents:
  mgr:
    extends: manager
    jobs:
      coordination:
        cron: "*/30 * * * *"
        triggers:
          - on: task_failed
          - on: dispatch_failed
domain:
  agents: [mgr]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.filter(i => i.code === "INVALID_TRIGGERS" || i.code === "MISSING_TRIGGER_EVENT" || i.code === "UNKNOWN_TRIGGER_EVENT")).toHaveLength(0);
  });

  it("validates trigger with non-object entry", async () => {
    const { validateAllConfigs } = await import("../../src/config/validate.js");
    writeYaml(`
version: "1"
project_id: test
agents:
  mgr:
    extends: manager
    jobs:
      coordination:
        cron: "*/30 * * * *"
        triggers:
          - "just a string"
domain:
  agents: [mgr]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "INVALID_TRIGGER")).toBe(true);
  });
});
