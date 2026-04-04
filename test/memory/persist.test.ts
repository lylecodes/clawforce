import { describe, expect, it } from "vitest";
import {
  shouldPersistMemory,
  getExtractionPrompt,
  getEffectivePersistRules,
  isExternalMemoryProvider,
} from "../../src/memory/persist.js";
import type { AgentConfig, MemoryPersistRule } from "../../src/types.js";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    briefing: [],
    expectations: [],
    performance_policy: { action: "alert" },
    ...overrides,
  };
}

describe("shouldPersistMemory", () => {
  it("returns default rule for session_end when no config is set", () => {
    const config = makeAgentConfig();
    const rules = shouldPersistMemory("session_end", config);
    expect(rules).toHaveLength(1);
    expect(rules[0].trigger).toBe("session_end");
    expect(rules[0].action).toBe("extract_learnings");
  });

  it("returns empty for non-session_end triggers when no rules configured", () => {
    const config = makeAgentConfig();
    const rules = shouldPersistMemory("task_completed", config);
    expect(rules).toHaveLength(0);
  });

  it("returns empty when persist.enabled is false", () => {
    const config = makeAgentConfig({
      memory: { persist: { enabled: false } },
    });
    const rules = shouldPersistMemory("session_end", config);
    expect(rules).toHaveLength(0);
  });

  it("returns empty when autoExtract is false and no rules", () => {
    const config = makeAgentConfig({
      memory: { persist: { autoExtract: false } },
    });
    const rules = shouldPersistMemory("session_end", config);
    expect(rules).toHaveLength(0);
  });

  it("returns matching rules from configured rules", () => {
    const config = makeAgentConfig({
      memory: {
        persist: {
          rules: [
            { trigger: "session_end", action: "extract_learnings" },
            { trigger: "task_completed", action: "save_decisions" },
            { trigger: "task_failed", action: "save_errors" },
          ],
        },
      },
    });

    const sessionRules = shouldPersistMemory("session_end", config);
    expect(sessionRules).toHaveLength(1);
    expect(sessionRules[0].action).toBe("extract_learnings");

    const completedRules = shouldPersistMemory("task_completed", config);
    expect(completedRules).toHaveLength(1);
    expect(completedRules[0].action).toBe("save_decisions");

    const failedRules = shouldPersistMemory("task_failed", config);
    expect(failedRules).toHaveLength(1);
    expect(failedRules[0].action).toBe("save_errors");
  });

  it("returns multiple matching rules for the same trigger", () => {
    const config = makeAgentConfig({
      memory: {
        persist: {
          rules: [
            { trigger: "session_end", action: "extract_learnings" },
            { trigger: "session_end", action: "save_decisions" },
          ],
        },
      },
    });

    const rules = shouldPersistMemory("session_end", config);
    expect(rules).toHaveLength(2);
  });

  it("returns empty for periodic trigger when no periodic rules configured", () => {
    const config = makeAgentConfig({
      memory: {
        persist: {
          rules: [
            { trigger: "session_end", action: "extract_learnings" },
          ],
        },
      },
    });
    expect(shouldPersistMemory("periodic", config)).toHaveLength(0);
  });
});

describe("getExtractionPrompt", () => {
  it("returns built-in prompt for extract_learnings", () => {
    const config = makeAgentConfig();
    const rule: MemoryPersistRule = { trigger: "session_end", action: "extract_learnings" };
    const prompt = getExtractionPrompt(rule, config);
    expect(prompt).toContain("Extract key learnings");
  });

  it("returns built-in prompt for save_decisions", () => {
    const config = makeAgentConfig();
    const rule: MemoryPersistRule = { trigger: "session_end", action: "save_decisions" };
    const prompt = getExtractionPrompt(rule, config);
    expect(prompt).toContain("Extract decisions");
  });

  it("returns built-in prompt for save_errors", () => {
    const config = makeAgentConfig();
    const rule: MemoryPersistRule = { trigger: "task_failed", action: "save_errors" };
    const prompt = getExtractionPrompt(rule, config);
    expect(prompt).toContain("Extract errors");
  });

  it("returns custom prompt for custom action", () => {
    const config = makeAgentConfig();
    const rule: MemoryPersistRule = {
      trigger: "session_end",
      action: "custom",
      prompt: "Summarize this conversation for future reference.",
    };
    const prompt = getExtractionPrompt(rule, config);
    expect(prompt).toBe("Summarize this conversation for future reference.");
  });

  it("returns fallback prompt for custom action without prompt", () => {
    const config = makeAgentConfig();
    const rule: MemoryPersistRule = { trigger: "session_end", action: "custom" };
    const prompt = getExtractionPrompt(rule, config);
    expect(prompt).toContain("Extract relevant information");
  });

  it("uses agent-level extractPrompt override for extract_learnings", () => {
    const config = makeAgentConfig({
      memory: {
        persist: {
          extractPrompt: "Custom extraction prompt for this agent.",
        },
      },
    });
    const rule: MemoryPersistRule = { trigger: "session_end", action: "extract_learnings" };
    const prompt = getExtractionPrompt(rule, config);
    expect(prompt).toBe("Custom extraction prompt for this agent.");
  });

  it("does not use extractPrompt override for non-extract_learnings actions", () => {
    const config = makeAgentConfig({
      memory: {
        persist: {
          extractPrompt: "Custom extraction prompt.",
        },
      },
    });
    const rule: MemoryPersistRule = { trigger: "session_end", action: "save_decisions" };
    const prompt = getExtractionPrompt(rule, config);
    expect(prompt).toContain("Extract decisions");
    expect(prompt).not.toBe("Custom extraction prompt.");
  });
});

describe("getEffectivePersistRules", () => {
  it("returns default rules when no config set", () => {
    const config = makeAgentConfig();
    const rules = getEffectivePersistRules(config);
    expect(rules).toHaveLength(1);
    expect(rules[0].trigger).toBe("session_end");
    expect(rules[0].action).toBe("extract_learnings");
  });

  it("returns empty when persist is disabled", () => {
    const config = makeAgentConfig({
      memory: { persist: { enabled: false } },
    });
    expect(getEffectivePersistRules(config)).toHaveLength(0);
  });

  it("returns configured rules when present", () => {
    const config = makeAgentConfig({
      memory: {
        persist: {
          rules: [
            { trigger: "task_completed", action: "save_decisions" },
            { trigger: "task_failed", action: "save_errors" },
          ],
        },
      },
    });
    const rules = getEffectivePersistRules(config);
    expect(rules).toHaveLength(2);
  });

  it("returns empty when autoExtract is false and no rules", () => {
    const config = makeAgentConfig({
      memory: { persist: { autoExtract: false } },
    });
    expect(getEffectivePersistRules(config)).toHaveLength(0);
  });
});

describe("isExternalMemoryProvider", () => {
  it("returns false when no provider configured", () => {
    const config = makeAgentConfig();
    expect(isExternalMemoryProvider(config)).toBe(false);
  });

  it("returns false for builtin provider", () => {
    const config = makeAgentConfig({
      memory: { provider: { type: "builtin" } },
    });
    expect(isExternalMemoryProvider(config)).toBe(false);
  });

  it("returns true for mcp provider", () => {
    const config = makeAgentConfig({
      memory: {
        provider: {
          type: "mcp",
          mcp: { server: "memory-server", tools: ["recall", "retain"] },
        },
      },
    });
    expect(isExternalMemoryProvider(config)).toBe(true);
  });
});
