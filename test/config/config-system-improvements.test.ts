/**
 * Phase 1 config system improvements tests.
 *
 * Tests for:
 * 1. Team-level defaults (team_templates)
 * 2. Briefing composition operators (+/-/~)
 * 3. Role defaults
 * 4. Enhanced semantic config validation
 */

import { describe, expect, it } from "vitest";
import type { DomainConfig, GlobalConfig } from "../../src/config/schema.js";
import { validateGlobalConfig } from "../../src/config/schema.js";
import type { AgentConfig, WorkforceConfig } from "../../src/types.js";
import {
  resolveConfig,
  mergeArrayWithOperators,
  mergeBriefingWithOperators,
  mergeConfigLayer,
  BUILTIN_AGENT_PRESETS,
} from "../../src/presets.js";
import type { BriefingItem } from "../../src/presets.js";

// ============================================================
// 1. Team-level defaults (team_templates)
// ============================================================

describe("team_templates", () => {
  describe("type definitions", () => {
    it("GlobalConfig accepts team_templates", () => {
      const config: GlobalConfig = {
        agents: {
          "sales-rep": { extends: "employee", team: "sales" },
        },
        team_templates: {
          sales: {
            persona: "You are a sales team member focused on lead generation.",
            skillCap: 6,
          },
        },
      };

      expect(config.team_templates).toBeDefined();
      expect(config.team_templates!.sales).toBeDefined();
      expect(config.team_templates!.sales.persona).toContain("sales");
    });

    it("DomainConfig accepts team_templates", () => {
      const config: DomainConfig = {
        domain: "test",
        agents: ["sales-rep"],
        team_templates: {
          sales: {
            persona: "Sales-specific persona",
          },
        },
      };

      expect(config.team_templates).toBeDefined();
    });

    it("WorkforceConfig accepts team_templates", () => {
      const config: WorkforceConfig = {
        name: "test",
        agents: {},
        team_templates: {
          engineering: {
            skillCap: 10,
            briefing: [{ source: "project_md" }],
          },
        },
      };

      expect(config.team_templates).toBeDefined();
      expect(config.team_templates!.engineering).toBeDefined();
    });
  });

  describe("schema validation", () => {
    it("validates config with team_templates", () => {
      const result = validateGlobalConfig({
        agents: { rep: { extends: "employee" } },
        team_templates: { sales: { persona: "Sales agent" } },
      });
      expect(result.valid).toBe(true);
    });

    it("rejects non-object team_templates", () => {
      const result = validateGlobalConfig({
        agents: { rep: { extends: "employee" } },
        team_templates: "invalid",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === "team_templates")).toBe(true);
    });

    it("passes when team_templates is not specified", () => {
      const result = validateGlobalConfig({
        agents: { rep: { extends: "employee" } },
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("config resolution via buildWorkforceConfig", () => {
    it("applies team template defaults to agent with matching team", async () => {
      const { mergeDomainDefaults } = await import("../../src/config/init.js");

      // Simulate what buildWorkforceConfig does after resolving preset + team template
      const baseConfig: AgentConfig = {
        extends: "employee",
        team: "sales",
        briefing: [{ source: "soul" }, { source: "assigned_task" }],
        expectations: [],
        performance_policy: { action: "retry", max_retries: 3 },
      };

      // Team template would be merged via mergeConfigLayer
      const teamTemplate = {
        persona: "You are a sales team member.",
        skillCap: 6,
      };

      const merged = mergeConfigLayer(baseConfig as Record<string, unknown>, teamTemplate);
      expect(merged.persona).toBe("You are a sales team member.");
      expect(merged.skillCap).toBe(6);
      // Original fields preserved
      expect(merged.team).toBe("sales");
      expect(merged.extends).toBe("employee");
    });

    it("agent overrides take precedence over team template", () => {
      const base = {
        extends: "employee",
        team: "sales",
        persona: "Custom persona",
        skillCap: 5,
        briefing: [{ source: "soul" }],
        expectations: [],
        performance_policy: { action: "retry" },
      };

      const teamTemplate = {
        persona: "Team persona",
        skillCap: 10,
      };

      // Apply team template first, then agent overrides
      const withTemplate = mergeConfigLayer(base as Record<string, unknown>, teamTemplate);
      // In the actual flow, agent overrides are re-applied on top
      const agentOverrides = { persona: "Custom persona", skillCap: 5 };
      const final = mergeConfigLayer(withTemplate, agentOverrides);

      expect(final.persona).toBe("Custom persona");
      expect(final.skillCap).toBe(5);
    });
  });
});

// ============================================================
// 2. Briefing composition operators (+/-/~)
// ============================================================

describe("briefing composition operators", () => {
  describe("mergeBriefingWithOperators", () => {
    it("plain array replaces parent (no operators)", () => {
      const parent: BriefingItem[] = ["soul", "task_board", "escalations"];
      const child: BriefingItem[] = ["soul", "assigned_task"];

      const result = mergeBriefingWithOperators(parent, child);
      expect(result).toEqual(["soul", "assigned_task"]);
    });

    it("+ operator adds a source to parent", () => {
      const parent: BriefingItem[] = ["soul", "task_board"];
      const child: BriefingItem[] = ["+cost_summary", "+velocity"];

      const result = mergeBriefingWithOperators(parent, child);
      expect(result).toHaveLength(4);
      expect(getSourceNames(result)).toContain("soul");
      expect(getSourceNames(result)).toContain("task_board");
      expect(getSourceNames(result)).toContain("cost_summary");
      expect(getSourceNames(result)).toContain("velocity");
    });

    it("+ operator does not duplicate existing source", () => {
      const parent: BriefingItem[] = ["soul", "task_board"];
      const child: BriefingItem[] = ["+soul", "+cost_summary"];

      const result = mergeBriefingWithOperators(parent, child);
      const soulCount = getSourceNames(result).filter(n => n === "soul").length;
      expect(soulCount).toBe(1);
      expect(getSourceNames(result)).toContain("cost_summary");
    });

    it("- operator removes a source from parent", () => {
      const parent: BriefingItem[] = ["soul", "task_board", "escalations", "cost_summary"];
      const child: BriefingItem[] = ["-task_board", "-escalations"];

      const result = mergeBriefingWithOperators(parent, child);
      expect(getSourceNames(result)).toEqual(["soul", "cost_summary"]);
    });

    it("- operator is a no-op for non-existent source", () => {
      const parent: BriefingItem[] = ["soul", "task_board"];
      const child: BriefingItem[] = ["-nonexistent"];

      const result = mergeBriefingWithOperators(parent, child);
      expect(getSourceNames(result)).toEqual(["soul", "task_board"]);
    });

    it("~ operator overrides source in parent", () => {
      const parent: BriefingItem[] = [
        "soul",
        { source: "knowledge", filter: { category: ["docs"] } },
      ];
      const child: BriefingItem[] = [
        { source: "~knowledge", filter: { category: ["api"], tags: ["v2"] } },
      ];

      const result = mergeBriefingWithOperators(parent, child);
      expect(result).toHaveLength(2);
      const knowledge = result.find(
        (r) => (typeof r === "object" ? r.source : r) === "knowledge"
      ) as Record<string, unknown>;
      expect(knowledge).toBeDefined();
      expect(knowledge.filter).toEqual({ category: ["api"], tags: ["v2"] });
    });

    it("~ operator adds source if not in parent", () => {
      const parent: BriefingItem[] = ["soul"];
      const child: BriefingItem[] = [
        { source: "~knowledge", filter: { category: ["api"] } },
      ];

      const result = mergeBriefingWithOperators(parent, child);
      expect(result).toHaveLength(2);
      expect(getSourceNames(result)).toContain("knowledge");
    });

    it("mixed +/-/~ operators", () => {
      const parent: BriefingItem[] = [
        "soul",
        "task_board",
        "escalations",
        { source: "knowledge", filter: { category: ["all"] } },
      ];
      const child: BriefingItem[] = [
        "+cost_summary",
        "-escalations",
        { source: "~knowledge", filter: { category: ["code"] } },
      ];

      const result = mergeBriefingWithOperators(parent, child);
      expect(getSourceNames(result)).toContain("soul");
      expect(getSourceNames(result)).toContain("task_board");
      expect(getSourceNames(result)).not.toContain("escalations");
      expect(getSourceNames(result)).toContain("cost_summary");
      expect(getSourceNames(result)).toContain("knowledge");

      const knowledge = result.find(
        (r) => typeof r === "object" && r.source === "knowledge"
      ) as Record<string, unknown>;
      expect(knowledge.filter).toEqual({ category: ["code"] });
    });

    it("works with no parent (undefined)", () => {
      const child: BriefingItem[] = ["+soul", "+assigned_task"];
      const result = mergeBriefingWithOperators(undefined, child);
      expect(getSourceNames(result)).toEqual(["soul", "assigned_task"]);
    });

    it("works with empty parent", () => {
      const child: BriefingItem[] = ["+soul"];
      const result = mergeBriefingWithOperators([], child);
      expect(getSourceNames(result)).toEqual(["soul"]);
    });
  });

  describe("integration with preset resolution", () => {
    it("briefing operators work through resolveConfig", () => {
      const presets = {
        base_manager: {
          briefing: ["soul", "task_board", "escalations", "cost_summary"],
          performance_policy: { action: "retry" },
        },
      };

      const config = {
        extends: "base_manager",
        briefing: ["+velocity", "-escalations"],
      };

      const resolved = resolveConfig(config, presets);
      const briefing = resolved.briefing as BriefingItem[];
      const names = getSourceNames(briefing);

      expect(names).toContain("soul");
      expect(names).toContain("task_board");
      expect(names).toContain("cost_summary");
      expect(names).toContain("velocity");
      expect(names).not.toContain("escalations");
    });

    it("briefing operators work with builtin presets", () => {
      const config = {
        extends: "manager",
        briefing: ["+custom_stream", "-trust_scores"],
      };

      const resolved = resolveConfig(config, BUILTIN_AGENT_PRESETS);
      const briefing = resolved.briefing as BriefingItem[];
      const names = getSourceNames(briefing);

      expect(names).toContain("soul");
      expect(names).toContain("custom_stream");
      expect(names).not.toContain("trust_scores");
    });

    it("plain briefing array still replaces parent (backward compat)", () => {
      const config = {
        extends: "manager",
        briefing: ["soul", "assigned_task"],
      };

      const resolved = resolveConfig(config, BUILTIN_AGENT_PRESETS);
      const briefing = resolved.briefing as BriefingItem[];
      const names = getSourceNames(briefing);

      expect(names).toEqual(["soul", "assigned_task"]);
    });
  });
});

// ============================================================
// 3. Role defaults
// ============================================================

describe("role_defaults", () => {
  describe("type definitions", () => {
    it("DomainConfig accepts role_defaults", () => {
      const config: DomainConfig = {
        domain: "test",
        agents: ["lead", "worker"],
        role_defaults: {
          employee: {
            skillCap: 6,
            persona: "You are a focused worker.",
          },
          manager: {
            skillCap: 12,
          },
        },
      };

      expect(config.role_defaults).toBeDefined();
      expect(config.role_defaults!.employee).toBeDefined();
      expect(config.role_defaults!.manager).toBeDefined();
    });
  });

  describe("config resolution", () => {
    it("role defaults are applied based on extends field", () => {
      // Simulate the merge: preset resolved -> role defaults -> agent overrides
      const presetResolved = {
        extends: "employee",
        persona: "You are an employee agent responsible for executing assigned tasks.",
        briefing: [{ source: "soul" }, { source: "assigned_task" }],
        expectations: [],
        performance_policy: { action: "retry", max_retries: 3 },
        skillCap: 8,
      };

      const roleDefaults = {
        skillCap: 6,
        persona: "You are a focused worker bee.",
      };

      const result = mergeConfigLayer(presetResolved as Record<string, unknown>, roleDefaults);
      expect(result.skillCap).toBe(6);
      expect(result.persona).toBe("You are a focused worker bee.");
      // Other fields from preset preserved
      expect(result.extends).toBe("employee");
    });

    it("agent overrides take precedence over role defaults", () => {
      const presetResolved = {
        extends: "employee",
        persona: "Preset persona",
        skillCap: 8,
        briefing: [{ source: "soul" }],
        expectations: [],
        performance_policy: { action: "retry" },
      };

      const roleDefaults = {
        skillCap: 6,
        persona: "Role default persona",
      };

      const agentOverrides = {
        persona: "Agent-specific persona",
      };

      const withRoleDefaults = mergeConfigLayer(presetResolved as Record<string, unknown>, roleDefaults);
      const final = mergeConfigLayer(withRoleDefaults, agentOverrides);

      expect(final.persona).toBe("Agent-specific persona");
      expect(final.skillCap).toBe(6); // From role defaults (agent didn't override)
    });

    it("role defaults deep merge objects", () => {
      const presetResolved = {
        extends: "manager",
        coordination: { enabled: true, schedule: "*/30 * * * *" },
        briefing: [{ source: "soul" }],
        expectations: [],
        performance_policy: { action: "retry" },
      };

      const roleDefaults = {
        coordination: { schedule: "0 9 * * MON-FRI" },
      };

      const result = mergeConfigLayer(presetResolved as Record<string, unknown>, roleDefaults);
      expect((result.coordination as Record<string, unknown>).enabled).toBe(true);
      expect((result.coordination as Record<string, unknown>).schedule).toBe("0 9 * * MON-FRI");
    });
  });
});

// ============================================================
// 4. Enhanced semantic config validation
// ============================================================

describe("enhanced semantic config validation", () => {
  // Use dynamic import to avoid DB initialization issues
  const importValidator = () => import("../../src/config-validator.js");

  describe("team_template reference validation", () => {
    it("suggests when agent has team but no matching team_template", async () => {
      const { validateWorkforceConfig } = await importValidator();

      const config: WorkforceConfig = {
        name: "test",
        agents: {
          rep: {
            extends: "employee",
            team: "sales",
            briefing: [{ source: "soul" }],
            expectations: [],
            performance_policy: { action: "alert" },
          },
        },
        team_templates: {
          engineering: { skillCap: 10 },
        },
      };

      const warnings = validateWorkforceConfig(config);
      expect(warnings.some(w =>
        w.level === "suggest" &&
        w.agentId === "rep" &&
        w.message.includes("sales") &&
        w.message.includes("team_template"),
      )).toBe(true);
    });

    it("suggests when team_template is defined but no agent uses it", async () => {
      const { validateWorkforceConfig } = await importValidator();

      const config: WorkforceConfig = {
        name: "test",
        agents: {
          rep: {
            extends: "employee",
            team: "sales",
            briefing: [{ source: "soul" }],
            expectations: [],
            performance_policy: { action: "alert" },
          },
        },
        team_templates: {
          sales: { skillCap: 6 },
          marketing: { skillCap: 8 },
        },
      };

      const warnings = validateWorkforceConfig(config);
      expect(warnings.some(w =>
        w.level === "suggest" &&
        w.message.includes("marketing") &&
        w.message.includes("no agent"),
      )).toBe(true);
      // sales is used, should NOT be flagged
      expect(warnings.some(w =>
        w.level === "suggest" &&
        w.message.includes('"sales"') &&
        w.message.includes("no agent"),
      )).toBe(false);
    });

    it("no warnings when team matches team_template", async () => {
      const { validateWorkforceConfig } = await importValidator();

      const config: WorkforceConfig = {
        name: "test",
        agents: {
          rep: {
            extends: "employee",
            team: "sales",
            briefing: [{ source: "soul" }],
            expectations: [],
            performance_policy: { action: "alert" },
          },
        },
        team_templates: {
          sales: { skillCap: 6 },
        },
      };

      const warnings = validateWorkforceConfig(config);
      const teamWarnings = warnings.filter(w =>
        w.message.includes("team_template") || w.message.includes("team_templates"),
      );
      expect(teamWarnings).toHaveLength(0);
    });
  });

  describe("expectation/tool cross-reference validation", () => {
    it("warns when expectation references tool not in allowedTools", async () => {
      const { validateWorkforceConfig } = await importValidator();

      const config: WorkforceConfig = {
        name: "test",
        agents: {
          worker: {
            extends: "employee",
            allowedTools: ["Bash", "Read"],
            briefing: [{ source: "soul" }],
            expectations: [
              { tool: "Edit", action: "edit", min_calls: 1 },
            ],
            performance_policy: { action: "alert" },
          },
        },
      };

      const warnings = validateWorkforceConfig(config);
      expect(warnings.some(w =>
        w.level === "warn" &&
        w.agentId === "worker" &&
        w.message.includes("Edit") &&
        w.message.includes("allowedTools"),
      )).toBe(true);
    });

    it("does not warn for clawforce_ tools (always available)", async () => {
      const { validateWorkforceConfig } = await importValidator();

      const config: WorkforceConfig = {
        name: "test",
        agents: {
          worker: {
            extends: "employee",
            allowedTools: ["Bash", "Read"],
            briefing: [{ source: "soul" }],
            expectations: [
              { tool: "clawforce_log", action: "write", min_calls: 1 },
              { tool: "clawforce_task", action: "transition", min_calls: 1 },
            ],
            performance_policy: { action: "alert" },
          },
        },
      };

      const warnings = validateWorkforceConfig(config);
      const toolWarnings = warnings.filter(w =>
        w.message.includes("allowedTools"),
      );
      expect(toolWarnings).toHaveLength(0);
    });

    it("does not warn for memory_ tools (always available)", async () => {
      const { validateWorkforceConfig } = await importValidator();

      const config: WorkforceConfig = {
        name: "test",
        agents: {
          worker: {
            extends: "employee",
            allowedTools: ["Bash"],
            briefing: [{ source: "soul" }],
            expectations: [
              { tool: "memory_search", action: "search", min_calls: 1 },
            ],
            performance_policy: { action: "alert" },
          },
        },
      };

      const warnings = validateWorkforceConfig(config);
      const toolWarnings = warnings.filter(w =>
        w.message.includes("allowedTools"),
      );
      expect(toolWarnings).toHaveLength(0);
    });

    it("does not warn when allowedTools is not set", async () => {
      const { validateWorkforceConfig } = await importValidator();

      const config: WorkforceConfig = {
        name: "test",
        agents: {
          worker: {
            extends: "employee",
            briefing: [{ source: "soul" }],
            expectations: [
              { tool: "Edit", action: "edit", min_calls: 1 },
            ],
            performance_policy: { action: "alert" },
          },
        },
      };

      const warnings = validateWorkforceConfig(config);
      const toolWarnings = warnings.filter(w =>
        w.message.includes("allowedTools"),
      );
      expect(toolWarnings).toHaveLength(0);
    });

    it("warns when codex agents exclude Bash from allowedTools", async () => {
      const { validateWorkforceConfig } = await importValidator();

      const config: WorkforceConfig = {
        name: "test",
        adapter: "codex",
        agents: {
          worker: {
            extends: "employee",
            allowedTools: ["Read", "Edit", "Write"],
            briefing: [{ source: "soul" }],
            expectations: [],
            performance_policy: { action: "alert" },
          },
        },
      };

      const warnings = validateWorkforceConfig(config);
      expect(warnings.some((warning) =>
        warning.level === "warn"
        && warning.agentId === "worker"
        && warning.message.includes('excludes "Bash"')
        && warning.message.includes("direct Codex executor"),
      )).toBe(true);
    });
  });

  describe("role_defaults domain quality validation", () => {
    it("warns when role_defaults references unknown role", async () => {
      const { validateDomainQuality } = await importValidator();

      const domain: DomainConfig = {
        domain: "test",
        agents: ["lead"],
        role_defaults: {
          custom_role: { skillCap: 5 },
        },
      };

      const results = validateDomainQuality(domain);
      expect(results.some(r =>
        r.level === "warn" &&
        r.message.includes("custom_role") &&
        r.message.includes("role_defaults"),
      )).toBe(true);
    });

    it("does not warn for known roles in role_defaults", async () => {
      const { validateDomainQuality } = await importValidator();

      const domain: DomainConfig = {
        domain: "test",
        agents: ["lead"],
        role_defaults: {
          employee: { skillCap: 6 },
          manager: { skillCap: 12 },
          verifier: { skillCap: 4 },
        },
      };

      const results = validateDomainQuality(domain);
      const roleWarnings = results.filter(r =>
        r.message.includes("role_defaults"),
      );
      expect(roleWarnings).toHaveLength(0);
    });
  });

  describe("team_templates domain quality validation", () => {
    it("errors when team_template contains model (runtime setting)", async () => {
      const { validateDomainQuality } = await importValidator();

      const domain: DomainConfig = {
        domain: "test",
        agents: ["worker"],
        team_templates: {
          engineering: { model: "gpt-4" } as any,
        },
      };

      const results = validateDomainQuality(domain);
      expect(results.some(r =>
        r.level === "error" &&
        r.message.includes("engineering") &&
        r.message.includes("model"),
      )).toBe(true);
    });
  });
});

// ============================================================
// mergeConfigLayer (used by team_templates and role_defaults)
// ============================================================

describe("mergeConfigLayer", () => {
  it("merges flat fields", () => {
    const base = { a: 1, b: "hello" };
    const layer = { b: "world", c: true };
    const result = mergeConfigLayer(base, layer);
    expect(result).toEqual({ a: 1, b: "world", c: true });
  });

  it("deep merges objects", () => {
    const base = { nested: { x: 1, y: 2 } };
    const layer = { nested: { y: 3, z: 4 } };
    const result = mergeConfigLayer(base, layer);
    expect(result.nested).toEqual({ x: 1, y: 3, z: 4 });
  });

  it("handles briefing with operators", () => {
    const base = { briefing: ["soul", "task_board", "escalations"] };
    const layer = { briefing: ["+cost_summary", "-escalations"] };
    const result = mergeConfigLayer(base, layer);
    const names = getSourceNames(result.briefing as BriefingItem[]);
    expect(names).toContain("soul");
    expect(names).toContain("task_board");
    expect(names).toContain("cost_summary");
    expect(names).not.toContain("escalations");
  });

  it("handles plain briefing replacement", () => {
    const base = { briefing: ["soul", "task_board"] };
    const layer = { briefing: ["soul", "assigned_task"] };
    const result = mergeConfigLayer(base, layer);
    const names = getSourceNames(result.briefing as BriefingItem[]);
    expect(names).toEqual(["soul", "assigned_task"]);
  });
});

// ============================================================
// Backward compatibility
// ============================================================

describe("backward compatibility", () => {
  it("existing configs without team_templates or role_defaults work unchanged", () => {
    const config = {
      extends: "manager",
      title: "Lead",
    };
    const resolved = resolveConfig(config, BUILTIN_AGENT_PRESETS);

    // All standard manager preset fields should be present
    expect(resolved.compaction).toBe(true);
    expect(resolved.coordination).toEqual({ enabled: true, schedule: "*/30 * * * *" });
    expect(resolved.title).toBe("Lead");
  });

  it("existing mergeArrayWithOperators still works for non-briefing arrays", () => {
    const result = mergeArrayWithOperators(["a", "b", "c"], ["+d", "-b"]);
    expect(result).toEqual(["a", "c", "d"]);
  });

  it("plain briefing arrays still replace parent", () => {
    const presets = {
      base: {
        briefing: ["soul", "task_board", "escalations"],
      },
    };
    const config = {
      extends: "base",
      briefing: ["soul", "assigned_task"],
    };
    const resolved = resolveConfig(config, presets);
    expect(resolved.briefing).toEqual(["soul", "assigned_task"]);
  });

  it("WorkforceConfig without new fields validates cleanly", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const config: WorkforceConfig = {
      name: "test",
      agents: {
        lead: {
          extends: "manager",
          briefing: [{ source: "soul" }, { source: "task_board" }],
          expectations: [
            { tool: "clawforce_log", action: "write", min_calls: 1 },
          ],
          performance_policy: { action: "retry", max_retries: 2 },
          coordination: { enabled: true },
        },
      },
    };

    const warnings = validateWorkforceConfig(config);
    const errors = warnings.filter(w => w.level === "error");
    expect(errors).toHaveLength(0);
  });
});

// ============================================================
// Helpers
// ============================================================

function getSourceNames(items: BriefingItem[]): string[] {
  return items.map((item) => {
    if (typeof item === "string") return item;
    return item.source;
  });
}
