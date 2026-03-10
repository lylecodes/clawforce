import { describe, expect, it, afterEach, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { startTracking, recordToolCall, getSession, resetTrackerForTest } = await import("../../src/enforcement/tracker.js");
import type { AgentConfig } from "../../src/types.js";

const workerConfig: AgentConfig = {
  extends: "employee",
  briefing: [{ source: "instructions" }],
  expectations: [
    { tool: "clawforce_task", action: "transition", min_calls: 1 },
    { tool: "clawforce_log", action: "write", min_calls: 1 },
  ],
  performance_policy: { action: "retry", max_retries: 3, then: "alert" },
};

afterEach(() => {
  resetTrackerForTest();
});

describe("compliance — success-only tracking", () => {
  it("only successful tool calls count toward requirement satisfaction", () => {
    startTracking("sess-ok", "coder", "proj1", workerConfig);

    // Successful call matching a requirement
    recordToolCall("sess-ok", "clawforce_task", "transition", 100, true);

    const session = getSession("sess-ok");
    expect(session).not.toBeNull();
    expect(session!.satisfied.get("clawforce_task:transition")).toBe(1);
  });

  it("failed tool calls do NOT satisfy requirements", () => {
    startTracking("sess-fail", "coder", "proj1", workerConfig);

    // Failed call matching a requirement
    recordToolCall("sess-fail", "clawforce_task", "transition", 100, false);

    const session = getSession("sess-fail");
    expect(session).not.toBeNull();
    // The requirement should still be unsatisfied
    expect(session!.satisfied.get("clawforce_task:transition")).toBe(0);
    // But the tool call is recorded in metrics
    expect(session!.metrics.toolCalls).toHaveLength(1);
    expect(session!.metrics.errorCount).toBe(1);
  });

  it("a mix of failed and successful calls only counts successes", () => {
    startTracking("sess-mix", "coder", "proj1", workerConfig);

    // Failed calls for both requirements
    recordToolCall("sess-mix", "clawforce_task", "transition", 100, false);
    recordToolCall("sess-mix", "clawforce_log", "write", 50, false);

    // Successful call for only one requirement
    recordToolCall("sess-mix", "clawforce_task", "transition", 100, true);

    const session = getSession("sess-mix");
    expect(session).not.toBeNull();

    // clawforce_task:transition should have 1 success (the failed one doesn't count)
    expect(session!.satisfied.get("clawforce_task:transition")).toBe(1);

    // clawforce_log:write was only called with failure, so still 0
    expect(session!.satisfied.get("clawforce_log:write")).toBe(0);

    // All 3 tool calls are recorded in the metrics
    expect(session!.metrics.toolCalls).toHaveLength(3);

    // 2 errors from the failed calls
    expect(session!.metrics.errorCount).toBe(2);

    // Only 1 required call timing (from the 1 successful required call)
    expect(session!.metrics.requiredCallTimings).toHaveLength(1);
  });
});
