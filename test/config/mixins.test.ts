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

describe("mixin system", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-mixin-"));
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

  it("applies a single mixin to an agent", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "mixins:",
      "  reviewer:",
      "    expectations:",
      "      - tool: clawforce_verify",
      "        action: verdict",
      "        min_calls: 1",
      "agents:",
      "  code-reviewer:",
      "    extends: employee",
      "    mixins: [reviewer]",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - code-reviewer",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("code-reviewer");
    expect(entry).not.toBeNull();
    // Mixin should override the employee preset's empty expectations
    expect(entry!.config.expectations).toHaveLength(1);
    expect(entry!.config.expectations[0]).toMatchObject({ tool: "clawforce_verify" });
  });

  it("applies multiple mixins left-to-right", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "mixins:",
      "  reviewer:",
      "    skillCap: 10",
      "  compactor:",
      "    compaction: true",
      "    skillCap: 15",
      "agents:",
      "  bot:",
      "    extends: employee",
      "    mixins: [reviewer, compactor]",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - bot",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("bot");
    expect(entry).not.toBeNull();
    // compactor mixin comes after reviewer, so skillCap=15 wins
    expect(entry!.config.skillCap).toBe(15);
    // compaction from compactor mixin should be applied
    expect(entry!.config.compaction).toBe(true);
  });

  it("agent overrides take precedence over mixins", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "mixins:",
      "  reviewer:",
      "    skillCap: 10",
      "    title: Reviewer",
      "agents:",
      "  bot:",
      "    extends: employee",
      "    mixins: [reviewer]",
      "    title: Custom Bot",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - bot",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("bot");
    expect(entry).not.toBeNull();
    // Agent's own title should win over mixin
    expect(entry!.config.title).toBe("Custom Bot");
    // But mixin's skillCap should apply (agent didn't override it)
    expect(entry!.config.skillCap).toBe(10);
  });

  it("ignores unknown mixin references gracefully", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "mixins:",
      "  reviewer:",
      "    skillCap: 10",
      "agents:",
      "  bot:",
      "    extends: employee",
      "    mixins: [reviewer, nonexistent]",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - bot",
    ].join("\n"));

    // Should still work (validation catches missing refs separately)
    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("bot");
    expect(entry).not.toBeNull();
    expect(entry!.config.skillCap).toBe(10);
  });

  it("works when agent has no mixins", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "mixins:",
      "  reviewer:",
      "    skillCap: 10",
      "agents:",
      "  bot:",
      "    extends: employee",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - bot",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("bot");
    expect(entry).not.toBeNull();
    // Employee default skillCap
    expect(entry!.config.skillCap).toBe(8);
  });
});

describe("applyMixins unit tests", () => {
  it("returns resolved unchanged when no mixins", async () => {
    const { applyMixins } = await import("../../src/config/init.js");

    const resolved = { title: "Worker", skillCap: 8 };
    const agentDef = { extends: "employee" };
    const result = applyMixins(resolved, agentDef, undefined);
    expect(result).toEqual(resolved);
  });

  it("returns resolved unchanged when agent has empty mixins array", async () => {
    const { applyMixins } = await import("../../src/config/init.js");

    const resolved = { title: "Worker", skillCap: 8 };
    const agentDef = { extends: "employee", mixins: [] };
    const result = applyMixins(resolved, agentDef, { reviewer: { skillCap: 10 } });
    expect(result).toEqual(resolved);
  });

  it("deep merges mixin objects", async () => {
    const { applyMixins } = await import("../../src/config/init.js");

    const resolved = {
      title: "Worker",
      performance_policy: { action: "retry", max_retries: 3 },
    };
    const agentDef = { extends: "employee", mixins: ["strict"] };
    const mixinDefs = {
      strict: {
        performance_policy: { action: "retry" as const, max_retries: 1, then: "alert" },
      },
    };
    const result = applyMixins(resolved, agentDef, mixinDefs);
    expect((result.performance_policy as Record<string, unknown>).max_retries).toBe(1);
    expect((result.performance_policy as Record<string, unknown>).then).toBe("alert");
  });
});

describe("mixin validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-mixin-validate-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(content: string) {
    fs.writeFileSync(path.join(tmpDir, "project.yaml"), content, "utf-8");
  }

  it("reports error for unknown mixin reference", async () => {
    const { validateAllConfigs } = await import("../../src/config/validate.js");
    writeYaml(`
version: "1"
project_id: test
agents:
  bot:
    extends: employee
    mixins: [nonexistent]
domain:
  agents: [bot]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "UNKNOWN_MIXIN" && i.message.includes("nonexistent"))).toBe(true);
  });

  it("passes when mixin is defined", async () => {
    const { validateAllConfigs } = await import("../../src/config/validate.js");
    writeYaml(`
version: "1"
project_id: test
mixins:
  reviewer:
    skillCap: 10
agents:
  bot:
    extends: employee
    mixins: [reviewer]
domain:
  agents: [bot]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.filter(i => i.code === "UNKNOWN_MIXIN")).toHaveLength(0);
  });

  it("reports error for invalid mixins section", async () => {
    const { validateAllConfigs } = await import("../../src/config/validate.js");
    writeYaml(`
version: "1"
project_id: test
mixins: "not-an-object"
agents:
  bot:
    extends: employee
domain:
  agents: [bot]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i => i.code === "INVALID_MIXINS")).toBe(true);
  });
});
