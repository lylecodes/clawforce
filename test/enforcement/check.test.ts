import { afterEach, describe, expect, it } from "vitest";
import { checkCompliance, buildRetryPrompt } from "../../src/enforcement/check.js";
import {
  recordToolCall,
  resetTrackerForTest,
  startTracking,
  getSession,
} from "../../src/enforcement/tracker.js";
import type { AgentConfig } from "../../src/types.js";

const workerConfig: AgentConfig = {
  extends: "employee",
  briefing: [{ source: "instructions" }],
  expectations: [
    { tool: "clawforce_task", action: ["transition", "fail"], min_calls: 1 },
    { tool: "clawforce_log", action: "write", min_calls: 1 },
  ],
  performance_policy: { action: "retry", max_retries: 3, then: "alert" },
};

describe("compliance check", () => {
  afterEach(() => {
    resetTrackerForTest();
  });

  it("reports compliant when all requirements met", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);
    recordToolCall("sess1", "clawforce_task", "transition", 100, true);
    recordToolCall("sess1", "clawforce_log", "write", 50, true);

    const session = getSession("sess1")!;
    const result = checkCompliance(session);

    expect(result.compliant).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.requirements).toHaveLength(2);
    expect(result.requirements.every((r) => r.satisfied)).toBe(true);
  });

  it("reports non-compliant when requirements not met", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);
    recordToolCall("sess1", "clawforce_task", "transition", 100, true);
    // Missing: clawforce_log write

    const session = getSession("sess1")!;
    const result = checkCompliance(session);

    expect(result.compliant).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("clawforce_log");
    expect(result.violations[0]).toContain("write");
  });

  it("reports all violations", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);
    // No required tool calls at all

    const session = getSession("sess1")!;
    const result = checkCompliance(session);

    expect(result.compliant).toBe(false);
    expect(result.violations).toHaveLength(2);
  });

  it("includes metrics in result", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);
    recordToolCall("sess1", "clawforce_task", "transition", 100, true);

    const session = getSession("sess1")!;
    const result = checkCompliance(session);

    expect(result.metrics.startedAt).toBeGreaterThan(0);
    expect(result.metrics.toolCalls).toHaveLength(1);
  });

  it("handles min_calls > 1", () => {
    const strictConfig: AgentConfig = {
      ...workerConfig,
      expectations: [
        { tool: "clawforce_log", action: "write", min_calls: 3 },
      ],
    };

    startTracking("sess1", "agent1", "proj1", strictConfig);
    recordToolCall("sess1", "clawforce_log", "write", 50, true);
    recordToolCall("sess1", "clawforce_log", "write", 50, true);

    const session = getSession("sess1")!;
    const result = checkCompliance(session);

    expect(result.compliant).toBe(false);
    expect(result.requirements[0]!.actual_calls).toBe(2);
    expect(result.requirements[0]!.min_calls).toBe(3);
  });
});

describe("buildRetryPrompt", () => {
  afterEach(() => {
    resetTrackerForTest();
  });

  it("generates a retry prompt listing violations", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);

    const session = getSession("sess1")!;
    const result = checkCompliance(session);
    const prompt = buildRetryPrompt(result);

    expect(prompt).toContain("did not meet expectations");
    expect(prompt).toContain("clawforce_task");
    expect(prompt).toContain("clawforce_log");
    expect(prompt).toContain("responsible for completing");
  });

  it("includes session summary with tool call count and errors", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);
    recordToolCall("sess1", "clawforce_task", "get", 100, true);
    recordToolCall("sess1", "some_tool", null, 50, false);

    const session = getSession("sess1")!;
    const result = checkCompliance(session);
    const prompt = buildRetryPrompt(result);

    expect(prompt).toContain("Session Summary");
    expect(prompt).toContain("Tool calls made: 2");
    expect(prompt).toContain("Errors encountered: 1");
  });

  it("includes recent tool calls in retry prompt", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);
    recordToolCall("sess1", "clawforce_task", "get", 100, true);
    recordToolCall("sess1", "some_tool", null, 50, false);

    const session = getSession("sess1")!;
    const result = checkCompliance(session);
    const prompt = buildRetryPrompt(result);

    expect(prompt).toContain("Recent Tool Calls");
    expect(prompt).toContain("clawforce_task (get)");
    expect(prompt).toContain("some_tool");
  });
});
