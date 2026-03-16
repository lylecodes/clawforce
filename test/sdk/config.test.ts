/**
 * Tests for ConfigNamespace (src/sdk/config.ts).
 *
 * Strategy: use registerWorkforceConfig / resetEnforcementConfigForTest to
 * populate the internal registry, then call ConfigNamespace methods and assert
 * the public SDK shape.
 *
 * Vocabulary mapping verified:
 *   extends    → role
 *   department → group
 *   team       → subgroup
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

// ---- Module mocks (must come before dynamic imports) ----

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

// ---- Dynamic imports after mocks ----

const { registerWorkforceConfig, resetEnforcementConfigForTest } =
  await import("../../src/project.js");
const { ConfigNamespace } = await import("../../src/sdk/config.js");
const { BUILTIN_AGENT_PRESETS } = await import("../../src/presets.js");

// ---- Helpers ----

const DOMAIN = "test-config-domain";

function makeAgentConfig(overrides: {
  extends?: string;
  department?: string;
  team?: string;
  title?: string;
} = {}) {
  return {
    extends: overrides.extends ?? "employee",
    title: overrides.title,
    briefing: [],
    expectations: [],
    performance_policy: { action: "alert" as const },
    department: overrides.department,
    team: overrides.team,
  };
}

function registerAgents(
  agents: Record<string, ReturnType<typeof makeAgentConfig>>,
  domain: string = DOMAIN,
) {
  registerWorkforceConfig(domain, { name: domain, agents });
}

// ---- Tests ----

describe("ConfigNamespace", () => {
  let ns: InstanceType<typeof ConfigNamespace>;

  beforeEach(() => {
    resetEnforcementConfigForTest();
    ns = new ConfigNamespace(DOMAIN);
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
  });

  // ---------- constructor ----------

  describe("constructor", () => {
    it("stores domain on instance", () => {
      expect(ns.domain).toBe(DOMAIN);
    });

    it("accepts arbitrary domain strings", () => {
      const ns2 = new ConfigNamespace("research-lab");
      expect(ns2.domain).toBe("research-lab");
    });
  });

  // ---------- presets ----------

  describe("presets()", () => {
    it("returns an object", () => {
      expect(typeof ns.presets()).toBe("object");
    });

    it("includes all built-in preset keys", () => {
      const result = ns.presets();
      for (const key of Object.keys(BUILTIN_AGENT_PRESETS)) {
        expect(result).toHaveProperty(key);
      }
    });

    it("contains 'manager' preset", () => {
      expect(ns.presets()).toHaveProperty("manager");
    });

    it("contains 'employee' preset", () => {
      expect(ns.presets()).toHaveProperty("employee");
    });

    it("contains 'assistant' preset", () => {
      expect(ns.presets()).toHaveProperty("assistant");
    });

    it("contains 'dashboard-assistant' preset", () => {
      expect(ns.presets()).toHaveProperty("dashboard-assistant");
    });

    it("returns a copy (not the original reference)", () => {
      const p1 = ns.presets();
      const p2 = ns.presets();
      expect(p1).not.toBe(p2);
    });

    it("manager preset has a title field", () => {
      const p = ns.presets();
      expect(p.manager).toHaveProperty("title");
    });

    it("employee preset has a briefing array", () => {
      const p = ns.presets();
      expect(Array.isArray(p.employee.briefing)).toBe(true);
    });
  });

  // ---------- get ----------

  describe("get(agentId)", () => {
    beforeEach(() => {
      registerAgents({
        alice: makeAgentConfig({ extends: "manager", department: "engineering", title: "CTO" }),
        bob: makeAgentConfig({ extends: "employee", department: "engineering", team: "frontend" }),
        carol: makeAgentConfig({ extends: "assistant", department: "ops" }),
      });
    });

    it("returns an object for a known agent", () => {
      const cfg = ns.get("alice");
      expect(cfg).toBeDefined();
      expect(typeof cfg).toBe("object");
    });

    it("maps extends → role", () => {
      const cfg = ns.get("alice");
      expect(cfg.role).toBe("manager");
    });

    it("maps department → group", () => {
      const cfg = ns.get("bob");
      expect(cfg.group).toBe("engineering");
    });

    it("maps team → subgroup", () => {
      const cfg = ns.get("bob");
      expect(cfg.subgroup).toBe("frontend");
    });

    it("exposes title", () => {
      const cfg = ns.get("alice");
      expect(cfg.title).toBe("CTO");
    });

    it("returns undefined for an unknown agent", () => {
      expect(ns.get("no-such-agent")).toBeUndefined();
    });

    it("does not include raw 'extends' key on returned config", () => {
      const cfg = ns.get("alice");
      expect(cfg).not.toHaveProperty("extends");
    });

    it("does not include raw 'department' key on returned config", () => {
      const cfg = ns.get("bob");
      expect(cfg).not.toHaveProperty("department");
    });

    it("does not include raw 'team' key on returned config", () => {
      const cfg = ns.get("bob");
      expect(cfg).not.toHaveProperty("team");
    });
  });

  // ---------- get() with no agentId → extended domain config ----------

  describe("get() without agentId", () => {
    it("returns null when no extended config is registered", () => {
      // No registerWorkforceConfig call — extended config is empty
      expect(ns.get()).toBeNull();
    });

    it("returns extended config when policies are registered", () => {
      const policies = [{ name: "no-pii", rules: [] }];
      registerWorkforceConfig(DOMAIN, {
        name: DOMAIN,
        agents: {},
        policies: policies as any,
      });
      const result = ns.get();
      expect(result).toBeDefined();
      // extended config stores whatever sections were registered
    });
  });

  // ---------- agents ----------

  describe("agents()", () => {
    it("returns empty array when no agents are registered", () => {
      expect(ns.agents()).toHaveLength(0);
    });

    it("returns all agent IDs for this domain", () => {
      registerAgents({
        alice: makeAgentConfig(),
        bob: makeAgentConfig(),
        carol: makeAgentConfig(),
      });
      const ids = ns.agents();
      expect(ids).toHaveLength(3);
      expect(ids).toContain("alice");
      expect(ids).toContain("bob");
      expect(ids).toContain("carol");
    });

    it("returns only agents for this domain, not other domains", () => {
      registerAgents({ alice: makeAgentConfig() }, DOMAIN);
      registerAgents({ outsider: makeAgentConfig() }, "other-domain");

      const ids = ns.agents();
      expect(ids).toContain("alice");
      expect(ids).not.toContain("outsider");
    });

    it("returns an array of strings", () => {
      registerAgents({ alice: makeAgentConfig() });
      const ids = ns.agents();
      expect(Array.isArray(ids)).toBe(true);
      for (const id of ids) {
        expect(typeof id).toBe("string");
      }
    });
  });

  // ---------- extended ----------

  describe("extended()", () => {
    it("returns null when no extended config has been registered", () => {
      expect(ns.extended()).toBeNull();
    });

    it("returns the extended config when registered with policies", () => {
      const policies = [{ name: "test-policy", rules: [] }];
      registerWorkforceConfig(DOMAIN, {
        name: DOMAIN,
        agents: {},
        policies: policies as any,
      });
      const ext = ns.extended();
      expect(ext).toBeDefined();
      expect(ext).toHaveProperty("policies");
    });

    it("extended() and get() without agentId return the same object", () => {
      registerWorkforceConfig(DOMAIN, {
        name: DOMAIN,
        agents: {},
        policies: [{ name: "p", rules: [] }] as any,
      });
      expect(ns.extended()).toStrictEqual(ns.get());
    });
  });

  // ---------- load ----------

  describe("load()", () => {
    it("accepts a directory path without throwing for a missing config dir", () => {
      // A non-existent directory should not throw — initializeAllDomains handles it gracefully
      const tmpDir = path.join(os.tmpdir(), `clawforce-sdk-test-${Date.now()}`);
      expect(() => ns.load(tmpDir)).not.toThrow();
    });

    it("accepts a YAML file path and uses its parent directory", () => {
      // A non-existent YAML path should not throw
      const tmpYaml = path.join(os.tmpdir(), `clawforce-sdk-test-${Date.now()}`, "config.yaml");
      expect(() => ns.load(tmpYaml)).not.toThrow();
    });

    it("loads agents from a real temp config directory", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-sdk-load-test-"));
      try {
        // Write minimal config.yaml
        fs.writeFileSync(
          path.join(tmpDir, "config.yaml"),
          `agents:\n  loader-bot:\n    extends: employee\n    title: Loader Bot\n`,
          "utf-8",
        );
        // Write a domain yaml
        const domainsDir = path.join(tmpDir, "domains");
        fs.mkdirSync(domainsDir);
        fs.writeFileSync(
          path.join(domainsDir, "loader-domain.yaml"),
          `domain: loader-domain\nagents:\n  - loader-bot\n`,
          "utf-8",
        );

        const loaderNs = new ConfigNamespace("loader-domain");
        loaderNs.load(tmpDir);

        const ids = loaderNs.agents();
        expect(ids).toContain("loader-bot");

        const cfg = loaderNs.get("loader-bot");
        expect(cfg).toBeDefined();
        expect(cfg.role).toBe("employee");
        expect(cfg.title).toBe("Loader Bot");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        resetEnforcementConfigForTest();
      }
    });
  });
});
