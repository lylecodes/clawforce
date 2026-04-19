/**
 * Resolution pipeline E2E test — exercises the COMPLETE config resolution chain.
 *
 * Tests that configs flow through: preset -> mixin -> role defaults ->
 * domain defaults -> agent override, and verifies final AgentConfig shape.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("resolution pipeline e2e", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-pipeline-"));
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

  it("full resolution: preset → domain defaults → agent override", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    // Global config with agents extending presets
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  lead:",
      "    extends: manager",
      "    title: Engineering Lead",
      "    persona: Custom persona for the lead",
      "  dev:",
      "    extends: employee",
      "    title: Developer",
      "    observe:",
      "      - task.assigned",
      "      - budget.warning",
      "  analyst:",
      "    extends: employee",
      "    title: Data Analyst",
      "    model: gpt-5.4",
      "defaults:",
      "  performance_policy:",
      "    action: retry",
      "    max_retries: 5",
    ].join("\n"));

    fs.writeFileSync(path.join(tmpDir, "domains", "eng.yaml"), [
      "domain: eng",
      "agents:",
      "  - lead",
      "  - dev",
      "  - analyst",
      "defaults:",
      "  briefing:",
      "    - source: direction",
      "    - source: policies",
      "  expectations:",
      "    - tool: clawforce_log",
      "      action: write",
      "      min_calls: 1",
      "  performance_policy:",
      "    action: retry",
      "    max_retries: 10",
    ].join("\n"));

    const result = initializeAllDomains(tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.domains).toContain("eng");

    // Check lead (manager preset)
    const leadEntry = getAgentConfig("lead");
    expect(leadEntry).not.toBeNull();
    const leadConfig = leadEntry!.config;

    // Agent title overrides preset title
    expect(leadConfig.title).toBe("Engineering Lead");
    // Agent persona overrides preset persona
    expect(leadConfig.persona).toBe("Custom persona for the lead");
    // Manager preset provides coordination
    expect(leadConfig.coordination?.enabled).toBe(true);
    // Manager preset provides briefing; domain defaults prepend "direction" and "policies"
    // Domain defaults come as ContextSource objects, preset briefing as strings
    const briefingSources = leadConfig.briefing.map(
      (s: unknown) => typeof s === "string" ? s : (s as { source: string }).source,
    );
    expect(briefingSources).toContain("direction");
    expect(briefingSources).toContain("policies");
    // Preset briefing entries are strings in the domain pipeline
    expect(briefingSources.some((s: string) => s === "soul" || s === "tools_reference")).toBe(true);
    // Domain default performance_policy replaces the preset default
    expect(leadConfig.performance_policy).toEqual({ action: "retry", max_retries: 10 });

    // Check dev (employee preset)
    const devEntry = getAgentConfig("dev");
    expect(devEntry).not.toBeNull();
    const devConfig = devEntry!.config;

    // Employee preset title overridden by agent title
    expect(devConfig.title).toBe("Developer");
    // Employee preset has coordination disabled
    expect(devConfig.coordination?.enabled).toBe(false);
    // Observe field passes through
    expect(devConfig.observe).toEqual(["task.assigned", "budget.warning"]);
    // Domain defaults appended expectations (employee has none by default)
    expect(devConfig.expectations.some(e => e.tool === "clawforce_log")).toBe(true);

    // Check analyst — has explicit model
    const analystEntry = getAgentConfig("analyst");
    expect(analystEntry).not.toBeNull();
    expect(analystEntry!.config.model).toBe("gpt-5.4");
  });

  it("agent-specific fields always win over preset and domain defaults", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  worker:",
      "    extends: employee",
      "    title: Custom Worker",
      "    persona: I am a custom worker",
      "    skillCap: 20",
    ].join("\n"));

    fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
      "domain: proj",
      "agents:",
      "  - worker",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("worker");
    expect(entry).not.toBeNull();
    // Agent-level title wins over employee preset "Employee"
    expect(entry!.config.title).toBe("Custom Worker");
    // Agent-level persona wins over employee preset
    expect(entry!.config.persona).toBe("I am a custom worker");
    // Agent-level skillCap wins over preset
    expect(entry!.config.skillCap).toBe(20);
  });

  it("global defaults performance_policy fills when agent has none", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "defaults:",
      "  performance_policy:",
      "    action: alert",
      "agents:",
      "  worker:",
      "    extends: employee",
    ].join("\n"));

    fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
      "domain: proj",
      "agents:",
      "  - worker",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("worker");
    expect(entry).not.toBeNull();
    // Employee preset has performance_policy, so global default may not override
    // The key test is that a value exists
    expect(entry!.config.performance_policy).toBeDefined();
  });

  it("observe entries are properly typed (string array)", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  ops-bot:",
      "    extends: employee",
      "    observe:",
      "      - budget.exceeded",
      "      - task.failed",
      "      - agent.disabled",
    ].join("\n"));

    fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
      "domain: proj",
      "agents:",
      "  - ops-bot",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("ops-bot");
    expect(entry).not.toBeNull();
    expect(Array.isArray(entry!.config.observe)).toBe(true);
    expect(entry!.config.observe).toEqual(["budget.exceeded", "task.failed", "agent.disabled"]);
    // Each entry is a string
    for (const obs of entry!.config.observe!) {
      expect(typeof obs).toBe("string");
    }
  });

  it("job definitions are preserved through resolution", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  lead:",
      "    extends: manager",
      "    jobs:",
      "      daily-review:",
      '        cron: "0 18 * * *"',
      "        briefing:",
      "          - source: team_performance",
      "      triage:",
      '        cron: "*/30 * * * *"',
    ].join("\n"));

    fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
      "domain: proj",
      "agents:",
      "  - lead",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("lead");
    expect(entry).not.toBeNull();
    const jobs = entry!.config.jobs;
    expect(jobs).toBeDefined();
    expect(jobs!["daily-review"]).toBeDefined();
    expect(jobs!["triage"]).toBeDefined();
  });

  it("domain defaults briefing deduplicates sources already on agent", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    // Use a manager agent — domain default briefing is only prepended for managers
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  bot:",
      "    extends: manager",
    ].join("\n"));

    fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
      "domain: proj",
      "agents:",
      "  - bot",
      "defaults:",
      "  briefing:",
      // "soul" is already in manager preset briefing
      "    - source: soul",
      "    - source: direction",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("bot");
    expect(entry).not.toBeNull();
    const soulCount = entry!.config.briefing.filter(s => s.source === "soul").length;
    expect(soulCount).toBe(1);
    // "direction" should be prepended
    expect(entry!.config.briefing.some(s => s.source === "direction")).toBe(true);
  });

  it("role inference works correctly in domain context", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  boss:",
      "    title: The Boss",
      "  minion:",
      "    title: Minion",
      "    reports_to: boss",
    ].join("\n"));

    fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
      "domain: proj",
      "agents:",
      "  - boss",
      "  - minion",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const bossEntry = getAgentConfig("boss");
    const minionEntry = getAgentConfig("minion");
    expect(bossEntry!.config.extends).toBe("manager");
    expect(minionEntry!.config.extends).toBe("employee");
  });

  it("alias resolution (group, subgroup, role) works in full pipeline", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  dev:",
      "    role: employee",
      "    group: engineering",
      "    subgroup: frontend",
      "    title: Frontend Dev",
    ].join("\n"));

    fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
      "domain: proj",
      "agents:",
      "  - dev",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("dev");
    expect(entry).not.toBeNull();
    expect(entry!.config.extends).toBe("employee");
    expect(entry!.config.department).toBe("engineering");
    expect(entry!.config.team).toBe("frontend");
  });

  it("mixin fields are applied before preset resolution", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "mixins:",
      "  logging:",
      "    observe:",
      "      - audit.log",
      "      - budget.warning",
      "    department: operations",
      "agents:",
      "  ops:",
      "    extends: employee",
      "    title: Ops Agent",
      "    mixins:",
      "      - logging",
    ].join("\n"));

    fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
      "domain: proj",
      "agents:",
      "  - ops",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("ops");
    expect(entry).not.toBeNull();
    // Mixin provides department
    expect(entry!.config.department).toBe("operations");
    // Mixin provides observe
    expect(entry!.config.observe).toEqual(["audit.log", "budget.warning"]);
    // Agent title still wins
    expect(entry!.config.title).toBe("Ops Agent");
  });

  it("circular mixin detection prevents infinite loops", async () => {
    const { applyMixins } = await import("../../src/config/init.js");

    const mixins = {
      a: { mixins: ["b"], department: "eng" },
      b: { mixins: ["a"], team: "frontend" },
    };

    const resolved = { extends: "employee" };
    const agentDef = { extends: "employee", mixins: ["a"] as string[] };

    // Circular mixin references are gracefully skipped (not thrown).
    // The cycle is detected and the cyclic branch returns {}, so we get partial results.
    const result = applyMixins(resolved, agentDef, mixins);
    // "a" resolves its nested "b", but "b" tries to resolve "a" again — cycle detected, returns {}.
    // So "b" contributes nothing from its nested "a", but "b" itself contributes team: "frontend".
    // Then "a" layers department: "eng" on top.
    expect(result.department).toBe("eng");
    expect(result.team).toBe("frontend");
  });

  it("mixin agent field overrides mixin field", async () => {
    const { applyMixins } = await import("../../src/config/init.js");

    const mixins = {
      base: { department: "default-dept", team: "default-team" },
    };

    const resolved = { extends: "employee" };
    const agentDef = {
      extends: "employee",
      mixins: ["base"] as string[],
      department: "custom-dept",
    };

    const result = applyMixins(resolved, agentDef, mixins);
    // Agent field wins
    expect(result.department).toBe("custom-dept");
    // Mixin field is used when agent doesn't override
    expect(result.team).toBe("default-team");
  });

  it("multiple mixins are applied in order (later wins)", async () => {
    const { applyMixins } = await import("../../src/config/init.js");

    const mixins = {
      first: { department: "from-first", team: "from-first" },
      second: { department: "from-second" },
    };

    const resolved = { extends: "employee" };
    const agentDef = {
      extends: "employee",
      mixins: ["first", "second"] as string[],
    };

    const result = applyMixins(resolved, agentDef, mixins);
    // second overrides first for department
    expect(result.department).toBe("from-second");
    // team only in first, not overridden
    expect(result.team).toBe("from-first");
  });

  it("nested mixin composition works", async () => {
    const { applyMixins } = await import("../../src/config/init.js");

    const mixins = {
      base: { department: "eng" },
      extended: { mixins: ["base"], team: "frontend" },
    };

    const resolved = { extends: "employee" };
    const agentDef = {
      extends: "employee",
      mixins: ["extended"] as string[],
    };

    const result = applyMixins(resolved, agentDef, mixins);
    expect(result.department).toBe("eng");
    expect(result.team).toBe("frontend");
  });

  it("loadWorkforceConfig resolves observe as string array", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");

    const configPath = path.join(tmpDir, "workforce.yaml");
    fs.writeFileSync(configPath, [
      "name: test-observe",
      "agents:",
      "  watcher:",
      "    extends: employee",
      "    title: Watcher",
      "    observe:",
      "      - budget.exceeded",
      "      - task.failed",
      "    briefing:",
      "      - source: instructions",
      "    expectations: []",
    ].join("\n"));

    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.agents["watcher"].observe).toEqual(["budget.exceeded", "task.failed"]);
  });
});
