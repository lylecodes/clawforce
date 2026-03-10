import { afterEach, describe, expect, it, vi } from "vitest";

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

const { resolveApprovalChannel } = await import("../../src/approval/channel-router.js");
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");

describe("approval/channel-router", () => {
  afterEach(() => {
    resetEnforcementConfigForTest();
  });

  function registerAgent(agentId: string, channel?: string) {
    registerWorkforceConfig("test-project", {
      name: "Test",
      agents: {
        [agentId]: {
          extends: "employee",
          channel,
          context_in: [],
          required_outputs: [],
          on_failure: { action: "alert" },
        },
      },
    }, "/tmp");
  }

  it("returns telegram when agent has channel: 'telegram'", () => {
    registerAgent("agent:worker", "telegram");
    const result = resolveApprovalChannel("test-project", "agent:worker");
    expect(result.channel).toBe("telegram");
  });

  it("returns slack when agent has channel: 'slack'", () => {
    registerAgent("agent:worker", "slack");
    const result = resolveApprovalChannel("test-project", "agent:worker");
    expect(result.channel).toBe("slack");
  });

  it("returns discord when agent has channel: 'discord'", () => {
    registerAgent("agent:worker", "discord");
    const result = resolveApprovalChannel("test-project", "agent:worker");
    expect(result.channel).toBe("discord");
  });

  it("falls back to dashboard when agent has no channel", () => {
    registerAgent("agent:worker");
    const result = resolveApprovalChannel("test-project", "agent:worker");
    expect(result.channel).toBe("dashboard");
  });

  it("falls back to dashboard for unknown agent", () => {
    const result = resolveApprovalChannel("test-project", "unknown:agent");
    expect(result.channel).toBe("dashboard");
  });

  it("falls back to dashboard for unknown channel type", () => {
    registerAgent("agent:worker", "fax");
    const result = resolveApprovalChannel("test-project", "agent:worker");
    expect(result.channel).toBe("dashboard");
  });

  it("handles case-insensitive channel names", () => {
    registerAgent("agent:worker", "Telegram");
    const result = resolveApprovalChannel("test-project", "agent:worker");
    expect(result.channel).toBe("telegram");
  });
});
