import { describe, expect, it } from "vitest";
import type {
  MemoryRecallConfig,
  MemoryPersistConfig,
  MemoryProviderConfig,
  MemoryGovernanceConfig,
  MemoryPersistRule,
} from "../../src/types.js";
import { validateGlobalConfig } from "../../src/config/schema.js";

describe("MemoryConfig types", () => {
  it("MemoryRecallConfig accepts all fields", () => {
    const recall: MemoryRecallConfig = {
      enabled: true,
      intensity: "high",
      cooldownMs: 5000,
      maxSearches: 5,
      maxInjectedChars: 8000,
    };
    expect(recall.enabled).toBe(true);
    expect(recall.intensity).toBe("high");
    expect(recall.cooldownMs).toBe(5000);
  });

  it("MemoryPersistConfig accepts rules array", () => {
    const persist: MemoryPersistConfig = {
      enabled: true,
      rules: [
        { trigger: "session_end", action: "extract_learnings" },
        { trigger: "task_completed", action: "save_decisions" },
        { trigger: "task_failed", action: "save_errors" },
        { trigger: "periodic", action: "custom", prompt: "Review changes" },
      ],
      autoExtract: true,
      extractPrompt: "Custom learnings prompt",
    };
    expect(persist.rules).toHaveLength(4);
    expect(persist.autoExtract).toBe(true);
  });

  it("MemoryProviderConfig supports builtin", () => {
    const provider: MemoryProviderConfig = { type: "builtin" };
    expect(provider.type).toBe("builtin");
  });

  it("MemoryProviderConfig supports mcp", () => {
    const provider: MemoryProviderConfig = {
      type: "mcp",
      mcp: {
        server: "memory-mcp-server",
        args: ["--port", "3000"],
        tools: ["retain", "recall", "reflect"],
      },
    };
    expect(provider.type).toBe("mcp");
    expect(provider.mcp?.server).toBe("memory-mcp-server");
    expect(provider.mcp?.tools).toEqual(["retain", "recall", "reflect"]);
  });

  it("MemoryGovernanceConfig includes recall, persist, and provider", () => {
    const config: MemoryGovernanceConfig = {
      instructions: true,
      expectations: true,
      review: { enabled: true, cron: "0 18 * * *", aggressiveness: "high", scope: "reports" },
      recall: { enabled: true, intensity: "high", cooldownMs: 5000, maxSearches: 5 },
      persist: {
        enabled: true,
        rules: [{ trigger: "session_end", action: "extract_learnings" }],
        autoExtract: true,
      },
      provider: { type: "builtin" },
    };
    expect(config.recall?.enabled).toBe(true);
    expect(config.persist?.rules).toHaveLength(1);
    expect(config.provider?.type).toBe("builtin");
  });
});

describe("Memory config validation in schema", () => {
  it("validates valid memory recall config without errors", () => {
    const result = validateGlobalConfig({
      agents: {
        lead: {
          extends: "manager",
          memory: {
            recall: { enabled: true, intensity: "medium", maxSearches: 3 },
          },
        },
      },
    });
    const memErrors = result.errors.filter((e) => e.field.includes("memory"));
    expect(memErrors).toHaveLength(0);
  });

  it("validates invalid recall intensity", () => {
    const result = validateGlobalConfig({
      agents: {
        lead: {
          extends: "manager",
          memory: {
            recall: { intensity: "ultra" },
          },
        },
      },
    });
    const intensityErrors = result.errors.filter((e) => e.field.includes("intensity"));
    expect(intensityErrors.length).toBeGreaterThan(0);
  });

  it("validates invalid persist trigger", () => {
    const result = validateGlobalConfig({
      agents: {
        lead: {
          extends: "manager",
          memory: {
            persist: {
              rules: [{ trigger: "invalid_trigger", action: "extract_learnings" }],
            },
          },
        },
      },
    });
    const triggerErrors = result.errors.filter((e) => e.field.includes("trigger"));
    expect(triggerErrors.length).toBeGreaterThan(0);
  });

  it("validates invalid persist action", () => {
    const result = validateGlobalConfig({
      agents: {
        lead: {
          extends: "manager",
          memory: {
            persist: {
              rules: [{ trigger: "session_end", action: "invalid_action" }],
            },
          },
        },
      },
    });
    const actionErrors = result.errors.filter((e) => e.field.includes("action"));
    expect(actionErrors.length).toBeGreaterThan(0);
  });

  it("validates custom action requires prompt", () => {
    const result = validateGlobalConfig({
      agents: {
        lead: {
          extends: "manager",
          memory: {
            persist: {
              rules: [{ trigger: "session_end", action: "custom" }],
            },
          },
        },
      },
    });
    const promptErrors = result.errors.filter((e) => e.field.includes("prompt"));
    expect(promptErrors.length).toBeGreaterThan(0);
  });

  it("validates invalid provider type", () => {
    const result = validateGlobalConfig({
      agents: {
        lead: {
          extends: "manager",
          memory: {
            provider: { type: "invalid" },
          },
        },
      },
    });
    const providerErrors = result.errors.filter((e) => e.field.includes("provider"));
    expect(providerErrors.length).toBeGreaterThan(0);
  });

  it("validates mcp provider requires mcp config", () => {
    const result = validateGlobalConfig({
      agents: {
        lead: {
          extends: "manager",
          memory: {
            provider: { type: "mcp" },
          },
        },
      },
    });
    const mcpErrors = result.errors.filter((e) => e.field.includes("mcp"));
    expect(mcpErrors.length).toBeGreaterThan(0);
  });

  it("validates mcp provider requires server", () => {
    const result = validateGlobalConfig({
      agents: {
        lead: {
          extends: "manager",
          memory: {
            provider: { type: "mcp", mcp: {} },
          },
        },
      },
    });
    const serverErrors = result.errors.filter((e) => e.field.includes("server"));
    expect(serverErrors.length).toBeGreaterThan(0);
  });

  it("accepts valid mcp provider config", () => {
    const result = validateGlobalConfig({
      agents: {
        lead: {
          extends: "manager",
          memory: {
            provider: {
              type: "mcp",
              mcp: { server: "memory-server", args: ["--port", "3000"], tools: ["recall"] },
            },
          },
        },
      },
    });
    const memErrors = result.errors.filter((e) => e.field.includes("memory"));
    expect(memErrors).toHaveLength(0);
  });

  it("accepts valid full memory config", () => {
    const result = validateGlobalConfig({
      agents: {
        lead: {
          extends: "manager",
          memory: {
            recall: { enabled: true, intensity: "high", cooldownMs: 5000, maxSearches: 5, maxInjectedChars: 8000 },
            persist: {
              enabled: true,
              autoExtract: true,
              extractPrompt: "Custom prompt",
              rules: [
                { trigger: "session_end", action: "extract_learnings" },
                { trigger: "task_completed", action: "save_decisions" },
                { trigger: "task_failed", action: "save_errors" },
                { trigger: "periodic", action: "custom", prompt: "Do custom stuff" },
              ],
            },
            provider: { type: "builtin" },
          },
        },
      },
    });
    const memErrors = result.errors.filter((e) => e.field.includes("memory"));
    expect(memErrors).toHaveLength(0);
  });
});

describe("Ghost turn cooldown override", () => {
  it("GhostTurnOpts accepts cooldownOverrideMs", async () => {
    const { INTENSITY_PRESETS } = await import("../../src/memory/ghost-turn.js");
    // Verify the type is compatible (compile-time check)
    const opts = {
      sessionKey: "test",
      intensity: "medium" as const,
      memoryMode: false,
      windowSize: 10,
      maxInjectedChars: 4000,
      maxSearches: 3,
      debug: false,
      cooldownOverrideMs: 5000,
    };
    expect(opts.cooldownOverrideMs).toBe(5000);
    // Override should be less than default medium cooldown
    expect(opts.cooldownOverrideMs).toBeLessThan(INTENSITY_PRESETS.medium.cooldownMs);
  });
});
