// test/context/memory-instructions.test.ts
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

describe("memory-instructions source", () => {
  it("returns manager default when instructions=true and extends=manager", async () => {
    const { resolveMemoryInstructions, MANAGER_MEMORY_INSTRUCTIONS } =
      await import("../../src/context/sources/memory-instructions.js");

    const result = resolveMemoryInstructions({ instructions: true }, "manager");
    expect(result).toBe(MANAGER_MEMORY_INSTRUCTIONS);
    expect(result).toContain("Search memory at the START");
  });

  it("returns employee default when instructions=true and extends=employee", async () => {
    const { resolveMemoryInstructions, EMPLOYEE_MEMORY_INSTRUCTIONS } =
      await import("../../src/context/sources/memory-instructions.js");

    const result = resolveMemoryInstructions({ instructions: true }, "employee");
    expect(result).toBe(EMPLOYEE_MEMORY_INSTRUCTIONS);
    expect(result).toContain("Your knowledge comes through skills");
  });

  it("returns custom string when instructions is a string", async () => {
    const { resolveMemoryInstructions } =
      await import("../../src/context/sources/memory-instructions.js");

    const result = resolveMemoryInstructions({ instructions: "My custom memory rules" }, "manager");
    expect(result).toBe("## Memory Protocol\n\nMy custom memory rules");
  });

  it("returns null when instructions=false", async () => {
    const { resolveMemoryInstructions } =
      await import("../../src/context/sources/memory-instructions.js");

    const result = resolveMemoryInstructions({ instructions: false }, "manager");
    expect(result).toBeNull();
  });

  it("returns role default when memory config is undefined (backwards compat)", async () => {
    const { resolveMemoryInstructions, MANAGER_MEMORY_INSTRUCTIONS } =
      await import("../../src/context/sources/memory-instructions.js");

    const result = resolveMemoryInstructions(undefined, "manager");
    expect(result).toBe(MANAGER_MEMORY_INSTRUCTIONS);
  });

  it("uses employee default for assistant preset", async () => {
    const { resolveMemoryInstructions, EMPLOYEE_MEMORY_INSTRUCTIONS } =
      await import("../../src/context/sources/memory-instructions.js");

    const result = resolveMemoryInstructions(undefined, "assistant");
    expect(result).toBe(EMPLOYEE_MEMORY_INSTRUCTIONS);
  });
});
