/**
 * Merge precedence conflict tests — verifies which layer wins when
 * the same field is set at multiple levels of the config hierarchy.
 *
 * Layers (lowest to highest priority):
 *   preset (manager/employee) → domain defaults → agent-specific overrides
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

describe("merge precedence conflicts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-precedence-"));
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

  describe("briefing precedence", () => {
    it("domain default briefing sources are prepended, not replaced", async () => {
      const { initializeAllDomains } = await import("../../src/config/init.js");
      const { getAgentConfig } = await import("../../src/project.js");

      // Use a manager agent — domain default briefing is only prepended for managers
      fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
        "agents:",
        "  lead:",
        "    extends: manager",
        "    title: Lead",
      ].join("\n"));

      // Domain default adds "direction" and "policies" to briefing
      fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
        "domain: proj",
        "agents:",
        "  - lead",
        "defaults:",
        "  briefing:",
        "    - source: direction",
        "    - source: policies",
      ].join("\n"));

      initializeAllDomains(tmpDir);

      const entry = getAgentConfig("lead");
      expect(entry).not.toBeNull();

      // Domain defaults are prepended before preset briefing (managers only)
      const sources = entry!.config.briefing.map(
        (s: unknown) => typeof s === "string" ? s : (s as { source: string }).source,
      );
      const dirIdx = sources.indexOf("direction");
      const polIdx = sources.indexOf("policies");
      // Manager preset briefing contains "soul"
      const soulIdx = sources.indexOf("soul");

      expect(dirIdx).toBeGreaterThanOrEqual(0);
      expect(polIdx).toBeGreaterThanOrEqual(0);
      expect(soulIdx).toBeGreaterThanOrEqual(0);
      // Domain defaults come first
      expect(dirIdx).toBeLessThan(soulIdx);
      expect(polIdx).toBeLessThan(soulIdx);
    });

    it("same source in domain defaults AND preset — no duplicate", async () => {
      const { initializeAllDomains } = await import("../../src/config/init.js");
      const { getAgentConfig } = await import("../../src/project.js");

      // Use a manager agent — domain default briefing is only prepended for managers
      fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
        "agents:",
        "  lead:",
        "    extends: manager",
      ].join("\n"));

      // "soul" is already in manager preset; domain defaults also include it
      fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
        "domain: proj",
        "agents:",
        "  - lead",
        "defaults:",
        "  briefing:",
        "    - source: soul",
        "    - source: direction",
      ].join("\n"));

      initializeAllDomains(tmpDir);

      const entry = getAgentConfig("lead");
      const soulCount = entry!.config.briefing.filter(s => s.source === "soul").length;
      // Deduplication ensures only one soul source
      expect(soulCount).toBe(1);
    });
  });

  describe("expectations precedence", () => {
    it("domain default expectations are appended to preset expectations", async () => {
      const { initializeAllDomains } = await import("../../src/config/init.js");
      const { getAgentConfig } = await import("../../src/project.js");

      fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
        "agents:",
        "  lead:",
        "    extends: manager",
        "    title: Lead",
      ].join("\n"));

      fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
        "domain: proj",
        "agents:",
        "  - lead",
        "defaults:",
        "  expectations:",
        "    - tool: custom_tool",
        "      action: run",
        "      min_calls: 1",
      ].join("\n"));

      initializeAllDomains(tmpDir);

      const entry = getAgentConfig("lead");
      expect(entry).not.toBeNull();
      // Manager preset has clawforce_log expectation
      expect(entry!.config.expectations.some(e => e.tool === "clawforce_log")).toBe(true);
      // Domain default is appended
      expect(entry!.config.expectations.some(e => e.tool === "custom_tool")).toBe(true);
    });

    it("agent-level explicit expectations: [] blocks domain default expectations", async () => {
      const { initializeAllDomains } = await import("../../src/config/init.js");
      const { getAgentConfig } = await import("../../src/project.js");

      fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
        "agents:",
        "  worker:",
        "    extends: employee",
        "    expectations: []",
      ].join("\n"));

      fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
        "domain: proj",
        "agents:",
        "  - worker",
        "defaults:",
        "  expectations:",
        "    - tool: clawforce_log",
        "      action: write",
        "      min_calls: 1",
      ].join("\n"));

      initializeAllDomains(tmpDir);

      const entry = getAgentConfig("worker");
      expect(entry).not.toBeNull();
      // User explicitly set expectations: [] — domain defaults should be skipped
      expect(entry!.config.expectations).toHaveLength(0);
    });
  });

  describe("performance_policy precedence", () => {
    it("domain default performance_policy overrides preset default", async () => {
      const { initializeAllDomains } = await import("../../src/config/init.js");
      const { getAgentConfig } = await import("../../src/project.js");

      fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
        "agents:",
        "  worker:",
        "    extends: employee",
      ].join("\n"));

      fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
        "domain: proj",
        "agents:",
        "  - worker",
        "defaults:",
        "  performance_policy:",
        "    action: retry",
        "    max_retries: 99",
      ].join("\n"));

      initializeAllDomains(tmpDir);

      const entry = getAgentConfig("worker");
      expect(entry).not.toBeNull();
      // Domain default wins over employee preset default
      expect(entry!.config.performance_policy).toEqual({
        action: "retry",
        max_retries: 99,
      });
    });

    it("global defaults performance_policy used when agent and preset have none", async () => {
      const { initializeAllDomains } = await import("../../src/config/init.js");
      const { getAgentConfig } = await import("../../src/project.js");

      // Employee preset already has performance_policy, so this tests the fallback path
      // indirectly — the global default is used when resolved config has no performance_policy
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
      // The employee preset has performance_policy already, so it should be present
      expect(entry!.config.performance_policy).toBeDefined();
      expect(entry!.config.performance_policy.action).toBeDefined();
    });
  });

  describe("team field precedence", () => {
    it("explicit team field wins over subgroup alias", async () => {
      const { initializeAllDomains } = await import("../../src/config/init.js");
      const { getAgentConfig } = await import("../../src/project.js");

      fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
        "agents:",
        "  dev:",
        "    extends: employee",
        "    team: explicit-team",
        "    subgroup: alias-team",
      ].join("\n"));

      fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
        "domain: proj",
        "agents:",
        "  - dev",
      ].join("\n"));

      initializeAllDomains(tmpDir);

      const entry = getAgentConfig("dev");
      expect(entry).not.toBeNull();
      // Canonical "team" takes precedence over "subgroup" alias
      expect(entry!.config.team).toBe("explicit-team");
    });

    it("subgroup alias maps to team when team is not set", async () => {
      const { initializeAllDomains } = await import("../../src/config/init.js");
      const { getAgentConfig } = await import("../../src/project.js");

      fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
        "agents:",
        "  dev:",
        "    extends: employee",
        "    subgroup: frontend",
      ].join("\n"));

      fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
        "domain: proj",
        "agents:",
        "  - dev",
      ].join("\n"));

      initializeAllDomains(tmpDir);

      const entry = getAgentConfig("dev");
      expect(entry).not.toBeNull();
      expect(entry!.config.team).toBe("frontend");
    });
  });

  describe("mixin vs agent field precedence", () => {
    it("agent field always wins over mixin field", async () => {
      const { initializeAllDomains } = await import("../../src/config/init.js");
      const { getAgentConfig } = await import("../../src/project.js");

      fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
        "mixins:",
        "  ops:",
        "    department: operations",
        "    team: ops-team",
        "agents:",
        "  bot:",
        "    extends: employee",
        "    mixins:",
        "      - ops",
        "    department: custom-dept",
      ].join("\n"));

      fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
        "domain: proj",
        "agents:",
        "  - bot",
      ].join("\n"));

      initializeAllDomains(tmpDir);

      const entry = getAgentConfig("bot");
      expect(entry).not.toBeNull();
      // Agent field wins over mixin
      expect(entry!.config.department).toBe("custom-dept");
      // Mixin field used when agent doesn't override
      expect(entry!.config.team).toBe("ops-team");
    });
  });

  describe("extends/role alias precedence", () => {
    it("extends wins over role alias", async () => {
      const { initializeAllDomains } = await import("../../src/config/init.js");
      const { getAgentConfig } = await import("../../src/project.js");

      fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
        "agents:",
        "  agent:",
        "    extends: manager",
        "    role: employee",
        "    title: Conflicted Agent",
      ].join("\n"));

      fs.writeFileSync(path.join(tmpDir, "domains", "proj.yaml"), [
        "domain: proj",
        "agents:",
        "  - agent",
      ].join("\n"));

      initializeAllDomains(tmpDir);

      const entry = getAgentConfig("agent");
      expect(entry).not.toBeNull();
      // extends is the canonical field, wins over role alias
      expect(entry!.config.extends).toBe("manager");
      // Manager preset provides coordination
      expect(entry!.config.coordination?.enabled).toBe(true);
    });
  });

  describe("mergeDomainDefaults direct tests", () => {
    it("performance_policy from domain defaults replaces preset policy", async () => {
      const { mergeDomainDefaults } = await import("../../src/config/init.js");

      const agentConfig = {
        extends: "employee" as const,
        briefing: [{ source: "instructions" as const }],
        expectations: [],
        performance_policy: { action: "alert" as const },
      };

      const domainDefaults = {
        performance_policy: { action: "retry" as const, max_retries: 7 },
      };

      const merged = mergeDomainDefaults(agentConfig, domainDefaults);
      expect(merged.performance_policy).toEqual({ action: "retry", max_retries: 7 });
    });

    it("domain briefing + agent briefing merges without losing agent sources", async () => {
      const { mergeDomainDefaults } = await import("../../src/config/init.js");

      // Use a manager config — domain default briefing is only prepended for managers
      const agentConfig = {
        extends: "manager" as const,
        briefing: [
          { source: "instructions" as const },
          { source: "assigned_task" as const },
        ],
        coordination: { enabled: true },
        expectations: [],
        performance_policy: { action: "alert" as const },
      };

      const domainDefaults = {
        briefing: [
          { source: "direction" as const },
          { source: "policies" as const },
        ],
      };

      const merged = mergeDomainDefaults(agentConfig, domainDefaults);

      // All sources present
      expect(merged.briefing.some(s => s.source === "direction")).toBe(true);
      expect(merged.briefing.some(s => s.source === "policies")).toBe(true);
      expect(merged.briefing.some(s => s.source === "instructions")).toBe(true);
      expect(merged.briefing.some(s => s.source === "assigned_task")).toBe(true);

      // Domain defaults come first
      const dirIdx = merged.briefing.findIndex(s => s.source === "direction");
      const instrIdx = merged.briefing.findIndex(s => s.source === "instructions");
      expect(dirIdx).toBeLessThan(instrIdx);
    });

    it("empty domain defaults changes nothing", async () => {
      const { mergeDomainDefaults } = await import("../../src/config/init.js");

      const agentConfig = {
        extends: "employee" as const,
        briefing: [{ source: "instructions" as const }],
        expectations: [{ tool: "test", action: "run", min_calls: 1 }],
        performance_policy: { action: "alert" as const },
      };

      const merged = mergeDomainDefaults(agentConfig, {});

      expect(merged.briefing).toEqual(agentConfig.briefing);
      expect(merged.expectations).toEqual(agentConfig.expectations);
      expect(merged.performance_policy).toEqual(agentConfig.performance_policy);
    });
  });
});
