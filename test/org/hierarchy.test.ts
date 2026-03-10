import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerWorkforceConfig,
  resetEnforcementConfigForTest,
} from "../../src/project.js";
import {
  getDirectReports,
  resolveEscalationChain,
  getDepartmentAgents,
  getTeamAgents,
} from "../../src/org.js";
import type { AgentConfig, WorkforceConfig } from "../../src/types.js";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "employee",
    briefing: [{ source: "instructions" }],
    expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
    performance_policy: { action: "alert" },
    ...overrides,
  };
}

describe("org hierarchy", () => {
  const projectId = "proj-hierarchy";

  beforeEach(() => {
    resetEnforcementConfigForTest();
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
  });

  describe("getDirectReports", () => {
    it("returns agents that report to the given manager", () => {
      const config: WorkforceConfig = {
        name: "test",
        agents: {
          sarah: makeAgent({ extends: "manager" }),
          alice: makeAgent({ reports_to: "sarah" }),
          bob: makeAgent({ reports_to: "sarah" }),
          charlie: makeAgent({ reports_to: "parent" }),
        },
      };
      registerWorkforceConfig(projectId, config);

      const reports = getDirectReports(projectId, "sarah");
      expect(reports).toHaveLength(2);
      expect(reports).toContain("alice");
      expect(reports).toContain("bob");
    });

    it("returns empty array when no agents report to the manager", () => {
      const config: WorkforceConfig = {
        name: "test",
        agents: {
          sarah: makeAgent({ extends: "manager" }),
          alice: makeAgent({ reports_to: "parent" }),
        },
      };
      registerWorkforceConfig(projectId, config);

      expect(getDirectReports(projectId, "sarah")).toHaveLength(0);
    });

    it("scopes to the specified project", () => {
      const config: WorkforceConfig = {
        name: "test",
        agents: {
          sarah: makeAgent({ extends: "manager" }),
          alice: makeAgent({ reports_to: "sarah" }),
        },
      };
      registerWorkforceConfig(projectId, config);

      // Different project should return nothing
      expect(getDirectReports("other-project", "sarah")).toHaveLength(0);
    });
  });

  describe("resolveEscalationChain", () => {
    it("resolves a simple chain: employee → team lead → director", () => {
      const config: WorkforceConfig = {
        name: "test",
        agents: {
          worker: makeAgent({ reports_to: "lead" }),
          lead: makeAgent({ extends: "manager", reports_to: "director" }),
          director: makeAgent({ extends: "manager", reports_to: "parent" }),
        },
      };
      registerWorkforceConfig(projectId, config);

      const result = resolveEscalationChain(projectId, "worker");
      expect(result.hasCycle).toBe(false);
      expect(result.chain).toEqual(["lead", "director"]);
    });

    it("stops at 'parent' reports_to", () => {
      const config: WorkforceConfig = {
        name: "test",
        agents: {
          worker: makeAgent({ reports_to: "lead" }),
          lead: makeAgent({ extends: "manager", reports_to: "parent" }),
        },
      };
      registerWorkforceConfig(projectId, config);

      const result = resolveEscalationChain(projectId, "worker");
      expect(result.hasCycle).toBe(false);
      expect(result.chain).toEqual(["lead"]);
    });

    it("stops when reports_to is absent", () => {
      const config: WorkforceConfig = {
        name: "test",
        agents: {
          worker: makeAgent({ reports_to: "lead" }),
          lead: makeAgent({ extends: "manager" }), // no reports_to
        },
      };
      registerWorkforceConfig(projectId, config);

      const result = resolveEscalationChain(projectId, "worker");
      expect(result.hasCycle).toBe(false);
      expect(result.chain).toEqual(["lead"]);
    });

    it("detects cycles", () => {
      const config: WorkforceConfig = {
        name: "test",
        agents: {
          a: makeAgent({ reports_to: "b" }),
          b: makeAgent({ reports_to: "c" }),
          c: makeAgent({ reports_to: "a" }), // cycle back to a
        },
      };
      registerWorkforceConfig(projectId, config);

      const result = resolveEscalationChain(projectId, "a");
      expect(result.hasCycle).toBe(true);
      // Chain should include b and c (up to the cycle point)
      expect(result.chain).toEqual(["b", "c"]);
    });

    it("detects self-referencing cycle", () => {
      const config: WorkforceConfig = {
        name: "test",
        agents: {
          solo: makeAgent({ reports_to: "solo" }),
        },
      };
      registerWorkforceConfig(projectId, config);

      const result = resolveEscalationChain(projectId, "solo");
      expect(result.hasCycle).toBe(true);
      expect(result.chain).toEqual([]);
    });

    it("returns empty chain for agent with no reports_to", () => {
      const config: WorkforceConfig = {
        name: "test",
        agents: {
          root: makeAgent({ extends: "manager" }),
        },
      };
      registerWorkforceConfig(projectId, config);

      const result = resolveEscalationChain(projectId, "root");
      expect(result.hasCycle).toBe(false);
      expect(result.chain).toEqual([]);
    });
  });

  describe("getDepartmentAgents", () => {
    it("returns agents in the same department", () => {
      const config: WorkforceConfig = {
        name: "test",
        agents: {
          alice: makeAgent({ department: "engineering" }),
          bob: makeAgent({ department: "engineering" }),
          carol: makeAgent({ department: "sales" }),
        },
      };
      registerWorkforceConfig(projectId, config);

      const eng = getDepartmentAgents(projectId, "engineering");
      expect(eng).toHaveLength(2);
      expect(eng).toContain("alice");
      expect(eng).toContain("bob");

      const sales = getDepartmentAgents(projectId, "sales");
      expect(sales).toEqual(["carol"]);
    });

    it("returns empty for non-existent department", () => {
      const config: WorkforceConfig = {
        name: "test",
        agents: {
          alice: makeAgent({ department: "engineering" }),
        },
      };
      registerWorkforceConfig(projectId, config);

      expect(getDepartmentAgents(projectId, "hr")).toHaveLength(0);
    });
  });

  describe("getTeamAgents", () => {
    it("returns agents in the same team", () => {
      const config: WorkforceConfig = {
        name: "test",
        agents: {
          alice: makeAgent({ team: "frontend" }),
          bob: makeAgent({ team: "frontend" }),
          carol: makeAgent({ team: "backend" }),
        },
      };
      registerWorkforceConfig(projectId, config);

      const fe = getTeamAgents(projectId, "frontend");
      expect(fe).toHaveLength(2);
      expect(fe).toContain("alice");
      expect(fe).toContain("bob");
    });
  });
});
