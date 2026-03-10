import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyProfile,
  BUILTIN_PROFILES,
  CRITICAL_SOURCES,
  DEFAULT_ACTION_SCOPES,
  ROLE_DEFAULTS,
  generateDefaultScopePolicies,
  getToolNamesFromScope,
  getAllowedActionsForTool,
} from "../../src/profiles.js";
import { validateWorkforceConfig } from "../../src/config-validator.js";
import {
  loadWorkforceConfig,
  resetEnforcementConfigForTest,
} from "../../src/project.js";

describe("assistant profile", () => {
  it("exists in BUILTIN_PROFILES", () => {
    expect(BUILTIN_PROFILES.assistant).toBeDefined();
  });

  it("has communication-focused briefing sources", () => {
    const sources = BUILTIN_PROFILES.assistant.briefing.map((s) => s.source);
    expect(sources).toContain("soul");
    expect(sources).toContain("tools_reference");
    expect(sources).toContain("pending_messages");
    expect(sources).toContain("channel_messages");
    expect(sources).toContain("memory");
    expect(sources).toContain("skill");
    // Should NOT include org/management sources
    expect(sources).not.toContain("task_board");
    expect(sources).not.toContain("escalations");
    expect(sources).not.toContain("workflows");
    expect(sources).not.toContain("sweep_status");
    expect(sources).not.toContain("goal_hierarchy");
  });

  it("has empty expectations (no compliance enforcement)", () => {
    expect(BUILTIN_PROFILES.assistant.expectations).toEqual([]);
  });

  it("defaults to alert performance policy", () => {
    expect(BUILTIN_PROFILES.assistant.performance_policy.action).toBe("alert");
  });

  it("has compaction enabled", () => {
    expect(BUILTIN_PROFILES.assistant.compaction).toBe(true);
  });

  it("has no critical sources", () => {
    expect(CRITICAL_SOURCES.assistant).toBeUndefined();
  });
});

describe("assistant role defaults", () => {
  it("has title and persona", () => {
    expect(ROLE_DEFAULTS.assistant.title).toBe("Personal Assistant");
    expect(ROLE_DEFAULTS.assistant.persona).toContain("personal assistant");
  });
});

describe("assistant action scope", () => {
  it("has communication and memory tools", () => {
    const scope = DEFAULT_ACTION_SCOPES.assistant;
    const tools = getToolNamesFromScope(scope);
    expect(tools).toContain("clawforce_log");
    expect(tools).toContain("clawforce_setup");
    expect(tools).toContain("clawforce_context");
    expect(tools).toContain("clawforce_message");
    expect(tools).toContain("clawforce_channel");
    expect(tools).toContain("memory_search");
    expect(tools).toContain("memory_get");
  });

  it("excludes management tools", () => {
    const scope = DEFAULT_ACTION_SCOPES.assistant;
    const tools = getToolNamesFromScope(scope);
    expect(tools).not.toContain("clawforce_task");
    expect(tools).not.toContain("clawforce_ops");
    expect(tools).not.toContain("clawforce_workflow");
    expect(tools).not.toContain("clawforce_verify");
    expect(tools).not.toContain("clawforce_compact");
    expect(tools).not.toContain("clawforce_goal");
  });

  it("has restricted log actions (no verify_audit)", () => {
    const actions = getAllowedActionsForTool(DEFAULT_ACTION_SCOPES.assistant, "clawforce_log");
    expect(Array.isArray(actions)).toBe(true);
    expect(actions).toContain("write");
    expect(actions).toContain("outcome");
    expect(actions).not.toContain("verify_audit");
  });

  it("generates default scope policy for assistant", () => {
    const policies = generateDefaultScopePolicies({
      helper: { extends: "assistant" } as any,
    });
    expect(policies).toHaveLength(1);
    expect(policies[0]!.target).toBe("helper");
    expect(policies[0]!.type).toBe("action_scope");
    const allowed = policies[0]!.config.allowed_tools as Record<string, unknown>;
    expect(allowed.clawforce_message).toBeDefined();
    expect(allowed.clawforce_task).toBeUndefined();
  });
});

describe("assistant applyProfile", () => {
  it("inherits assistant briefing baseline", () => {
    const result = applyProfile("assistant", {
      briefing: [],
      exclude_briefing: [],
      expectations: null,
      performance_policy: null,
    });

    const sources = result.briefing.map((s) => s.source);
    expect(sources).toContain("soul");
    expect(sources).toContain("pending_messages");
    expect(sources).toContain("channel_messages");
    expect(sources).toContain("memory");
  });

  it("inherits empty expectations when agent provides null", () => {
    const result = applyProfile("assistant", {
      briefing: [],
      exclude_briefing: [],
      expectations: null,
      performance_policy: null,
    });

    expect(result.expectations).toEqual([]);
  });

  it("merges user sources on top of baseline", () => {
    const result = applyProfile("assistant", {
      briefing: [{ source: "custom", content: "Be helpful." }],
      exclude_briefing: [],
      expectations: null,
      performance_policy: null,
    });

    expect(result.briefing).toHaveLength(8); // 7 baseline + 1 custom
    expect(result.briefing[result.briefing.length - 1]!.source).toBe("custom");
  });
});

describe("assistant config validation", () => {
  it("does not warn about empty expectations for assistant", () => {
    const warnings = validateWorkforceConfig({
      name: "test",
      agents: {
        helper: {
          extends: "assistant",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    });

    expect(warnings.some((w) => w.message.includes("no expectations"))).toBe(false);
  });

  it("does not warn about compaction without expectation for assistant", () => {
    const warnings = validateWorkforceConfig({
      name: "test",
      agents: {
        helper: {
          extends: "assistant",
          briefing: [{ source: "file", path: "/tmp/test.md" }],
          expectations: [],
          performance_policy: { action: "alert" },
          compaction: true,
        },
      },
    });

    expect(warnings.some((w) => w.message.includes("clawforce_compact"))).toBe(false);
  });

  it("still warns about other issues for assistant", () => {
    const warnings = validateWorkforceConfig({
      name: "test",
      agents: {
        helper: {
          extends: "assistant",
          briefing: [{ source: "file" }], // missing path
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    });

    expect(warnings.some((w) => w.level === "error" && w.message.includes("path"))).toBe(true);
  });
});

describe("assistant config loading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-assistant-test-"));
    resetEnforcementConfigForTest();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetEnforcementConfigForTest();
  });

  function writeYaml(content: string): string {
    const p = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("loads assistant agent from project.yaml", () => {
    const configPath = writeYaml(`
name: personal
agents:
  helper:
    role: assistant
`);

    const config = loadWorkforceConfig(configPath);
    expect(config).toBeDefined();
    const helper = config!.agents.helper!;
    expect(helper.extends).toBe("assistant");
    // instructions (auto-injected) + 7 assistant baseline
    expect(helper.briefing).toHaveLength(8);
    expect(helper.briefing[0]!.source).toBe("instructions");
    expect(helper.expectations).toEqual([]);
    expect(helper.performance_policy.action).toBe("alert");
  });

  it("validates assistant config without errors", () => {
    const configPath = writeYaml(`
name: personal
agents:
  helper:
    role: assistant
`);

    const config = loadWorkforceConfig(configPath);
    const warnings = validateWorkforceConfig(config!);
    const errors = warnings.filter((w) => w.level === "error");
    expect(errors).toHaveLength(0);
  });
});
