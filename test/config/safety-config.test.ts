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

  // --- Rate limiting config validation ---

  it("passes with valid rate limiting config", () => {
    const config = baseConfig({
      safety: {
        maxCallsPerSession: 200,
        maxCallsPerMinute: 300,
        maxCallsPerMinutePerAgent: 80,
      },
    });

    const warnings = validateWorkforceConfig(config);
    const rateLimitErrors = warnings.filter((w) =>
      (w.message.includes("max_calls_per") && w.level === "error"),
    );
    expect(rateLimitErrors).toHaveLength(0);
  });

  it("errors on non-integer maxCallsPerSession", () => {
    const config = baseConfig({
      safety: { maxCallsPerSession: 50.5 },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("max_calls_per_session"));
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.level).toBe("error");
  });

  it("errors on zero maxCallsPerSession", () => {
    const config = baseConfig({
      safety: { maxCallsPerSession: 0 },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("max_calls_per_session"));
    expect(relevant).toHaveLength(1);
  });

  it("errors on negative maxCallsPerMinute", () => {
    const config = baseConfig({
      safety: { maxCallsPerMinute: -10 },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("max_calls_per_minute") && !w.message.includes("per_agent"));
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.level).toBe("error");
  });

  it("errors on non-integer maxCallsPerMinutePerAgent", () => {
    const config = baseConfig({
      safety: { maxCallsPerMinutePerAgent: 2.5 },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("max_calls_per_minute_per_agent"));
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.level).toBe("error");
  });

  // --- Retry backoff config validation ---

  it("passes with valid backoff config", () => {
    const config = baseConfig({
      safety: {
        retryBackoffBaseMs: 5000,
        retryBackoffMaxMs: 300000,
      },
    });

    const warnings = validateWorkforceConfig(config);
    const backoffErrors = warnings.filter((w) =>
      w.message.includes("retry_backoff") && w.level === "error",
    );
    expect(backoffErrors).toHaveLength(0);
  });

  it("errors on retryBackoffBaseMs below 1000ms", () => {
    const config = baseConfig({
      safety: { retryBackoffBaseMs: 500 },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("retry_backoff_base_ms"));
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.level).toBe("error");
  });

  it("errors on retryBackoffMaxMs below 1000ms", () => {
    const config = baseConfig({
      safety: { retryBackoffMaxMs: 100 },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) => w.message.includes("retry_backoff_max_ms"));
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.level).toBe("error");
  });

  it("warns when base exceeds max", () => {
    const config = baseConfig({
      safety: {
        retryBackoffBaseMs: 60000,
        retryBackoffMaxMs: 30000,
      },
    });

    const warnings = validateWorkforceConfig(config);
    const relevant = warnings.filter((w) =>
      w.message.includes("retry_backoff_base_ms") && w.level === "warn",
    );
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.message).toContain("exceeds");
  });
});
