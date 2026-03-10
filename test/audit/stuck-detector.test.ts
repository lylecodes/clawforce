import { afterEach, describe, expect, it } from "vitest";
import { detectStuckAgents } from "../../src/audit/stuck-detector.js";
import {
  getSession,
  recordToolCall,
  resetTrackerForTest,
  startTracking,
} from "../../src/enforcement/tracker.js";
import type { AgentConfig } from "../../src/types.js";

const cronConfig: AgentConfig = {
  extends: "employee",
  briefing: [{ source: "instructions" }],
  expectations: [
    { tool: "clawforce_log", action: "outcome", min_calls: 1 },
  ],
  performance_policy: { action: "retry", max_retries: 3, then: "terminate_and_alert" },
};

describe("stuck detector", () => {
  afterEach(() => {
    resetTrackerForTest();
  });

  it("detects agent with no tool calls past timeout", () => {
    startTracking("sess1", "outreach", "proj1", cronConfig);

    const session = getSession("sess1")!;
    session.metrics.startedAt = Date.now() - 400_000;

    const stuck = detectStuckAgents({ stuckTimeoutMs: 300_000 });
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.agentId).toBe("outreach");
    expect(stuck[0]!.reason).toContain("zero tool calls");
  });

  it("detects agent running past timeout with no required calls", () => {
    startTracking("sess1", "outreach", "proj1", cronConfig);

    const session = getSession("sess1")!;
    session.metrics.startedAt = Date.now() - 400_000;
    session.metrics.firstToolCallAt = Date.now() - 350_000;
    session.metrics.lastToolCallAt = Date.now() - 100;
    session.metrics.toolCalls.push({
      toolName: "other_tool",
      action: null,
      timestamp: Date.now() - 100,
      durationMs: 50,
      success: true,
    });

    const stuck = detectStuckAgents({ stuckTimeoutMs: 300_000 });
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.reason).toContain("no required tool calls");
  });

  it("detects idle agent past timeout", () => {
    startTracking("sess1", "outreach", "proj1", cronConfig);

    const session = getSession("sess1")!;
    session.metrics.startedAt = Date.now() - 400_000;
    session.metrics.firstToolCallAt = Date.now() - 350_000;
    session.metrics.lastToolCallAt = Date.now() - 200_000;
    session.satisfied.set("clawforce_log:outcome", 1);

    const stuck = detectStuckAgents({
      stuckTimeoutMs: 300_000,
      idleTimeoutMs: 180_000,
    });
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.reason).toContain("Idle");
  });

  it("does not flag healthy sessions", () => {
    startTracking("sess1", "outreach", "proj1", cronConfig);

    const stuck = detectStuckAgents({ stuckTimeoutMs: 300_000 });
    expect(stuck).toHaveLength(0);
  });

  it("does not flag completed required calls even if long-running", () => {
    startTracking("sess1", "outreach", "proj1", cronConfig);

    const session = getSession("sess1")!;
    session.metrics.startedAt = Date.now() - 400_000;
    session.metrics.firstToolCallAt = Date.now() - 300_000;
    session.metrics.lastToolCallAt = Date.now() - 100;
    session.satisfied.set("clawforce_log:outcome", 1);

    const stuck = detectStuckAgents({ stuckTimeoutMs: 300_000 });
    expect(stuck).toHaveLength(0);
  });
});
