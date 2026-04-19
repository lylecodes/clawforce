/**
 * CO-1/CO-2/CO-3: Cost optimization preset tests
 *
 * Validates that role presets include sensible defaults for:
 * - Bootstrap budget limits (CO-1)
 * - Bootstrap file exclusions (CO-2)
 * - Allowed OpenClaw tools per role (CO-3)
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_PRESETS } from "../../src/presets.js";
import type { BootstrapConfig } from "../../src/types.js";

function getPresetRuntime(name: keyof typeof BUILTIN_AGENT_PRESETS): {
  bootstrapConfig?: BootstrapConfig;
  bootstrapExcludeFiles?: string[];
  allowedTools?: string[];
  workspacePaths?: string[];
} {
  const preset = BUILTIN_AGENT_PRESETS[name]!;
  return (preset.runtime as {
    bootstrapConfig?: BootstrapConfig;
    bootstrapExcludeFiles?: string[];
    allowedTools?: string[];
    workspacePaths?: string[];
  } | undefined) ?? {};
}

describe("CO-1: bootstrap budget defaults", () => {
  it("employee preset has reduced bootstrap budget", () => {
    const config = getPresetRuntime("employee").bootstrapConfig;
    expect(config).toBeDefined();
    expect(config.maxChars).toBe(8000);
    expect(config.totalMaxChars).toBe(30000);
  });

  it("verifier preset has reduced bootstrap budget", () => {
    const config = getPresetRuntime("verifier").bootstrapConfig;
    expect(config).toBeDefined();
    expect(config.maxChars).toBe(8000);
    expect(config.totalMaxChars).toBe(30000);
  });

  it("manager preset has moderate bootstrap budget", () => {
    const config = getPresetRuntime("manager").bootstrapConfig;
    expect(config).toBeDefined();
    expect(config.maxChars).toBe(12000);
    expect(config.totalMaxChars).toBe(50000);
  });

  it("all bootstrap budgets are below OpenClaw defaults (20k/150k)", () => {
    for (const name of Object.keys(BUILTIN_AGENT_PRESETS) as Array<keyof typeof BUILTIN_AGENT_PRESETS>) {
      const config = getPresetRuntime(name).bootstrapConfig;
      if (config) {
        if (config.maxChars !== undefined) {
          expect(config.maxChars, `${name}.maxChars`).toBeLessThanOrEqual(20000);
        }
        if (config.totalMaxChars !== undefined) {
          expect(config.totalMaxChars, `${name}.totalMaxChars`).toBeLessThanOrEqual(150000);
        }
      }
    }
  });
});

describe("CO-2: bootstrap file exclusion defaults", () => {
  it("employee preset excludes assistant-oriented files", () => {
    const excludes = getPresetRuntime("employee").bootstrapExcludeFiles;
    expect(excludes).toBeDefined();
    expect(excludes).toContain("AGENTS.md");
    expect(excludes).toContain("HEARTBEAT.md");
    expect(excludes).toContain("IDENTITY.md");
    expect(excludes).toContain("BOOTSTRAP.md");
  });

  it("verifier preset excludes assistant-oriented files", () => {
    const excludes = getPresetRuntime("verifier").bootstrapExcludeFiles;
    expect(excludes).toBeDefined();
    expect(excludes).toContain("AGENTS.md");
    expect(excludes).toContain("HEARTBEAT.md");
    expect(excludes).toContain("IDENTITY.md");
    expect(excludes).toContain("BOOTSTRAP.md");
  });

  it("manager preset excludes some assistant-oriented files but keeps AGENTS.md", () => {
    const excludes = getPresetRuntime("manager").bootstrapExcludeFiles;
    expect(excludes).toBeDefined();
    expect(excludes).toContain("HEARTBEAT.md");
    expect(excludes).toContain("IDENTITY.md");
    expect(excludes).toContain("BOOTSTRAP.md");
    // Managers may need AGENTS.md for team awareness
    expect(excludes).not.toContain("AGENTS.md");
  });

  it("no preset excludes SOUL.md (always needed)", () => {
    for (const name of Object.keys(BUILTIN_AGENT_PRESETS) as Array<keyof typeof BUILTIN_AGENT_PRESETS>) {
      const excludes = getPresetRuntime(name).bootstrapExcludeFiles;
      if (excludes) {
        expect(excludes, `${name} should not exclude SOUL.md`).not.toContain("SOUL.md");
      }
    }
  });
});

describe("CO-3: allowed tools defaults", () => {
  it("employee preset has worker tools (exec, read, edit, write, browser)", () => {
    const tools = getPresetRuntime("employee").allowedTools;
    expect(tools).toBeDefined();
    expect(tools).toContain("Bash");
    expect(tools).toContain("Read");
    expect(tools).toContain("Edit");
    expect(tools).toContain("Write");
    expect(tools).toContain("WebSearch");
  });

  it("verifier preset has read-only tools (exec, read, browser)", () => {
    const tools = getPresetRuntime("verifier").allowedTools;
    expect(tools).toBeDefined();
    expect(tools).toContain("Bash");
    expect(tools).toContain("Read");
    expect(tools).toContain("WebSearch");
    // Verifiers cannot modify code
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Write");
  });

  it("manager preset does not restrict tools (needs full access)", () => {
    // Managers should not have allowedTools restriction — they need full access
    expect(getPresetRuntime("manager").allowedTools).toBeUndefined();
  });

  it("assistant preset does not restrict tools", () => {
    expect(getPresetRuntime("assistant").allowedTools).toBeUndefined();
  });
});
