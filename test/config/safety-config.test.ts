import { describe, expect, it } from "vitest";
import { validateWorkforceConfig } from "../../src/config-validator.js";
import type { WorkforceConfig } from "../../src/types.js";

function baseConfig(overrides: Partial<WorkforceConfig> = {}): WorkforceConfig {
  return {
    name: "test-project",
    agents: {
      worker: {
        extends: "employee",
        briefing: [{ source: "instructions" as const }],
        expectations: [{ tool: "clawforce_task", action: "update", min_calls: 1 }],
        performance_policy: { action: "alert" as const },
      },
    },
    ...overrides,
  };
}

describe("safety config validation", () => {
  it("passes with valid safety config", () => {
    const config = baseConfig({
      safety: {
        maxSpawnDepth: 3,
        costCircuitBreaker: 1.5,
        loopDetectionThreshold: 3,
        maxConcurrentMeetings: 2,
        maxMessageRate: 60,
      },
    });

    const warnings = validateWorkforceConfig(config);
    const safetyWarnings = warnings.filter((w) => w.message.includes("safety."));
    expect(safetyWarnings).toHaveLength(0);
  });

  it("errors on non-integer maxSpawnDepth", () => {
    const config = baseConfig({
      safety: { maxSpawnDepth: 2.5 },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("max_spawn_depth"));
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.level).toBe("error");
  });

  it("errors on zero maxSpawnDepth", () => {
    const config = baseConfig({
      safety: { maxSpawnDepth: 0 },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("max_spawn_depth"));
    expect(relevant).toHaveLength(1);
  });

  it("errors on negative costCircuitBreaker", () => {
    const config = baseConfig({
      safety: { costCircuitBreaker: -1 },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("cost_circuit_breaker") && w.level === "error");
    expect(relevant).toHaveLength(1);
  });

  it("warns when costCircuitBreaker <= 1.0", () => {
    const config = baseConfig({
      safety: { costCircuitBreaker: 0.8 },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("cost_circuit_breaker") && w.level === "warn");
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.message).toContain("before reaching budget limit");
  });

  it("errors on non-integer loopDetectionThreshold", () => {
    const config = baseConfig({
      safety: { loopDetectionThreshold: 1.5 },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("loop_detection_threshold"));
    expect(relevant).toHaveLength(1);
  });

  it("errors on non-integer maxConcurrentMeetings", () => {
    const config = baseConfig({
      safety: { maxConcurrentMeetings: 0 },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("max_concurrent_meetings"));
    expect(relevant).toHaveLength(1);
  });

  it("errors on non-integer maxMessageRate", () => {
    const config = baseConfig({
      safety: { maxMessageRate: -5 },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("max_message_rate"));
    expect(relevant).toHaveLength(1);
  });

  it("passes with partial safety config (uses defaults for missing)", () => {
    const config = baseConfig({
      safety: { maxSpawnDepth: 5 },
    });

    const warnings = validateWorkforceConfig(config);
    const safetyErrors = warnings.filter((w) => w.message.includes("safety.") && w.level === "error");
    expect(safetyErrors).toHaveLength(0);
  });
});
