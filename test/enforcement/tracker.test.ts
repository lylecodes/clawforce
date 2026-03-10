import { afterEach, describe, expect, it } from "vitest";
import {
  endSession,
  getActiveSessions,
  getSession,
  recordToolCall,
  resetTrackerForTest,
  startTracking,
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

describe("compliance tracker", () => {
  afterEach(() => {
    resetTrackerForTest();
  });

  it("tracks a session", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);

    const session = getSession("sess1");
    expect(session).not.toBeNull();
    expect(session!.agentId).toBe("coder");
    expect(session!.projectId).toBe("proj1");
    expect(session!.requirements).toHaveLength(2);
    expect(session!.satisfied.size).toBe(2);
  });

  it("records tool calls and updates satisfaction", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);

    recordToolCall("sess1", "clawforce_task", "transition", 100, true);

    const session = getSession("sess1");
    expect(session!.satisfied.get("clawforce_task:fail|transition")).toBe(1);
    expect(session!.satisfied.get("clawforce_log:write")).toBe(0);
    expect(session!.metrics.toolCalls).toHaveLength(1);
    expect(session!.metrics.firstToolCallAt).not.toBeNull();
  });

  it("tracks multiple calls to same requirement", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);

    recordToolCall("sess1", "clawforce_task", "transition", 50, true);
    recordToolCall("sess1", "clawforce_task", "fail", 50, true);

    const session = getSession("sess1");
    expect(session!.satisfied.get("clawforce_task:fail|transition")).toBe(2);
  });

  it("tracks error count", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);

    recordToolCall("sess1", "clawforce_task", "transition", 100, false);

    const session = getSession("sess1");
    expect(session!.metrics.errorCount).toBe(1);
  });

  it("tracks required call timings", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);

    recordToolCall("sess1", "clawforce_task", "transition", 100, true);
    recordToolCall("sess1", "clawforce_log", "write", 50, true);

    const session = getSession("sess1");
    expect(session!.metrics.requiredCallTimings).toHaveLength(2);
  });

  it("ignores calls to untracked sessions", () => {
    recordToolCall("unknown", "clawforce_task", "transition", 100, true);
    expect(getSession("unknown")).toBeNull();
  });

  it("ignores non-matching tool calls", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);

    recordToolCall("sess1", "other_tool", "something", 100, true);

    const session = getSession("sess1");
    expect(session!.satisfied.get("clawforce_task:fail|transition")).toBe(0);
    expect(session!.metrics.toolCalls).toHaveLength(1); // Still recorded in metrics
  });

  it("ends and removes session", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);

    const ended = endSession("sess1");
    expect(ended).not.toBeNull();
    expect(ended!.agentId).toBe("coder");
    expect(getSession("sess1")).toBeNull();
  });

  it("returns all active sessions", () => {
    startTracking("sess1", "agent1", "proj1", workerConfig);
    startTracking("sess2", "agent2", "proj1", workerConfig);

    expect(getActiveSessions()).toHaveLength(2);
  });
});
