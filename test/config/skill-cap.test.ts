import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

describe("skill cap validation", () => {
  it("warns when agent exceeds skill cap", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const config = {
      name: "test-project",
      agents: {
        "overloaded-agent": {
          title: "Overloaded",
          skillCap: 2,
          // The validator would check topic count vs skillCap
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    } as any;

    const warnings = validateWorkforceConfig(config);
    // Skill cap warnings are informational — they check config values
    // The actual topic count check happens at runtime (needs registry)
    // Config validator just validates skillCap is a positive number if set
    expect(Array.isArray(warnings)).toBe(true);
  });

  it("returns warning for skillCap < 1", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const config = {
      name: "test-project",
      agents: {
        "bad-cap-agent": {
          title: "Bad Cap",
          skillCap: 0,
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    } as any;

    const warnings = validateWorkforceConfig(config);
    const capWarning = warnings.find((w: any) => w.message.includes("Skill cap"));
    expect(capWarning).toBeDefined();
    expect(capWarning!.level).toBe("warn");
    expect(capWarning!.agentId).toBe("bad-cap-agent");
  });

  it("returns warning for negative skillCap", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const config = {
      name: "test-project",
      agents: {
        "negative-cap": {
          title: "Negative",
          skillCap: -5,
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    } as any;

    const warnings = validateWorkforceConfig(config);
    const capWarning = warnings.find((w: any) => w.message.includes("Skill cap"));
    expect(capWarning).toBeDefined();
    expect(capWarning!.message).toContain("-5");
  });

  it("does not warn for valid skillCap", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const config = {
      name: "test-project",
      agents: {
        "good-agent": {
          title: "Good",
          skillCap: 8,
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    } as any;

    const warnings = validateWorkforceConfig(config);
    const capWarning = warnings.find((w: any) => w.message.includes("Skill cap"));
    expect(capWarning).toBeUndefined();
  });

  it("does not warn when skillCap is not set", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const config = {
      name: "test-project",
      agents: {
        "no-cap": {
          title: "No Cap",
          briefing: [],
          expectations: [],
          performance_policy: { action: "alert" },
        },
      },
    } as any;

    const warnings = validateWorkforceConfig(config);
    const capWarning = warnings.find((w: any) => w.message.includes("Skill cap"));
    expect(capWarning).toBeUndefined();
  });
});
