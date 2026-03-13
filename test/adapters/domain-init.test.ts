import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test", hmacKey: "deadbeef", identityToken: "tok", issuedAt: Date.now(),
  })),
}));

describe("adapter domain integration", () => {
  afterEach(async () => {
    const { clearRegistry } = await import("../../src/config/registry.js");
    clearRegistry();
  });

  it("resolves domain from agent config for session tracking", async () => {
    const { registerGlobalAgents, assignAgentsToDomain, getAgentDomain } = await import("../../src/config/registry.js");

    registerGlobalAgents({
      "test-agent": { extends: "employee" },
    });
    assignAgentsToDomain("test-domain", ["test-agent"]);

    const domain = getAgentDomain("test-agent");
    expect(domain).toBe("test-domain");
  });

  it("initializeAllDomains is importable from config/init", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    expect(typeof initializeAllDomains).toBe("function");
  });
});
