/**
 * Tests for AgentsNamespace (src/sdk/agents.ts).
 *
 * Strategy: use registerWorkforceConfig to populate the internal registry,
 * then call AgentsNamespace methods and assert the public SDK shape.
 * Reset the registry in beforeEach/afterEach with resetEnforcementConfigForTest.
 *
 * Vocabulary mapping verified:
 *   department  → group
 *   team        → subgroup
 *   extends     → role
 *   reports_to  → reportsTo (hierarchy)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const { AgentsNamespace } = await import("../../src/sdk/agents.js");

// ---- Helpers ----

const DOMAIN = "test-domain";

/** Build a minimal valid internal AgentConfig for testing. */
function makeAgentConfig(overrides: {
  extends?: string;
  department?: string;
  team?: string;
  reports_to?: string;
  coordination?: { enabled: boolean; schedule?: string };
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
    reports_to: overrides.reports_to,
    coordination: overrides.coordination,
  };
}

function registerAgents(
  agents: Record<string, ReturnType<typeof makeAgentConfig>>,
  domain: string = DOMAIN,
) {
  registerWorkforceConfig(domain, { name: "test", agents });
}

// ---- Tests ----

describe("AgentsNamespace", () => {
  let ns: InstanceType<typeof AgentsNamespace>;

  beforeEach(() => {
    resetEnforcementConfigForTest();
    ns = new AgentsNamespace(DOMAIN);
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
      const ns2 = new AgentsNamespace("research-lab");
      expect(ns2.domain).toBe("research-lab");
    });
  });

  // ---------- list ----------

  describe("list", () => {
    beforeEach(() => {
      registerAgents({
        alice: makeAgentConfig({ extends: "manager", department: "engineering" }),
        bob: makeAgentConfig({ extends: "employee", department: "engineering", team: "frontend" }),
        carol: makeAgentConfig({ extends: "employee", department: "sales" }),
      });
    });

    it("returns all agents in the domain", () => {
      const agents = ns.list();
      expect(agents).toHaveLength(3);
      const ids = agents.map((a) => a.id);
      expect(ids).toContain("alice");
      expect(ids).toContain("bob");
      expect(ids).toContain("carol");
    });

    it("returns AgentInfo objects with id, role, capabilities, status", () => {
      const agents = ns.list();
      for (const agent of agents) {
        expect(typeof agent.id).toBe("string");
        expect(typeof agent.status).toBe("string");
        expect(Array.isArray(agent.capabilities)).toBe(true);
      }
    });

    it("maps extends → role on AgentInfo", () => {
      const alice = ns.list().find((a) => a.id === "alice");
      expect(alice?.role).toBe("manager");
    });

    it("maps department → group on AgentInfo", () => {
      const bob = ns.list().find((a) => a.id === "bob");
      expect(bob?.group).toBe("engineering");
    });

    it("maps team → subgroup on AgentInfo", () => {
      const bob = ns.list().find((a) => a.id === "bob");
      expect(bob?.subgroup).toBe("frontend");
    });

    it("filters by group (maps to internal department)", () => {
      const engAgents = ns.list({ group: "engineering" });
      expect(engAgents).toHaveLength(2);
      expect(engAgents.every((a) => a.group === "engineering")).toBe(true);
    });

    it("returns empty array when no agents match the group filter", () => {
      const result = ns.list({ group: "marketing" });
      expect(result).toHaveLength(0);
    });

    it("does not include agents from other domains", () => {
      registerAgents({ dave: makeAgentConfig() }, "other-domain");
      const agents = ns.list();
      const ids = agents.map((a) => a.id);
      expect(ids).not.toContain("dave");
    });

    it("returns empty array when no agents are registered", () => {
      resetEnforcementConfigForTest();
      expect(ns.list()).toHaveLength(0);
    });
  });

  // ---------- get ----------

  describe("get", () => {
    beforeEach(() => {
      registerAgents({
        alice: makeAgentConfig({ extends: "manager", department: "engineering", title: "VP Eng" }),
      });
    });

    it("returns AgentInfo for a known agent", () => {
      const agent = ns.get("alice");
      expect(agent).toBeDefined();
      expect(agent?.id).toBe("alice");
      expect(agent?.role).toBe("manager");
    });

    it("returns undefined for an unknown agent id", () => {
      expect(ns.get("no-such-agent")).toBeUndefined();
    });

    it("returns undefined for an agent in another domain", () => {
      registerAgents({ bob: makeAgentConfig() }, "other-domain");
      const ns2 = new AgentsNamespace("other-domain");
      // bob exists in other-domain but not in DOMAIN
      expect(ns.get("bob")).toBeUndefined();
      // bob is accessible from other-domain ns
      expect(ns2.get("bob")).toBeDefined();
    });

    it("exposes title when set", () => {
      const agent = ns.get("alice");
      expect(agent?.title).toBe("VP Eng");
    });

    it("includes capabilities derived from the preset", () => {
      const agent = ns.get("alice");
      expect(agent?.capabilities).toContain("coordinate");
      expect(agent?.capabilities).toContain("create_tasks");
    });
  });

  // ---------- capabilities ----------

  describe("capabilities", () => {
    beforeEach(() => {
      registerAgents({
        mgr: makeAgentConfig({ extends: "manager" }),
        emp: makeAgentConfig({ extends: "employee" }),
        emp_coord: makeAgentConfig({ extends: "employee", coordination: { enabled: true } }),
      });
    });

    it("returns manager capabilities for a manager agent", () => {
      const caps = ns.capabilities("mgr");
      expect(caps).toContain("coordinate");
      expect(caps).toContain("create_tasks");
      expect(caps).toContain("run_meetings");
      expect(caps).toContain("review_work");
      expect(caps).toContain("escalate");
    });

    it("returns employee capabilities for an employee agent", () => {
      const caps = ns.capabilities("emp");
      expect(caps).toContain("execute_tasks");
      expect(caps).toContain("report_status");
      expect(caps).not.toContain("coordinate");
    });

    it("includes coordinate for employee with coordination.enabled", () => {
      const caps = ns.capabilities("emp_coord");
      expect(caps).toContain("coordinate");
      expect(caps).toContain("execute_tasks");
    });

    it("returns empty array for unknown agent", () => {
      expect(ns.capabilities("ghost")).toHaveLength(0);
    });

    it("returns empty array for agent in another domain", () => {
      registerAgents({ outsider: makeAgentConfig({ extends: "manager" }) }, "other-domain");
      expect(ns.capabilities("outsider")).toHaveLength(0);
    });
  });

  // ---------- hasCapability ----------

  describe("hasCapability", () => {
    beforeEach(() => {
      registerAgents({
        mgr: makeAgentConfig({ extends: "manager" }),
        emp: makeAgentConfig({ extends: "employee" }),
        asst: makeAgentConfig({ extends: "assistant" }),
      });
    });

    it("returns true for coordinate on manager", () => {
      expect(ns.hasCapability("mgr", "coordinate")).toBe(true);
    });

    it("returns false for coordinate on employee", () => {
      expect(ns.hasCapability("emp", "coordinate")).toBe(false);
    });

    it("returns true for execute_tasks on employee", () => {
      expect(ns.hasCapability("emp", "execute_tasks")).toBe(true);
    });

    it("returns false for execute_tasks on manager", () => {
      expect(ns.hasCapability("mgr", "execute_tasks")).toBe(false);
    });

    it("returns true for monitor on assistant", () => {
      expect(ns.hasCapability("asst", "monitor")).toBe(true);
    });

    it("returns false for unknown agent", () => {
      expect(ns.hasCapability("ghost", "coordinate")).toBe(false);
    });

    it("returns false for agent in another domain", () => {
      registerAgents({ outsider: makeAgentConfig({ extends: "manager" }) }, "other-domain");
      expect(ns.hasCapability("outsider", "coordinate")).toBe(false);
    });

    it("replaces extends === manager check pattern", () => {
      // The SDK pattern should be: ns.hasCapability(agentId, "coordinate")
      // instead of: entry.config.extends === "manager"
      expect(ns.hasCapability("mgr", "coordinate")).toBe(true);
      expect(ns.hasCapability("emp", "coordinate")).toBe(false);
      expect(ns.hasCapability("asst", "coordinate")).toBe(false);
    });
  });

  // ---------- hierarchy ----------

  describe("hierarchy", () => {
    beforeEach(() => {
      registerAgents({
        ceo: makeAgentConfig({ extends: "manager" }),
        vp: makeAgentConfig({ extends: "manager", reports_to: "ceo" }),
        eng1: makeAgentConfig({ extends: "employee", reports_to: "vp" }),
        eng2: makeAgentConfig({ extends: "employee", reports_to: "vp" }),
        solo: makeAgentConfig({ extends: "employee" }),
      });
    });

    it("returns directReports for a manager", () => {
      const h = ns.hierarchy("vp");
      expect(h.directReports).toContain("eng1");
      expect(h.directReports).toContain("eng2");
    });

    it("returns reportsTo for an employee", () => {
      const h = ns.hierarchy("eng1");
      expect(h.reportsTo).toBe("vp");
    });

    it("returns reportsTo for vp as ceo", () => {
      const h = ns.hierarchy("vp");
      expect(h.reportsTo).toBe("ceo");
    });

    it("ceo has no reportsTo (root node)", () => {
      const h = ns.hierarchy("ceo");
      expect(h.reportsTo).toBeUndefined();
    });

    it("solo agent has no reportsTo and no directReports", () => {
      const h = ns.hierarchy("solo");
      expect(h.reportsTo).toBeUndefined();
      expect(h.directReports).toHaveLength(0);
    });

    it("returns empty structure for unknown agent", () => {
      const h = ns.hierarchy("ghost");
      expect(h.reportsTo).toBeUndefined();
      expect(h.directReports).toHaveLength(0);
    });

    it("treats 'parent' sentinel as no reportsTo", () => {
      registerAgents({
        special: makeAgentConfig({ reports_to: "parent" }),
      });
      const h = ns.hierarchy("special");
      expect(h.reportsTo).toBeUndefined();
    });
  });

  // ---------- group ----------

  describe("group", () => {
    beforeEach(() => {
      registerAgents({
        alice: makeAgentConfig({ department: "engineering" }),
        bob: makeAgentConfig({ department: "engineering" }),
        carol: makeAgentConfig({ department: "sales" }),
        dave: makeAgentConfig({}), // no department
      });
    });

    it("returns all agents in the named group", () => {
      const engAgents = ns.group("engineering");
      expect(engAgents).toHaveLength(2);
      const ids = engAgents.map((a) => a.id);
      expect(ids).toContain("alice");
      expect(ids).toContain("bob");
    });

    it("returns only agents in the named group", () => {
      const salesAgents = ns.group("sales");
      expect(salesAgents).toHaveLength(1);
      expect(salesAgents[0]?.id).toBe("carol");
    });

    it("returns empty array for a non-existent group", () => {
      expect(ns.group("marketing")).toHaveLength(0);
    });

    it("each returned AgentInfo has group set to the requested group name", () => {
      const agents = ns.group("engineering");
      expect(agents.every((a) => a.group === "engineering")).toBe(true);
    });
  });
});
