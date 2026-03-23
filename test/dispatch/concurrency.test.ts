import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const mockDispatchViaCron = vi.fn();
vi.mock("../../src/dispatch/cron-dispatch.js", () => ({
  dispatchViaCron: mockDispatchViaCron,
}));

vi.mock("../../src/dispatch/spawn.js", () => ({
  buildTaskPrompt: vi.fn((_task: unknown, prompt: string) => prompt),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createTask } = await import("../../src/tasks/ops.js");
const { enqueue } = await import("../../src/dispatch/queue.js");
const { dispatchLoop, resetDispatcherForTest, getConcurrencyInfo, setMaxConcurrency, getDispatchRateInfo } = await import("../../src/dispatch/dispatcher.js");
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");

describe("dispatch concurrency + rate limiting", () => {
  let db: DatabaseSync;
  const PROJECT = "concurrency-test";

  beforeEach(() => {
    db = getMemoryDb();
    resetDispatcherForTest();
    resetEnforcementConfigForTest();
    mockDispatchViaCron.mockReset();
    mockDispatchViaCron.mockResolvedValue({ ok: true, cronJobName: "dispatch:test" });
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("respects global maxConcurrency", () => {
    const info = getConcurrencyInfo();
    expect(info.active).toBe(0);
    expect(info.max).toBe(3);
  });

  it("setMaxConcurrency updates global max", () => {
    setMaxConcurrency(5);
    expect(getConcurrencyInfo().max).toBe(5);
    setMaxConcurrency(3); // reset
  });

  it("respects per-project concurrency limit from config", async () => {
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: { "worker-1": { extends: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" } } },
      dispatch: { maxConcurrentDispatches: 1 },
    });

    // Create and enqueue 2 tasks
    const t1 = createTask({ projectId: PROJECT, title: "T1", createdBy: "pm", assignedTo: "worker-1" }, db);
    const t2 = createTask({ projectId: PROJECT, title: "T2", createdBy: "pm", assignedTo: "worker-1" }, db);
    enqueue(PROJECT, t1.id, { prompt: "do it" }, undefined, db);
    enqueue(PROJECT, t2.id, { prompt: "do it" }, undefined, db);

    // dispatchViaCron is async, so the concurrency check happens at claim time
    // With maxConcurrentDispatches=1, only 1 should dispatch per loop pass
    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(1);
  });

  it("respects per-project rate limit (maxDispatchesPerHour)", async () => {
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: { "worker-1": { extends: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" } } },
      dispatch: { maxDispatchesPerHour: 1 },
    });

    const t1 = createTask({ projectId: PROJECT, title: "Rate T1", createdBy: "pm", assignedTo: "worker-1" }, db);
    enqueue(PROJECT, t1.id, { prompt: "do it" }, undefined, db);
    const d1 = await dispatchLoop(PROJECT, db);
    expect(d1).toBe(1);

    // Second dispatch should be rate-limited (stays queued)
    const t2 = createTask({ projectId: PROJECT, title: "Rate T2", createdBy: "pm", assignedTo: "worker-1" }, db);
    enqueue(PROJECT, t2.id, { prompt: "do it" }, undefined, db);
    const d2 = await dispatchLoop(PROJECT, db);
    expect(d2).toBe(0); // rate-limited, items stay queued
  });

  it("fails agent-rate-limited items with descriptive message", async () => {
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: { "worker-1": { extends: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" } } },
      dispatch: { agentLimits: { "worker-1": { maxPerHour: 1 } } },
    });

    const t1 = createTask({ projectId: PROJECT, title: "Agent T1", createdBy: "pm", assignedTo: "worker-1" }, db);
    enqueue(PROJECT, t1.id, { prompt: "do it" }, undefined, db);
    await dispatchLoop(PROJECT, db);

    const t2 = createTask({ projectId: PROJECT, title: "Agent T2", createdBy: "pm", assignedTo: "worker-1" }, db);
    enqueue(PROJECT, t2.id, { prompt: "do it" }, undefined, db);
    const d2 = await dispatchLoop(PROJECT, db);
    expect(d2).toBe(1); // processed (but failed due to agent rate limit)

    // Check that the item was failed
    const row = db.prepare(
      "SELECT status, last_error FROM dispatch_queue WHERE task_id = ?",
    ).get(t2.id) as Record<string, unknown>;
    expect(row.status).toBe("failed");
    expect((row.last_error as string)).toContain("rate limit");
  });

  it("getDispatchRateInfo returns accurate info", async () => {
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: { "worker-1": { extends: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" } } },
      dispatch: { maxDispatchesPerHour: 10 },
    });

    const t1 = createTask({ projectId: PROJECT, title: "Info T1", createdBy: "pm", assignedTo: "worker-1" }, db);
    enqueue(PROJECT, t1.id, { prompt: "do it" }, undefined, db);
    await dispatchLoop(PROJECT, db);

    const info = getDispatchRateInfo(PROJECT);
    expect(info.recentHour).toBe(1);
    expect(info.config).not.toBeNull();
    expect(info.config!.maxDispatchesPerHour).toBe(10);
  });

  it("global maxConcurrency applies as hard ceiling", async () => {
    setMaxConcurrency(1);

    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: { "worker-1": { extends: "employee", briefing: [], expectations: [], performance_policy: { action: "alert" } } },
      dispatch: { maxConcurrentDispatches: 10 }, // project allows 10
    });

    const t1 = createTask({ projectId: PROJECT, title: "Global T1", createdBy: "pm", assignedTo: "worker-1" }, db);
    const t2 = createTask({ projectId: PROJECT, title: "Global T2", createdBy: "pm", assignedTo: "worker-1" }, db);
    enqueue(PROJECT, t1.id, { prompt: "do it" }, undefined, db);
    enqueue(PROJECT, t2.id, { prompt: "do it" }, undefined, db);

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(1); // global limit of 1

    setMaxConcurrency(3); // reset
  });
});
