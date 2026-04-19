import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  endSession,
  listPersistedTrackedSessions,
  persistSession,
  recoverOrphanedSessions,
  recordToolCall,
  resetTrackerForTest,
  setSessionProcessId,
  startTracking,
} from "../../src/enforcement/tracker.js";
import type { AgentConfig } from "../../src/types.js";

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");

const workerConfig: AgentConfig = {
  extends: "employee",
  briefing: [{ source: "instructions" }],
  expectations: [
    { tool: "clawforce_task", action: ["transition", "fail"], min_calls: 1 },
    { tool: "clawforce_log", action: "write", min_calls: 1 },
  ],
  performance_policy: { action: "retry", max_retries: 3, then: "alert" },
};

describe("session persistence (crash recovery)", () => {
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

  it("persists a row on startTracking", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);

    const rows = db.prepare("SELECT * FROM tracked_sessions WHERE session_key = ?").all("sess1") as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBe("coder");
    expect(rows[0]!.project_id).toBe("proj1");
    expect(rows[0]!.tool_call_count).toBe(0);
  });

  it("persists every 5th tool call (for non-requirement-satisfying calls)", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);

    // Record 4 tool calls with a tool that does NOT satisfy any requirement
    for (let i = 0; i < 4; i++) {
      recordToolCall("sess1", "some_other_tool", null, 50, true);
    }

    let rows = db.prepare("SELECT tool_call_count FROM tracked_sessions WHERE session_key = ?").all("sess1") as Record<string, unknown>[];
    // After startTracking persisted with 0, 4 calls is not a multiple of 5 — count should still be 0
    expect(rows[0]!.tool_call_count).toBe(0);

    // 5th call triggers persist
    recordToolCall("sess1", "some_other_tool", null, 50, true);

    rows = db.prepare("SELECT tool_call_count FROM tracked_sessions WHERE session_key = ?").all("sess1") as Record<string, unknown>[];
    expect(rows[0]!.tool_call_count).toBe(5);
  });

  it("persists immediately when a requirement-satisfying call is made", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);

    // Record a single tool call that satisfies a requirement
    recordToolCall("sess1", "clawforce_task", "transition", 50, true);

    const rows = db.prepare("SELECT tool_call_count FROM tracked_sessions WHERE session_key = ?").all("sess1") as Record<string, unknown>[];
    // Should have persisted immediately (tool_call_count = 1)
    expect(rows[0]!.tool_call_count).toBe(1);
  });

  it("removes persisted row on endSession", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);

    // Verify row exists
    let rows = db.prepare("SELECT * FROM tracked_sessions WHERE session_key = ?").all("sess1") as Record<string, unknown>[];
    expect(rows).toHaveLength(1);

    // End session should remove it
    endSession("sess1");

    rows = db.prepare("SELECT * FROM tracked_sessions WHERE session_key = ?").all("sess1") as Record<string, unknown>[];
    expect(rows).toHaveLength(0);
  });

  it("persists direct executor process ids for cross-process recovery", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);

    setSessionProcessId("sess1", 4242);

    const rows = db.prepare("SELECT process_id FROM tracked_sessions WHERE session_key = ?").all("sess1") as Record<string, unknown>[];
    expect(rows[0]!.process_id).toBe(4242);

    const sessions = listPersistedTrackedSessions("proj1", db);
    expect(sessions[0]!.processId).toBe(4242);
  });

  it("recoverOrphanedSessions finds and cleans up orphaned rows", () => {
    // Manually insert an orphaned session row (simulating a crash)
    db.prepare(`
      INSERT INTO tracked_sessions (session_key, agent_id, project_id, started_at, requirements, satisfied, tool_call_count, last_persisted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("orphan-sess", "coder", "proj1", Date.now() - 60000, "[]", "{}", 12, Date.now() - 30000);

    const orphans = recoverOrphanedSessions("proj1");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.sessionKey).toBe("orphan-sess");
    expect(orphans[0]!.agentId).toBe("coder");
    expect(orphans[0]!.toolCallCount).toBe(12);

    // Rows should be cleaned up
    const rows = db.prepare("SELECT * FROM tracked_sessions WHERE project_id = ?").all("proj1") as Record<string, unknown>[];
    expect(rows).toHaveLength(0);
  });

  it("recoverOrphanedSessions returns empty for no orphans", () => {
    const orphans = recoverOrphanedSessions("proj1");
    expect(orphans).toHaveLength(0);
  });

  it("recoverOrphanedSessions only recovers for specified project", () => {
    db.prepare(`
      INSERT INTO tracked_sessions (session_key, agent_id, project_id, started_at, requirements, satisfied, tool_call_count, last_persisted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("orphan-1", "coder", "proj1", Date.now(), "[]", "{}", 5, Date.now());

    db.prepare(`
      INSERT INTO tracked_sessions (session_key, agent_id, project_id, started_at, requirements, satisfied, tool_call_count, last_persisted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("orphan-2", "coder", "proj2", Date.now(), "[]", "{}", 3, Date.now());

    const orphans = recoverOrphanedSessions("proj1");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.sessionKey).toBe("orphan-1");

    // proj2 row should still exist
    const proj2Rows = db.prepare("SELECT * FROM tracked_sessions WHERE project_id = ?").all("proj2") as Record<string, unknown>[];
    expect(proj2Rows).toHaveLength(1);
  });
});
