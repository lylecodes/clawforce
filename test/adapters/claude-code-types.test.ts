import { describe, expect, it } from "vitest";
import {
  resolveClaudeCodeConfig,
  validateClaudeCodeConfig,
  CLAUDE_CODE_DEFAULTS,
} from "../../adapters/claude-code/types.js";

describe("ClaudeCodeConfig types", () => {
  describe("resolveClaudeCodeConfig", () => {
    it("returns defaults when no config provided", () => {
      const resolved = resolveClaudeCodeConfig();
      expect(resolved.binary).toBe("claude");
      expect(resolved.model).toBe("claude-opus-4-6");
      expect(resolved.permissionMode).toBe("auto");
      expect(resolved.maxBudgetPerDispatch).toBe(1.0);
      expect(resolved.workdir).toBeUndefined();
      expect(resolved.mcpConfigPath).toBeUndefined();
    });

    it("returns defaults when empty object provided", () => {
      const resolved = resolveClaudeCodeConfig({});
      expect(resolved.binary).toBe(CLAUDE_CODE_DEFAULTS.binary);
      expect(resolved.model).toBe(CLAUDE_CODE_DEFAULTS.model);
    });

    it("merges partial config with defaults", () => {
      const resolved = resolveClaudeCodeConfig({
        model: "claude-sonnet-4-20250514",
        workdir: "/tmp/work",
      });
      expect(resolved.model).toBe("claude-sonnet-4-20250514");
      expect(resolved.workdir).toBe("/tmp/work");
      expect(resolved.binary).toBe("claude"); // default
      expect(resolved.permissionMode).toBe("auto"); // default
    });

    it("respects all overrides", () => {
      const resolved = resolveClaudeCodeConfig({
        binary: "/usr/local/bin/claude",
        model: "claude-sonnet-4-20250514",
        workdir: "/projects/my-app",
        permissionMode: "plan",
        maxBudgetPerDispatch: 5.0,
        mcpConfigPath: "/path/to/mcp.json",
      });
      expect(resolved.binary).toBe("/usr/local/bin/claude");
      expect(resolved.model).toBe("claude-sonnet-4-20250514");
      expect(resolved.workdir).toBe("/projects/my-app");
      expect(resolved.permissionMode).toBe("plan");
      expect(resolved.maxBudgetPerDispatch).toBe(5.0);
      expect(resolved.mcpConfigPath).toBe("/path/to/mcp.json");
    });
  });

  describe("validateClaudeCodeConfig", () => {
    it("accepts undefined config", () => {
      const errors = validateClaudeCodeConfig(undefined);
      expect(errors).toHaveLength(0);
    });

    it("accepts null config", () => {
      const errors = validateClaudeCodeConfig(null);
      expect(errors).toHaveLength(0);
    });

    it("accepts valid config object", () => {
      const errors = validateClaudeCodeConfig({
        binary: "claude",
        model: "claude-opus-4-6",
        workdir: "/tmp",
        permissionMode: "auto",
        maxBudgetPerDispatch: 2.5,
        mcpConfigPath: "/path/to/config.json",
      });
      expect(errors).toHaveLength(0);
    });

    it("accepts empty object", () => {
      const errors = validateClaudeCodeConfig({});
      expect(errors).toHaveLength(0);
    });

    it("rejects non-object config", () => {
      expect(validateClaudeCodeConfig("string")).toContain("claude_code config must be an object");
      expect(validateClaudeCodeConfig(42)).toContain("claude_code config must be an object");
      expect(validateClaudeCodeConfig([])).toContain("claude_code config must be an object");
    });

    it("rejects invalid binary type", () => {
      const errors = validateClaudeCodeConfig({ binary: 42 });
      expect(errors).toContain("claude_code.binary must be a string");
    });

    it("rejects invalid model type", () => {
      const errors = validateClaudeCodeConfig({ model: true });
      expect(errors).toContain("claude_code.model must be a string");
    });

    it("rejects invalid workdir type", () => {
      const errors = validateClaudeCodeConfig({ workdir: 123 });
      expect(errors).toContain("claude_code.workdir must be a string");
    });

    it("rejects invalid permissionMode type", () => {
      const errors = validateClaudeCodeConfig({ permissionMode: false });
      expect(errors).toContain("claude_code.permissionMode must be a string");
    });

    it("rejects negative maxBudgetPerDispatch", () => {
      const errors = validateClaudeCodeConfig({ maxBudgetPerDispatch: -1 });
      expect(errors).toContain("claude_code.maxBudgetPerDispatch must be a non-negative number");
    });

    it("rejects non-number maxBudgetPerDispatch", () => {
      const errors = validateClaudeCodeConfig({ maxBudgetPerDispatch: "five" });
      expect(errors).toContain("claude_code.maxBudgetPerDispatch must be a non-negative number");
    });

    it("accepts zero maxBudgetPerDispatch", () => {
      const errors = validateClaudeCodeConfig({ maxBudgetPerDispatch: 0 });
      expect(errors).toHaveLength(0);
    });

    it("rejects invalid mcpConfigPath type", () => {
      const errors = validateClaudeCodeConfig({ mcpConfigPath: 42 });
      expect(errors).toContain("claude_code.mcpConfigPath must be a string");
    });

    it("collects multiple errors", () => {
      const errors = validateClaudeCodeConfig({
        binary: 42,
        model: true,
        maxBudgetPerDispatch: -1,
      });
      expect(errors.length).toBe(3);
    });
  });

  describe("CLAUDE_CODE_DEFAULTS", () => {
    it("has expected default values", () => {
      expect(CLAUDE_CODE_DEFAULTS.binary).toBe("claude");
      expect(CLAUDE_CODE_DEFAULTS.model).toBe("claude-opus-4-6");
      expect(CLAUDE_CODE_DEFAULTS.permissionMode).toBe("auto");
      expect(CLAUDE_CODE_DEFAULTS.maxBudgetPerDispatch).toBe(1.0);
    });
  });
});

describe("GlobalConfig adapter fields", () => {
  it("accepts config with adapter field", async () => {
    const { validateGlobalConfig } = await import("../../src/config/schema.js");
    const config = {
      agents: { "my-agent": { extends: "employee" } },
      adapter: "claude-code",
      claude_code: { model: "claude-opus-4-6" },
    };
    const result = validateGlobalConfig(config);
    expect(result.valid).toBe(true);
  });

  it("accepts config with openclaw adapter", async () => {
    const { validateGlobalConfig } = await import("../../src/config/schema.js");
    const config = {
      agents: { "my-agent": {} },
      adapter: "openclaw",
    };
    const result = validateGlobalConfig(config);
    expect(result.valid).toBe(true);
  });

  it("rejects invalid adapter value", async () => {
    const { validateGlobalConfig } = await import("../../src/config/schema.js");
    const config = {
      agents: { "my-agent": {} },
      adapter: "invalid-adapter",
    };
    const result = validateGlobalConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "adapter")).toBe(true);
  });

  it("rejects non-object claude_code config", async () => {
    const { validateGlobalConfig } = await import("../../src/config/schema.js");
    const config = {
      agents: { "my-agent": {} },
      claude_code: "invalid",
    };
    const result = validateGlobalConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "claude_code")).toBe(true);
  });

  it("accepts config without adapter field (defaults to openclaw)", async () => {
    const { validateGlobalConfig } = await import("../../src/config/schema.js");
    const config = {
      agents: { "my-agent": {} },
    };
    const result = validateGlobalConfig(config);
    expect(result.valid).toBe(true);
  });
});
