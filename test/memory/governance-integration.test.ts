// test/memory/governance-integration.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

describe("memory governance integration", () => {
  it("assembleContext resolves memory_instructions for a manager", async () => {
    const { assembleContext } = await import("../../src/context/assembler.js");
    const config: import("../../src/types.js").AgentConfig = {
      extends: "manager",
      briefing: [{ source: "memory_instructions" }],
      expectations: [],
      performance_policy: { action: "alert" },
      memory: { instructions: true },
    };

    const result = assembleContext("lead", config);
    expect(result).toContain("Search memory at the START");
  });

  it("assembleContext resolves memory_instructions with custom text", async () => {
    const { assembleContext } = await import("../../src/context/assembler.js");
    const config: import("../../src/types.js").AgentConfig = {
      extends: "employee",
      briefing: [{ source: "memory_instructions" }],
      expectations: [],
      performance_policy: { action: "alert" },
      memory: { instructions: "Always search memory before writing code" },
    };

    const result = assembleContext("worker", config);
    expect(result).toContain("Always search memory before writing code");
  });

  it("assembleContext resolves memory_instructions as null when disabled", async () => {
    const { assembleContext } = await import("../../src/context/assembler.js");
    const config: import("../../src/types.js").AgentConfig = {
      extends: "manager",
      briefing: [{ source: "memory_instructions" }],
      expectations: [],
      performance_policy: { action: "alert" },
      memory: { instructions: false },
    };

    const result = assembleContext("lead", config);
    // memory_instructions returns null, so section is skipped — result should be empty or not contain Memory Protocol
    expect(result).not.toContain("Memory Protocol");
  });

  it("full manager preset has memory_instructions in briefing (not memory)", async () => {
    const { BUILTIN_AGENT_PRESETS } = await import("../../src/presets.js");
    const briefing = BUILTIN_AGENT_PRESETS.manager.briefing as string[];
    expect(briefing).toContain("memory_instructions");
    expect(briefing).not.toContain("memory");
  });

  it("full employee preset has memory_instructions in briefing (not memory)", async () => {
    const { BUILTIN_AGENT_PRESETS } = await import("../../src/presets.js");
    const briefing = BUILTIN_AGENT_PRESETS.employee.briefing as string[];
    expect(briefing).toContain("memory_instructions");
    expect(briefing).not.toContain("memory");
  });

  it("MemoryGovernanceConfig type is exported from index", async () => {
    const index = await import("../../src/index.js");
    // Type-only exports won't appear at runtime, but BUILTIN_JOB_PRESETS should have memory_review
    expect(index.BUILTIN_JOB_PRESETS.memory_review).toBeDefined();
  });

  it("resolveMemoryInstructions is exported from index", async () => {
    const index = await import("../../src/index.js");
    expect(typeof index.resolveMemoryInstructions).toBe("function");
  });

  it("buildReviewContext is exported from index", async () => {
    const index = await import("../../src/index.js");
    expect(typeof index.buildReviewContext).toBe("function");
  });

  it("memory_review_context resolves in assembler without crashing", async () => {
    const { assembleContext } = await import("../../src/context/assembler.js");
    const config: import("../../src/types.js").AgentConfig = {
      extends: "manager",
      briefing: [{ source: "memory_review_context" }],
      expectations: [],
      performance_policy: { action: "alert" },
      memory: {
        review: {
          scope: "self",
          aggressiveness: "medium",
        },
      },
    };

    // Without projectDir, should return empty/null gracefully
    const result = assembleContext("lead", config);
    // Should not crash — may be empty since no projectDir
    expect(typeof result).toBe("string");
  });
});
