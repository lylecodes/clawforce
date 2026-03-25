import { describe, expect, it } from "vitest";
import type { DomainConfig } from "../../src/config/schema.js";

describe("domain defaults config inheritance", () => {
  describe("DomainConfig.defaults type", () => {
    it("accepts a domain config with defaults section", () => {
      const config: DomainConfig = {
        domain: "test-domain",
        agents: ["agent-a"],
        defaults: {
          briefing: [{ source: "direction" }],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "retry", max_retries: 2 },
        },
      };

      expect(config.defaults).toBeDefined();
      expect(config.defaults!.briefing).toHaveLength(1);
      expect(config.defaults!.expectations).toHaveLength(1);
      expect(config.defaults!.performance_policy).toEqual({ action: "retry", max_retries: 2 });
    });

    it("accepts a domain config without defaults section", () => {
      const config: DomainConfig = {
        domain: "test-domain",
        agents: ["agent-a"],
      };

      expect(config.defaults).toBeUndefined();
    });

    it("accepts partial defaults — only briefing", () => {
      const config: DomainConfig = {
        domain: "test-domain",
        agents: ["agent-a"],
        defaults: {
          briefing: [{ source: "policies" }],
        },
      };

      expect(config.defaults!.briefing).toHaveLength(1);
      expect(config.defaults!.expectations).toBeUndefined();
      expect(config.defaults!.performance_policy).toBeUndefined();
    });
  });

  describe("mergeDomainDefaults", () => {
    it("prepends domain default briefing to manager agent briefing", async () => {
      const { mergeDomainDefaults } = await import("../../src/config/init.js");

      const domainDefaults: DomainConfig["defaults"] = {
        briefing: [
          { source: "direction" },
          { source: "policies" },
        ],
      };

      const agentConfig = {
        extends: "manager" as const,
        coordination: { enabled: true },
        briefing: [
          { source: "instructions" },
          { source: "assigned_task" },
        ],
        expectations: [
          { tool: "clawforce_task", action: "transition", min_calls: 1 },
        ],
        performance_policy: { action: "retry" as const, max_retries: 3 },
      };

      const merged = mergeDomainDefaults(agentConfig, domainDefaults);

      // Domain defaults are prepended for managers
      expect(merged.briefing[0].source).toBe("direction");
      expect(merged.briefing[1].source).toBe("policies");
      // Agent briefing follows
      expect(merged.briefing[2].source).toBe("instructions");
      expect(merged.briefing[3].source).toBe("assigned_task");
    });

    it("does not prepend domain default briefing to non-manager agents", async () => {
      const { mergeDomainDefaults } = await import("../../src/config/init.js");

      const domainDefaults: DomainConfig["defaults"] = {
        briefing: [
          { source: "direction" },
          { source: "policies" },
        ],
      };

      const agentConfig = {
        extends: "employee" as const,
        briefing: [
          { source: "instructions" },
          { source: "assigned_task" },
        ],
        expectations: [
          { tool: "clawforce_task", action: "transition", min_calls: 1 },
        ],
        performance_policy: { action: "retry" as const, max_retries: 3 },
      };

      const merged = mergeDomainDefaults(agentConfig, domainDefaults);

      // Non-managers don't get domain default briefing prepended
      expect(merged.briefing).toHaveLength(2);
      expect(merged.briefing[0].source).toBe("instructions");
      expect(merged.briefing[1].source).toBe("assigned_task");
    });

    it("appends domain default expectations to agent expectations", async () => {
      const { mergeDomainDefaults } = await import("../../src/config/init.js");

      const domainDefaults: DomainConfig["defaults"] = {
        expectations: [
          { tool: "clawforce_log", action: "write", min_calls: 1 },
        ],
      };

      const agentConfig = {
        extends: "employee",
        briefing: [{ source: "instructions" }],
        expectations: [
          { tool: "clawforce_task", action: "transition", min_calls: 1 },
        ],
        performance_policy: { action: "alert" as const },
      };

      const merged = mergeDomainDefaults(agentConfig, domainDefaults);

      // Agent expectations come first
      expect(merged.expectations[0].tool).toBe("clawforce_task");
      // Domain defaults appended
      expect(merged.expectations[1].tool).toBe("clawforce_log");
    });

    it("uses domain default performance_policy when agent has none explicitly", async () => {
      const { mergeDomainDefaults } = await import("../../src/config/init.js");

      const domainDefaults: DomainConfig["defaults"] = {
        performance_policy: { action: "retry", max_retries: 5 },
      };

      // Agent with inherited (preset) performance_policy — not explicitly set
      const agentConfig = {
        extends: "employee",
        briefing: [{ source: "instructions" }],
        expectations: [],
        performance_policy: { action: "alert" as const },
      };

      const merged = mergeDomainDefaults(agentConfig, domainDefaults);

      // Domain default is used
      expect(merged.performance_policy).toEqual({ action: "retry", max_retries: 5 });
    });

    it("does not duplicate briefing sources already present in manager config", async () => {
      const { mergeDomainDefaults } = await import("../../src/config/init.js");

      const domainDefaults: DomainConfig["defaults"] = {
        briefing: [
          { source: "instructions" },
          { source: "direction" },
        ],
      };

      const agentConfig = {
        extends: "manager" as const,
        coordination: { enabled: true },
        briefing: [
          { source: "instructions" },
          { source: "assigned_task" },
        ],
        expectations: [],
        performance_policy: { action: "alert" as const },
      };

      const merged = mergeDomainDefaults(agentConfig, domainDefaults);

      // "instructions" should not be duplicated
      const instructionCount = merged.briefing.filter(s => s.source === "instructions").length;
      expect(instructionCount).toBe(1);
      // "direction" should be prepended
      expect(merged.briefing[0].source).toBe("direction");
    });

    it("returns agent config unchanged when no domain defaults", async () => {
      const { mergeDomainDefaults } = await import("../../src/config/init.js");

      const agentConfig = {
        extends: "employee",
        briefing: [{ source: "instructions" }],
        expectations: [{ tool: "clawforce_task", action: "transition", min_calls: 1 }],
        performance_policy: { action: "alert" as const },
      };

      const merged = mergeDomainDefaults(agentConfig, undefined);

      expect(merged.briefing).toEqual(agentConfig.briefing);
      expect(merged.expectations).toEqual(agentConfig.expectations);
      expect(merged.performance_policy).toEqual(agentConfig.performance_policy);
    });

    it("handles empty defaults object", async () => {
      const { mergeDomainDefaults } = await import("../../src/config/init.js");

      const agentConfig = {
        extends: "employee",
        briefing: [{ source: "instructions" }],
        expectations: [],
        performance_policy: { action: "alert" as const },
      };

      const merged = mergeDomainDefaults(agentConfig, {});

      expect(merged.briefing).toEqual(agentConfig.briefing);
      expect(merged.expectations).toEqual(agentConfig.expectations);
      expect(merged.performance_policy).toEqual(agentConfig.performance_policy);
    });
  });
});
