import { describe, expect, it } from "vitest";
import { validateWorkforceConfig } from "../../src/config-validator.js";
import type { WorkforceConfig } from "../../src/types.js";

function baseConfig(overrides: Partial<WorkforceConfig> = {}): WorkforceConfig {
  return {
    name: "test-project",
    agents: {
      assistant: {
        briefing: [{ source: "instructions" as const }],
        expectations: [],
        performance_policy: { action: "alert" as const },
      },
    },
    ...overrides,
  };
}

describe("tool gates config validation", () => {
  it("passes with valid tool gates", () => {
    const config = baseConfig({
      toolGates: {
        "mcp:gmail:send": { category: "email:send", tier: "high" },
        "mcp:gcal:create": { category: "calendar:create_event", tier: "medium" },
      },
    });

    const warnings = validateWorkforceConfig(config);
    const toolGateWarnings = warnings.filter((w) => w.message.includes("toolGates"));
    expect(toolGateWarnings).toHaveLength(0);
  });

  it("warns on unknown category", () => {
    const config = baseConfig({
      toolGates: {
        "mcp:custom:action": { category: "custom:thing", tier: "medium" },
      },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("not a built-in category"));
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.level).toBe("warn");
  });

  it("errors on invalid tier", () => {
    const config = baseConfig({
      toolGates: {
        "mcp:gmail:send": { category: "email:send", tier: "extreme" as any },
      },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("invalid tier"));
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.level).toBe("error");
  });

  it("errors on missing category", () => {
    const config = baseConfig({
      toolGates: {
        "mcp:gmail:send": { category: "", tier: "high" },
      },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("missing category"));
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.level).toBe("error");
  });

  it("errors on invalid gate override", () => {
    const config = baseConfig({
      toolGates: {
        "mcp:gmail:send": { category: "email:send", tier: "high", gate: "invalid" as any },
      },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("invalid gate"));
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.level).toBe("error");
  });

  it("accepts valid gate override", () => {
    const config = baseConfig({
      toolGates: {
        "mcp:gmail:send": { category: "email:send", tier: "high", gate: "confirm" },
      },
    });

    const warnings = validateWorkforceConfig(config);
    const gateWarnings = warnings.filter((w) => w.message.includes("invalid gate"));
    expect(gateWarnings).toHaveLength(0);
  });
});

describe("bulk thresholds config validation", () => {
  it("passes with valid bulk thresholds", () => {
    const config = baseConfig({
      bulkThresholds: {
        "email:send": { windowMs: 3_600_000, maxCount: 10, escalateTo: "high" },
      },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("bulkThresholds"));
    expect(relevant).toHaveLength(0);
  });

  it("errors on non-positive windowMs", () => {
    const config = baseConfig({
      bulkThresholds: {
        "email:send": { windowMs: 0, maxCount: 10, escalateTo: "high" },
      },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("windowMs must be positive"));
    expect(relevant).toHaveLength(1);
  });

  it("errors on non-positive maxCount", () => {
    const config = baseConfig({
      bulkThresholds: {
        "email:send": { windowMs: 3_600_000, maxCount: -1, escalateTo: "high" },
      },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("maxCount must be positive"));
    expect(relevant).toHaveLength(1);
  });

  it("errors on invalid escalateTo tier", () => {
    const config = baseConfig({
      bulkThresholds: {
        "email:send": { windowMs: 3_600_000, maxCount: 10, escalateTo: "extreme" as any },
      },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("invalid escalateTo"));
    expect(relevant).toHaveLength(1);
  });
});
