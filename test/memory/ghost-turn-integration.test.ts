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

describe("expectations re-injection", () => {
  it("formats expectations as a reminder section", async () => {
    const { formatExpectationsReminder } = await import("../../src/memory/ghost-turn.js");

    const expectations = [
      { tool: "clawforce_log", action: "log", min_calls: 1 },
      { tool: "clawforce_verify", action: "submit_evidence", min_calls: 1 },
    ];

    const result = formatExpectationsReminder(expectations);
    expect(result).toContain("Expectations Reminder");
    expect(result).toContain("clawforce_log");
    expect(result).toContain("clawforce_verify");
  });

  it("returns null when no expectations provided", async () => {
    const { formatExpectationsReminder } = await import("../../src/memory/ghost-turn.js");

    const result = formatExpectationsReminder([]);
    expect(result).toBeNull();
  });
});
