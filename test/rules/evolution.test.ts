import { describe, expect, it, vi } from "vitest";

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

describe("evolution pipeline", () => {
  it("suggestTarget returns 'rule' for decision-pattern content", async () => {
    const { suggestTarget } = await import("../../src/memory/promotion.js");

    expect(suggestTarget("when a deploy task completes, always assign a reviewer to check it")).toBe("rule");
    expect(suggestTarget("every time we get a security issue, route it to the security team")).toBe("rule");
    expect(suggestTarget("whenever a budget alert fires, do an immediate review")).toBe("rule");
    expect(suggestTarget("if the task has high priority, it should go to the senior agent")).toBe("rule");
  });

  it("suggestTarget still returns other targets for non-rule content", async () => {
    const { suggestTarget } = await import("../../src/memory/promotion.js");

    expect(suggestTarget("i prefer to use typescript for all projects")).toBe("soul");
    expect(suggestTarget("the project deployment process involves three stages")).toBe("project_doc");
    expect(suggestTarget("how to use the task management system effectively")).toBe("skill");
  });

  it("formats the evolution prompt for orchestrators", async () => {
    const { formatEvolutionPrompt } = await import("../../src/rules/evolution.js");

    const prompt = formatEvolutionPrompt();
    expect(prompt).toContain("System Evolution");
    expect(prompt).toContain("judgment");
    expect(prompt).toContain("rule candidate");
    expect(prompt).toContain("flag_knowledge");
    expect(prompt).toContain("decision_pattern");
    expect(prompt.length).toBeGreaterThan(100);
  });
});
