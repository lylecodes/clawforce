import { describe, expect, it } from "vitest";
import {
  resolveCodexConfig,
  validateCodexConfig,
  CODEX_DEFAULTS,
  normalizeCodexModel,
} from "../../adapters/codex/types.js";

describe("CodexConfig types", () => {
  describe("resolveCodexConfig", () => {
    it("returns defaults when no config provided", () => {
      const resolved = resolveCodexConfig();
      expect(resolved.binary).toBe("codex");
      expect(resolved.model).toBe("gpt-5.4");
      expect(resolved.sandbox).toBe("workspace-write");
      expect(resolved.fullAuto).toBe(true);
      expect(resolved.skipGitRepoCheck).toBe(true);
      expect(resolved.dangerouslyBypassApprovalsAndSandbox).toBe(false);
      expect(resolved.workdir).toBeUndefined();
      expect(resolved.approvalPolicy).toBeUndefined();
      expect(resolved.addDirs).toEqual([]);
      expect(resolved.configOverrides).toEqual([]);
    });

    it("merges partial config with defaults", () => {
      const resolved = resolveCodexConfig({
        model: "gpt-5.4-mini",
        workdir: "/tmp/work",
        fullAuto: false,
        approvalPolicy: "never",
        addDirs: ["/tmp/shared"],
        configOverrides: ['mcp_servers.clawforce.command="node"'],
      });
      expect(resolved.model).toBe("gpt-5.4-mini");
      expect(resolved.workdir).toBe("/tmp/work");
      expect(resolved.binary).toBe("codex");
      expect(resolved.fullAuto).toBe(false);
      expect(resolved.approvalPolicy).toBe("never");
      expect(resolved.addDirs).toEqual(["/tmp/shared"]);
      expect(resolved.sandbox).toBe("workspace-write");
      expect(resolved.configOverrides).toEqual(['mcp_servers.clawforce.command="node"']);
    });

    it("respects all overrides", () => {
      const resolved = resolveCodexConfig({
        binary: "/usr/local/bin/codex",
        model: "gpt-5.4-mini",
        workdir: "/projects/my-app",
        sandbox: "danger-full-access",
        fullAuto: false,
        skipGitRepoCheck: false,
        dangerouslyBypassApprovalsAndSandbox: true,
        configOverrides: ['mcp_servers.clawforce.command="node"'],
      });
      expect(resolved.binary).toBe("/usr/local/bin/codex");
      expect(resolved.model).toBe("gpt-5.4-mini");
      expect(resolved.workdir).toBe("/projects/my-app");
      expect(resolved.sandbox).toBe("danger-full-access");
      expect(resolved.fullAuto).toBe(false);
      expect(resolved.skipGitRepoCheck).toBe(false);
      expect(resolved.dangerouslyBypassApprovalsAndSandbox).toBe(true);
      expect(resolved.configOverrides).toEqual(['mcp_servers.clawforce.command="node"']);
    });

    it("normalizes provider-scoped OpenAI Codex model ids", () => {
      const resolved = resolveCodexConfig({
        model: "openai-codex/gpt-5.4",
      });
      expect(resolved.model).toBe("gpt-5.4");
    });
  });

  describe("validateCodexConfig", () => {
    it("accepts undefined config", () => {
      expect(validateCodexConfig(undefined)).toHaveLength(0);
    });

    it("accepts valid config object", () => {
      const errors = validateCodexConfig({
        binary: "codex",
        model: "gpt-5.4",
        workdir: "/tmp",
        approvalPolicy: "never",
        sandbox: "workspace-write",
        addDirs: ["/tmp/shared"],
        fullAuto: true,
        skipGitRepoCheck: true,
        configOverrides: ['mcp_servers.clawforce.command="node"'],
      });
      expect(errors).toHaveLength(0);
    });

    it("rejects non-object config", () => {
      expect(validateCodexConfig("string")).toContain("codex config must be an object");
      expect(validateCodexConfig(42)).toContain("codex config must be an object");
      expect(validateCodexConfig([])).toContain("codex config must be an object");
    });

    it("rejects invalid sandbox values", () => {
      const errors = validateCodexConfig({ sandbox: "unsafe" });
      expect(errors).toContain("codex.sandbox must be one of: read-only, workspace-write, danger-full-access");
    });

    it("rejects invalid approvalPolicy values", () => {
      const errors = validateCodexConfig({ approvalPolicy: "sometimes" });
      expect(errors).toContain("codex.approvalPolicy must be one of: untrusted, on-request, on-failure, never");
    });

    it("rejects invalid boolean fields", () => {
      const errors = validateCodexConfig({
        fullAuto: "yes",
        skipGitRepoCheck: 1,
        dangerouslyBypassApprovalsAndSandbox: "sure",
      });
      expect(errors).toContain("codex.fullAuto must be a boolean");
      expect(errors).toContain("codex.skipGitRepoCheck must be a boolean");
      expect(errors).toContain("codex.dangerouslyBypassApprovalsAndSandbox must be a boolean");
    });

    it("rejects invalid configOverrides values", () => {
      const errors = validateCodexConfig({ configOverrides: [1, "ok"] });
      expect(errors).toContain("codex.configOverrides must be an array of strings");
    });

    it("rejects invalid addDirs values", () => {
      const errors = validateCodexConfig({ addDirs: ["/tmp", 1] });
      expect(errors).toContain("codex.addDirs must be an array of strings");
    });
  });

  describe("CODEX_DEFAULTS", () => {
    it("has expected default values", () => {
      expect(CODEX_DEFAULTS.binary).toBe("codex");
      expect(CODEX_DEFAULTS.model).toBe("gpt-5.4");
      expect(CODEX_DEFAULTS.sandbox).toBe("workspace-write");
      expect(CODEX_DEFAULTS.fullAuto).toBe(true);
      expect(CODEX_DEFAULTS.skipGitRepoCheck).toBe(true);
      expect(CODEX_DEFAULTS.dangerouslyBypassApprovalsAndSandbox).toBe(false);
    });
  });
});

describe("normalizeCodexModel", () => {
  it("strips the openai-codex provider prefix", () => {
    expect(normalizeCodexModel("openai-codex/gpt-5.4")).toBe("gpt-5.4");
  });

  it("strips the generic openai provider prefix", () => {
    expect(normalizeCodexModel("openai/gpt-5.4-mini")).toBe("gpt-5.4-mini");
  });

  it("leaves non-openai provider-scoped ids untouched", () => {
    expect(normalizeCodexModel("anthropic/claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4-6");
  });
});

describe("GlobalConfig codex adapter fields", () => {
  it("accepts config with codex adapter field", async () => {
    const { validateGlobalConfig } = await import("../../src/config/schema.js");
    const config = {
      agents: { "my-agent": { extends: "employee" } },
      adapter: "codex",
      codex: { model: "gpt-5.4" },
    };
    const result = validateGlobalConfig(config);
    expect(result.valid).toBe(true);
  });

  it("rejects non-object codex config", async () => {
    const { validateGlobalConfig } = await import("../../src/config/schema.js");
    const config = {
      agents: { "my-agent": {} },
      codex: "invalid",
    };
    const result = validateGlobalConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "codex")).toBe(true);
  });
});
