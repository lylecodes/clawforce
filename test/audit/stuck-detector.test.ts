import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectPersistedStuckAgents, detectStuckAgents } from "../../src/audit/stuck-detector.js";
import {
  getSession,
  listPersistedTrackedSessions,
  recordSessionProgress,
  recordToolCall,
  resetTrackerForTest,
  startTracking,
} from "../../src/enforcement/tracker.js";
import type { AgentConfig } from "../../src/types.js";

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");

const cronConfig: AgentConfig = {
  extends: "employee",
  briefing: [{ source: "instructions" }],
  expectations: [
    { tool: "clawforce_log", action: "outcome", min_calls: 1 },
  ],
  performance_policy: { action: "retry", max_retries: 3, then: "terminate_and_alert" },
};

describe("stuck detector", () => {
  let db: ReturnType<typeof getMemoryDb>;

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    resetTrackerForTest();
    try { db.close(); } catch {}
    vi.restoreAllMocks();
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

  it("preserves default timeouts when optional config fields are undefined", () => {
    startTracking("sess1", "outreach", "proj1", cronConfig);

    const session = getSession("sess1")!;
    session.metrics.startedAt = Date.now() - 5_000;

    const stuck = detectStuckAgents({ stuckTimeoutMs: undefined });
    expect(stuck).toHaveLength(0);
  });

  it("does not flag no-MCP direct sessions for missing tool telemetry", () => {
    startTracking("sess1", "outreach", "proj1", cronConfig, undefined, {
      expectsToolTelemetry: false,
    });

    const session = getSession("sess1")!;
    session.metrics.startedAt = Date.now() - 400_000;

    const stuck = detectStuckAgents({ stuckTimeoutMs: 300_000 });
    expect(stuck).toHaveLength(0);
  });

  it("does not flag zero-tool no-MCP sessions that still emit transcript progress", () => {
    startTracking("sess1", "outreach", "proj1", cronConfig, undefined, {
      expectsToolTelemetry: false,
    });

    const session = getSession("sess1")!;
    session.metrics.startedAt = Date.now() - 400_000;
    recordSessionProgress("sess1");
    session.metrics.lastProgressAt = Date.now() - 5_000;

    const stuck = detectStuckAgents({
      stuckTimeoutMs: 300_000,
      idleTimeoutMs: 180_000,
    });
    expect(stuck).toHaveLength(0);
  });

  it("flags telemetry-expected sessions even if transcript progress continues", () => {
    startTracking("sess1", "outreach", "proj1", cronConfig);

    const session = getSession("sess1")!;
    session.metrics.startedAt = Date.now() - 400_000;
    recordSessionProgress("sess1");
    session.metrics.firstProgressAt = Date.now() - 350_000;
    session.metrics.lastProgressAt = Date.now() - 5_000;

    const stuck = detectStuckAgents({
      stuckTimeoutMs: 300_000,
      idleTimeoutMs: 180_000,
    });
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.reason).toContain("transcript progress");
  });

  it("flags transcript-progress no-MCP sessions once progress goes idle", () => {
    startTracking("sess1", "outreach", "proj1", cronConfig, undefined, {
      expectsToolTelemetry: false,
    });

    const session = getSession("sess1")!;
    session.metrics.startedAt = Date.now() - 400_000;
    recordSessionProgress("sess1");
    session.metrics.firstProgressAt = Date.now() - 350_000;
    session.metrics.lastProgressAt = Date.now() - 200_000;

    const stuck = detectStuckAgents({
      stuckTimeoutMs: 300_000,
      idleTimeoutMs: 180_000,
    });
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.reason).toContain("No transcript progress");
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

  it("detects persisted stale sessions that are no longer in local tracker memory", () => {
    db.prepare(`
      INSERT INTO tracked_sessions (session_key, agent_id, project_id, started_at, requirements, satisfied, tool_call_count, last_persisted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "persisted-stale",
      "outreach",
      "proj1",
      Date.now() - 400_000,
      "[]",
      "{}",
      0,
      Date.now() - 320_000,
    );

    const rows = listPersistedTrackedSessions("proj1", db);
    expect(rows).toHaveLength(1);

    const stuck = detectPersistedStuckAgents("proj1", db, { stuckTimeoutMs: 300_000 });
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.sessionKey).toBe("persisted-stale");
    expect(stuck[0]!.reason).toContain("Persisted session stale");
  });

  it("preserves persisted-session defaults when optional config fields are undefined", () => {
    db.prepare(`
      INSERT INTO tracked_sessions (session_key, agent_id, project_id, started_at, requirements, satisfied, tool_call_count, last_persisted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "persisted-healthy",
      "outreach",
      "proj1",
      Date.now() - 5_000,
      "[]",
      "{}",
      0,
      Date.now() - 2_000,
    );

    const stuck = detectPersistedStuckAgents("proj1", db, { stuckTimeoutMs: undefined });
    expect(stuck).toHaveLength(0);
  });
});
