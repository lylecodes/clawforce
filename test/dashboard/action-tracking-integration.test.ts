/**
 * Integration tests for action tracking wired into dashboard action handlers.
 *
 * Tests that the real handleDomainKillAction / handleAgentKillAction / config and budget
 * handlers create and complete action records.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock heavy dependencies ---
vi.mock("../../src/enforcement/disabled-store.js", () => ({
  disableAgent: vi.fn(),
  enableAgent: vi.fn(),
  disableDomain: vi.fn(),
  enableDomain: vi.fn(),
  isDomainDisabled: vi.fn(() => false),
}));

vi.mock("../../src/safety.js", () => ({
  activateEmergencyStop: vi.fn(),
  deactivateEmergencyStop: vi.fn(),
  isEmergencyStopActive: vi.fn(() => false),
}));

vi.mock("../../src/audit/auto-kill.js", () => ({
  killStuckAgent: vi.fn(async () => false),
}));

vi.mock("../../src/audit.js", () => ({
  writeAuditEntry: vi.fn(),
}));

vi.mock("../../src/dashboard/sse.js", () => ({
  emitSSE: vi.fn(),
  getSSEManager: vi.fn(() => ({
    broadcast: vi.fn(),
  })),
}));

vi.mock("../../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
}));

vi.mock("../../src/project.js", () => ({
  getRegisteredAgentIds: vi.fn(() => []),
  getAgentConfig: vi.fn(() => null),
  getExtendedProjectConfig: vi.fn(() => null),
}));

vi.mock("../../src/config/api-service.js", () => ({
  updateDomainConfig: vi.fn(() => ({ ok: true })),
  updateGlobalAgentConfig: vi.fn(() => ({ ok: true })),
  upsertGlobalAgents: vi.fn(() => ({ ok: true })),
  writeDomainConfig: vi.fn(() => ({ ok: true })),
  reloadAllDomains: vi.fn(() => ({ domains: [], errors: [] })),
  readDomainConfig: vi.fn(() => null),
  readGlobalConfig: vi.fn(() => ({ agents: {} })),
}));

vi.mock("../../src/budget-cascade.js", () => ({
  allocateBudget: vi.fn(() => ({ ok: true })),
}));

vi.mock("../../src/budget/normalize.js", () => ({
  normalizeBudgetConfig: vi.fn((c: unknown) => c ?? {}),
}));

vi.mock("../../src/locks/store.js", () => ({
  acquireLock: vi.fn(() => ({ ok: true })),
  releaseLock: vi.fn(),
}));

vi.mock("../../src/locks/enforce.js", () => ({
  checkLock: vi.fn(() => ({ locked: false })),
}));

// --- Override the action-status module to use an in-memory DB ---
import { getMemoryDb } from "../../src/db.js";
import {
  createActionRecord,
  ensureActionStatusTable,
  getActionRecord,
  listActionRecords,
  withActionTracking,
} from "../../src/dashboard/action-status.js";

// We'll use a shared in-memory db per test and inject it via the db module override
let testDb: ReturnType<typeof getMemoryDb>;

vi.mock("../../src/db.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/db.js")>("../../src/db.js");
  return {
    ...actual,
    getDb: vi.fn(() => testDb),
    getMemoryDb: actual.getMemoryDb,
  };
});

import {
  handleDomainKillAction,
  handleAgentKillAction,
} from "../../src/dashboard/actions.js";

describe("Domain kill action tracking", () => {
  beforeEach(() => {
    testDb = getMemoryDb();
    ensureActionStatusTable(testDb);
    vi.clearAllMocks();
  });

  it("creates and completes an action record on successful domain kill", async () => {
    const result = await handleDomainKillAction("test-domain", { actor: "admin", reason: "test" });

    expect(result.status).toBe(200);
    expect((result.body as Record<string, unknown>).ok).toBe(true);

    const records = listActionRecords("test-domain", undefined, testDb);
    expect(records).toHaveLength(1);
    expect(records[0]!.action).toBe("domain_kill");
    expect(records[0]!.status).toBe("completed");
    expect(records[0]!.actor).toBe("admin");
    expect((result.body as Record<string, unknown>).actionId).toBe(records[0]!.id);
  });

  it("creates a failed action record when domain kill throws", async () => {
    const { activateEmergencyStop } = await import("../../src/safety.js");
    vi.mocked(activateEmergencyStop).mockImplementationOnce(() => {
      throw new Error("emergency stop failed");
    });

    const result = await handleDomainKillAction("test-domain", { actor: "admin", reason: "test" });

    expect(result.status).toBe(500);

    const records = listActionRecords("test-domain", undefined, testDb);
    // We expect a record to exist — it should be failed
    const failedRecords = records.filter((r) => r.status === "failed");
    expect(failedRecords).toHaveLength(1);
    expect(failedRecords[0]!.error).toBe("emergency stop failed");
  });
});

describe("Agent kill action tracking", () => {
  beforeEach(() => {
    testDb = getMemoryDb();
    ensureActionStatusTable(testDb);
    vi.clearAllMocks();
  });

  it("creates and completes an action record on successful agent kill", async () => {
    // Make getRegisteredAgentIds return our test agent so it passes the isKnownProjectAgent check
    const { getRegisteredAgentIds, getAgentConfig } = await import("../../src/project.js");
    vi.mocked(getRegisteredAgentIds).mockReturnValue(["agent1"]);
    vi.mocked(getAgentConfig).mockReturnValue({
      projectId: "test-domain",
      projectDir: "/tmp/test",
      config: {} as never,
    });

    const result = await handleAgentKillAction("test-domain", "agent1", {
      actor: "admin",
      reason: "test kill",
    });

    expect(result.status).toBe(200);
    expect((result.body as Record<string, unknown>).ok).toBe(true);

    const records = listActionRecords("test-domain", undefined, testDb);
    expect(records).toHaveLength(1);
    expect(records[0]!.action).toBe("agent_kill");
    expect(records[0]!.status).toBe("completed");
    expect((result.body as Record<string, unknown>).actionId).toBe(records[0]!.id);
  });

  it("returns 404 without creating a record for unknown agent", async () => {
    const { getRegisteredAgentIds } = await import("../../src/project.js");
    // Return agents list so the agent IS validated against
    vi.mocked(getRegisteredAgentIds).mockReturnValue(["other-agent"]);

    const result = await handleAgentKillAction("test-domain", "unknown-agent", {
      actor: "admin",
    });

    expect(result.status).toBe(404);

    const records = listActionRecords("test-domain", undefined, testDb);
    expect(records).toHaveLength(0);
  });
});

describe("queryActionStatus returns recent records", () => {
  beforeEach(() => {
    testDb = getMemoryDb();
    ensureActionStatusTable(testDb);
    vi.clearAllMocks();
  });

  it("returns records via queryActionStatus after kills", async () => {
    const { queryActionStatus } = await import("../../src/dashboard/queries.js");

    // Run a domain kill to generate a record
    await handleDomainKillAction("test-domain", { actor: "admin", reason: "test" });

    const response = queryActionStatus("test-domain");
    expect(response.count).toBe(1);
    expect(response.records[0]!.action).toBe("domain_kill");
    expect(response.records[0]!.status).toBe("completed");
  });

  it("queryActionStatus filters by status", async () => {
    const { queryActionStatus } = await import("../../src/dashboard/queries.js");

    await handleDomainKillAction("test-domain", { actor: "admin", reason: "test" });

    const completedResponse = queryActionStatus("test-domain", { status: "completed" });
    expect(completedResponse.count).toBe(1);

    const failedResponse = queryActionStatus("test-domain", { status: "failed" });
    expect(failedResponse.count).toBe(0);
  });
});

describe("withActionTracking returns actionId", () => {
  beforeEach(() => {
    testDb = getMemoryDb();
    ensureActionStatusTable(testDb);
    vi.clearAllMocks();
  });

  it("returns actionId that matches the persisted record", async () => {
    const { actionId, result } = await withActionTracking(
      "test-domain",
      "domain_kill",
      "admin",
      async () => "done",
      testDb,
    );

    expect(actionId).toBeTruthy();
    expect(result).toBe("done");

    const record = getActionRecord(actionId, testDb);
    expect(record).toBeDefined();
    expect(record!.id).toBe(actionId);
    expect(record!.status).toBe("completed");
  });

  it("reuses existingActionId when provided", async () => {
    // Pre-create the record as the 202 caller would
    const preId = createActionRecord("test-domain", "agent_kill", "admin", undefined, testDb);

    const { actionId } = await withActionTracking(
      "test-domain",
      "agent_kill",
      "admin",
      async () => 42,
      testDb,
      preId,
    );

    // Should reuse the same ID, not create a second record
    expect(actionId).toBe(preId);
    const records = listActionRecords("test-domain", undefined, testDb);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(preId);
    expect(records[0]!.status).toBe("completed");
  });
});

describe("202 response includes actionId and statusUrl", () => {
  beforeEach(() => {
    testDb = getMemoryDb();
    ensureActionStatusTable(testDb);
    vi.clearAllMocks();
  });

  it("domain kill handler returns actionId in result when called directly with existingActionId", async () => {
    const preId = createActionRecord("test-domain", "domain_kill", "admin", undefined, testDb);

    const result = await handleDomainKillAction("test-domain", { actor: "admin", reason: "test" }, preId);

    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.actionId).toBe(preId);
  });

  it("agent kill handler returns actionId in result when called with existingActionId", async () => {
    const { getRegisteredAgentIds, getAgentConfig } = await import("../../src/project.js");
    vi.mocked(getRegisteredAgentIds).mockReturnValue(["agent1"]);
    vi.mocked(getAgentConfig).mockReturnValue({
      projectId: "test-domain",
      projectDir: "/tmp/test",
      config: {} as never,
    });

    const preId = createActionRecord("test-domain", "agent_kill", "admin", undefined, testDb);

    const result = await handleAgentKillAction("test-domain", "agent1", { actor: "admin" }, preId);

    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.actionId).toBe(preId);

    // Exactly one record (the pre-created one, now completed)
    const records = listActionRecords("test-domain", undefined, testDb);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(preId);
    expect(records[0]!.status).toBe("completed");
  });
});

describe("Enriched SSE action_status payload", () => {
  beforeEach(() => {
    testDb = getMemoryDb();
    ensureActionStatusTable(testDb);
    vi.clearAllMocks();
  });

  it("domain kill emits action_status with actionType=domain_kill and state", async () => {
    const { emitSSE } = await import("../../src/dashboard/sse.js");

    await handleDomainKillAction("test-domain", { actor: "admin", reason: "test" });

    const calls = vi.mocked(emitSSE).mock.calls.filter(
      (c) => c[1] === "action_status",
    );
    expect(calls.length).toBeGreaterThan(0);

    const completedCall = calls.find(
      (c) => (c[2] as Record<string, unknown>).state === "completed",
    );
    expect(completedCall).toBeDefined();
    expect((completedCall![2] as Record<string, unknown>).actionType).toBe("domain_kill");
    expect((completedCall![2] as Record<string, unknown>).actionId).toBeTruthy();
  });

  it("agent kill emits action_status with actionType=agent_kill on failure", async () => {
    const { emitSSE } = await import("../../src/dashboard/sse.js");
    const { getRegisteredAgentIds, getAgentConfig } = await import("../../src/project.js");
    vi.mocked(getRegisteredAgentIds).mockReturnValue(["agent1"]);
    vi.mocked(getAgentConfig).mockReturnValue({
      projectId: "test-domain",
      projectDir: "/tmp/test",
      config: {} as never,
    });

    const { killStuckAgent } = await import("../../src/audit/auto-kill.js");
    vi.mocked(killStuckAgent).mockRejectedValueOnce(new Error("kill failed hard"));

    const preId = createActionRecord("test-domain", "agent_kill", "admin", undefined, testDb);
    await handleAgentKillAction("test-domain", "agent1", { actor: "admin" }, preId);

    const calls = vi.mocked(emitSSE).mock.calls.filter(
      (c) => c[1] === "action_status",
    );

    const failedCall = calls.find(
      (c) => (c[2] as Record<string, unknown>).state === "failed",
    );
    expect(failedCall).toBeDefined();
    expect((failedCall![2] as Record<string, unknown>).actionType).toBe("agent_kill");
    expect((failedCall![2] as Record<string, unknown>).error).toBeTruthy();
    expect((failedCall![2] as Record<string, unknown>).actionId).toBe(preId);
  });
});

describe("Single action record endpoint via getActionRecord", () => {
  beforeEach(() => {
    testDb = getMemoryDb();
    ensureActionStatusTable(testDb);
    vi.clearAllMocks();
  });

  it("getActionRecord returns the record created by a kill handler", async () => {
    const result = await handleDomainKillAction("test-domain", { actor: "admin", reason: "endpoint test" });

    expect(result.status).toBe(200);
    const actionId = (result.body as Record<string, unknown>).actionId as string;
    expect(actionId).toBeTruthy();

    const record = getActionRecord(actionId, testDb);
    expect(record).toBeDefined();
    expect(record!.id).toBe(actionId);
    expect(record!.action).toBe("domain_kill");
    expect(record!.status).toBe("completed");
    expect(record!.actor).toBe("admin");
  });

  it("getActionRecord returns undefined for unknown ID", () => {
    const record = getActionRecord("nonexistent-id", testDb);
    expect(record).toBeUndefined();
  });
});
