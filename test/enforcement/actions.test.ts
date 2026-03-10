import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeFailureAction, executeCrashAction } from "../../src/enforcement/actions.js";
import { checkCompliance } from "../../src/enforcement/check.js";
import {
  recordToolCall,
  resetTrackerForTest,
  startTracking,
  getSession,
} from "../../src/enforcement/tracker.js";
import type { AgentConfig } from "../../src/types.js";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

// Mock getDb to use in-memory DB
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

describe("failure actions", () => {
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

  function getNonCompliantResult() {
    startTracking("sess1", "coder", "proj1", workerConfig);
    const session = getSession("sess1")!;
    return checkCompliance(session);
  }

  it("returns retry with prompt when under max_retries", () => {
    const result = getNonCompliantResult();
    // No previous retries in DB → should retry
    const action = executeFailureAction(
      { action: "retry", max_retries: 3, then: "alert" },
      result,
    );

    expect(action.action).toBe("retry");
    expect(action.retryPrompt).toContain("did not meet expectations");
    expect(action.retryPrompt).toContain("clawforce_task");
  });

  it("escalates to then action when retries exhausted", () => {
    // Seed 3 retries in the DB
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO enforcement_retries (id, project_id, agent_id, session_key, attempted_at, outcome)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`retry-${i}`, "proj1", "coder", `sess-${i}`, Date.now(), "retry");
    }

    const result = getNonCompliantResult();
    const action = executeFailureAction(
      { action: "retry", max_retries: 3, then: "alert" },
      result,
    );

    expect(action.action).toBe("alert");
    expect(action.alertMessage).toBeDefined();
  });

  it("escalates to terminate_and_alert when configured", () => {
    // Seed 2 retries
    for (let i = 0; i < 2; i++) {
      db.prepare(`
        INSERT INTO enforcement_retries (id, project_id, agent_id, session_key, attempted_at, outcome)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`retry-${i}`, "proj1", "coder", `sess-${i}`, Date.now(), "retry");
    }

    const result = getNonCompliantResult();
    const action = executeFailureAction(
      { action: "retry", max_retries: 2, then: "terminate_and_alert" },
      result,
    );

    expect(action.action).toBe("terminate_and_alert");
    expect(action.disabled).toBe(true);
    expect(action.alertMessage).toContain("Exhausted 2 retries");
  });

  it("returns alert directly when action is alert", () => {
    const result = getNonCompliantResult();
    const action = executeFailureAction(
      { action: "alert" },
      result,
    );

    expect(action.action).toBe("alert");
    expect(action.alertMessage).toContain("coder");
  });

  it("returns terminate_and_alert directly", () => {
    const result = getNonCompliantResult();
    const action = executeFailureAction(
      { action: "terminate_and_alert" },
      result,
    );

    expect(action.action).toBe("terminate_and_alert");
    expect(action.disabled).toBe(true);
  });
});

describe("crash actions", () => {
  let db: ReturnType<typeof getMemoryDb>;

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    vi.restoreAllMocks();
  });

  it("returns retry for crash under max_retries", () => {
    const action = executeCrashAction(
      { action: "retry", max_retries: 3, then: "alert" },
      "proj1", "coder", "sess1",
      "Process killed",
      null,
    );

    expect(action.action).toBe("retry");
    expect(action.retryPrompt).toContain("crashed");
    expect(action.retryPrompt).toContain("Process killed");
  });

  it("includes tool call count in crash retry prompt when metrics provided", () => {
    const metrics = {
      startedAt: Date.now() - 5000,
      toolCalls: [
        { toolName: "clawforce_task", action: "get", timestamp: Date.now(), durationMs: 100, success: true },
        { toolName: "clawforce_log", action: "write", timestamp: Date.now(), durationMs: 50, success: true },
      ],
      firstToolCallAt: Date.now() - 4000,
      lastToolCallAt: Date.now() - 1000,
      requiredCallTimings: [],
      errorCount: 0,
    };

    const action = executeCrashAction(
      { action: "retry", max_retries: 3, then: "alert" },
      "proj1", "coder", "sess1",
      "OOM",
      metrics,
    );

    expect(action.action).toBe("retry");
    expect(action.retryPrompt).toContain("Tool calls made: 2");
    expect(action.retryPrompt).toContain("clawforce_log");
  });

  it("escalates crash after max retries", () => {
    // Seed 2 retries
    for (let i = 0; i < 2; i++) {
      db.prepare(`
        INSERT INTO enforcement_retries (id, project_id, agent_id, session_key, attempted_at, outcome)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`retry-${i}`, "proj1", "coder", `sess-${i}`, Date.now(), "retry");
    }

    const action = executeCrashAction(
      { action: "retry", max_retries: 2, then: "terminate_and_alert" },
      "proj1", "coder", "sess1",
      "timeout",
      null,
    );

    expect(action.action).toBe("terminate_and_alert");
    expect(action.disabled).toBe(true);
    expect(action.alertMessage).toContain("Employee coder is unresponsive after 2 retries");
  });

  it("returns alert for crash with alert action", () => {
    const action = executeCrashAction(
      { action: "alert" },
      "proj1", "coder", "sess1",
      "OOM",
      null,
    );

    expect(action.action).toBe("alert");
    expect(action.alertMessage).toContain("OOM");
  });
});
