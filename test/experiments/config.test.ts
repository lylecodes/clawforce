/**
 * Tests for experiment variant config merging.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "k",
    identityToken: "t",
    issuedAt: 0,
  })),
}));

const { mergeVariantConfig } = await import("../../src/experiments/config.js");

import type { AgentConfig, VariantConfig } from "../../src/types.js";

function makeBaseConfig(): AgentConfig {
  return {
    persona: "You are a helpful assistant",
    briefing: [
      { source: "instructions" as const },
      { source: "task_board" as const },
    ],
    expectations: [
      { tool: "clawforce_task", action: "done", min_calls: 1 },
    ],
    performance_policy: { action: "retry" as const, max_retries: 2 },
  };
}

describe("mergeVariantConfig", () => {
  it("returns a copy of base config when variant is empty", () => {
    const base = makeBaseConfig();
    const variant: VariantConfig = {};
    const merged = mergeVariantConfig(base, variant);

    expect(merged.persona).toBe(base.persona);
    expect(merged.briefing).toEqual(base.briefing);
    expect(merged.expectations).toEqual(base.expectations);
    expect(merged).not.toBe(base); // should be a new object
  });

  it("replaces persona when specified in variant", () => {
    const base = makeBaseConfig();
    const variant: VariantConfig = { persona: "You are a concise expert" };
    const merged = mergeVariantConfig(base, variant);

    expect(merged.persona).toBe("You are a concise expert");
  });

  it("replaces briefing entirely when specified", () => {
    const base = makeBaseConfig();
    const variant: VariantConfig = {
      briefing: [{ source: "custom" as const, content: "Custom brief" }],
    };
    const merged = mergeVariantConfig(base, variant);

    expect(merged.briefing).toHaveLength(1);
    expect(merged.briefing[0]!.source).toBe("custom");
  });

  it("replaces exclude_briefing when specified", () => {
    const base = makeBaseConfig();
    base.exclude_briefing = ["task_board"];
    const variant: VariantConfig = {
      exclude_briefing: ["instructions"],
    };
    const merged = mergeVariantConfig(base, variant);

    expect(merged.exclude_briefing).toEqual(["instructions"]);
  });

  it("replaces expectations entirely when specified", () => {
    const base = makeBaseConfig();
    const variant: VariantConfig = {
      expectations: [
        { tool: "clawforce_log", action: "write", min_calls: 2 },
      ],
    };
    const merged = mergeVariantConfig(base, variant);

    expect(merged.expectations).toHaveLength(1);
    expect(merged.expectations[0]!.tool).toBe("clawforce_log");
  });

  it("replaces performance_policy when specified", () => {
    const base = makeBaseConfig();
    const variant: VariantConfig = {
      performance_policy: { action: "alert" as const },
    };
    const merged = mergeVariantConfig(base, variant);

    expect(merged.performance_policy.action).toBe("alert");
  });

  it("stores model override in _experimentOverrides", () => {
    const base = makeBaseConfig();
    const variant: VariantConfig = { model: "gpt-4o" };
    const merged = mergeVariantConfig(base, variant);

    expect((merged as any)._experimentOverrides.model).toBe("gpt-4o");
  });

  it("stores context_overrides in _experimentOverrides", () => {
    const base = makeBaseConfig();
    const variant: VariantConfig = {
      context_overrides: { temperature: "0.5" },
    };
    const merged = mergeVariantConfig(base, variant);

    expect((merged as any)._experimentOverrides.context_overrides).toEqual({ temperature: "0.5" });
  });

  it("does not mutate the original base config", () => {
    const base = makeBaseConfig();
    const originalPersona = base.persona;
    const variant: VariantConfig = { persona: "New persona" };

    mergeVariantConfig(base, variant);

    expect(base.persona).toBe(originalPersona);
  });

  it("merges multiple overrides simultaneously", () => {
    const base = makeBaseConfig();
    const variant: VariantConfig = {
      persona: "Expert researcher",
      model: "claude-3-opus",
      expectations: [
        { tool: "clawforce_log", action: "write", min_calls: 3 },
      ],
    };
    const merged = mergeVariantConfig(base, variant);

    expect(merged.persona).toBe("Expert researcher");
    expect((merged as any)._experimentOverrides.model).toBe("claude-3-opus");
    expect(merged.expectations).toHaveLength(1);
    // briefing should remain unchanged
    expect(merged.briefing).toEqual(base.briefing);
  });
});
