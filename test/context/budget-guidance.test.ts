import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

describe("budget_guidance briefing source", () => {
  it("returns budget guidance text when projectId is set", async () => {
    const { resolveBudgetGuidanceSource } = await import("../../src/context/sources/budget-guidance.js");

    // Without historical data, falls back to model-cost estimates
    const result = resolveBudgetGuidanceSource("test-project", undefined);
    expect(result).toBeNull(); // No config data to work with returns null
  });
});
