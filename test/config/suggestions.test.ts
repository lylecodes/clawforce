import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

describe("config quality suggestions", () => {
  it("suggests budget config when multiple agents defined", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const agentDefaults = { expectations: [], briefing: [], performance_policy: { action: "alert" } };
    const config = {
      name: "test",
      agents: {
        a: { extends: "employee", ...agentDefaults },
        b: { extends: "employee", ...agentDefaults },
        c: { extends: "employee", ...agentDefaults },
      },
    };

    const results = validateWorkforceConfig(config as any);
    const suggestions = results.filter(r => r.level === "suggest");
    expect(suggestions.some(s => s.message.toLowerCase().includes("budget"))).toBe(true);
  });

  it("suggests orchestrator when domain has no orchestrator", async () => {
    const { validateDomainQuality } = await import("../../src/config-validator.js");

    const result = validateDomainQuality({
      domain: "test",
      agents: ["a", "b"],
    } as any);
    const suggestions = result.filter(r => r.level === "suggest");
    expect(suggestions.some(s => s.message.toLowerCase().includes("orchestrator"))).toBe(true);
  });

  it("suggests expectations when agents have none", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const config = {
      name: "test",
      agents: {
        worker: { extends: "employee", expectations: [], briefing: [], performance_policy: { action: "alert" } },
      },
    };

    const results = validateWorkforceConfig(config as any);
    const suggestions = results.filter(r => r.level === "suggest");
    expect(suggestions.some(s => s.message.toLowerCase().includes("expectation"))).toBe(true);
  });

  it("does not suggest budget when agents have budget config", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const agentDefaults = { expectations: [], briefing: [], performance_policy: { action: "alert" } };
    const config = {
      name: "test",
      agents: {
        a: { extends: "employee", ...agentDefaults },
        b: { extends: "employee", ...agentDefaults },
        c: { extends: "employee", ...agentDefaults },
      },
      budgets: { project: { daily: { limitCents: 500 } } },
    };

    const results = validateWorkforceConfig(config as any);
    const suggestions = results.filter(r => r.level === "suggest" && r.message.toLowerCase().includes("budget"));
    expect(suggestions).toHaveLength(0);
  });

  it("suggests paths and rules for domain quality", async () => {
    const { validateDomainQuality } = await import("../../src/config-validator.js");

    const result = validateDomainQuality({
      domain: "test",
      agents: ["a"],
    } as any);

    expect(result.some(r => r.message.toLowerCase().includes("paths"))).toBe(true);
    expect(result.some(r => r.message.toLowerCase().includes("rules"))).toBe(true);
  });
});
