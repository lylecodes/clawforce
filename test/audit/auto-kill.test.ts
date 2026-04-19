import { afterEach, describe, expect, it, vi } from "vitest";
import {
  killStuckAgent,
  killAllStuckAgents,
  registerKillFunction,
  resetAutoKillForTest,
} from "../../src/audit/auto-kill.js";
import * as tracker from "../../src/enforcement/tracker.js";
import type { StuckAgent } from "../../src/audit/stuck-detector.js";

const mockAgent: StuckAgent = {
  sessionKey: "sess1",
  agentId: "outreach",
  projectId: "proj1",
  runtimeMs: 400_000,
  lastToolCallMs: null,
  requiredCallsMade: 0,
  requiredCallsTotal: 1,
  reason: "Running 400s with zero tool calls",
};

describe("auto-kill", () => {
  afterEach(() => {
    resetAutoKillForTest();
  });

  it("returns false when no kill function registered", async () => {
    const result = await killStuckAgent(mockAgent);
    expect(result).toBe(false);
  });

  it("calls kill function and returns true", async () => {
    const killFn = vi.fn().mockResolvedValue(true);
    registerKillFunction(killFn);

    const result = await killStuckAgent(mockAgent);
    expect(result).toBe(true);
    expect(killFn).toHaveBeenCalledWith("sess1", expect.stringContaining("auto-kill"));
  });

  it("handles kill function failure gracefully", async () => {
    registerKillFunction(async () => { throw new Error("RPC failed"); });

    const result = await killStuckAgent(mockAgent);
    expect(result).toBe(false);
  });

  it("falls back to persisted session kill when no kill function is registered", async () => {
    const fallback = vi.spyOn(tracker, "killPersistedSessionProcess").mockReturnValue(true);

    const result = await killStuckAgent(mockAgent);
    expect(result).toBe(true);
    expect(fallback).toHaveBeenCalledWith("proj1", "sess1", expect.stringContaining("auto-kill"));
  });

  it("falls back to persisted session kill when gateway kill returns false", async () => {
    registerKillFunction(async () => false);
    const fallback = vi.spyOn(tracker, "killPersistedSessionProcess").mockReturnValue(true);

    const result = await killStuckAgent(mockAgent);
    expect(result).toBe(true);
    expect(fallback).toHaveBeenCalledWith("proj1", "sess1", expect.stringContaining("auto-kill"));
  });

  it("kills all stuck agents and returns count", async () => {
    const killFn = vi.fn().mockResolvedValue(true);
    registerKillFunction(killFn);

    const agents: StuckAgent[] = [
      { ...mockAgent, sessionKey: "sess1" },
      { ...mockAgent, sessionKey: "sess2" },
      { ...mockAgent, sessionKey: "sess3" },
    ];

    const killed = await killAllStuckAgents(agents);
    expect(killed).toBe(3);
    expect(killFn).toHaveBeenCalledTimes(3);
  });
});
