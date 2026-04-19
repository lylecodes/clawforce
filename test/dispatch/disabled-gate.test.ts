import type { DatabaseSync } from "../../src/sqlite-driver.js";
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

// Mock the inject-dispatch module to avoid actually starting agent sessions
const mockDispatchViaInject = vi.fn();
vi.mock("../../src/dispatch/inject-dispatch.js", () => ({
  dispatchViaInject: mockDispatchViaInject,
}));

// Mock spawn module — only buildTaskPrompt is used now
vi.mock("../../src/dispatch/spawn.js", () => ({
  buildTaskPrompt: vi.fn((_task: unknown, prompt: string) => prompt),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createTask } = await import("../../src/tasks/ops.js");
const { enqueue, getQueueStatus } = await import("../../src/dispatch/queue.js");
const { dispatchLoop, resetDispatcherForTest } = await import("../../src/dispatch/dispatcher.js");
const { disableAgent, enableAgent, disableDomain, enableDomain } = await import("../../src/enforcement/disabled-store.js");

describe("dispatch/disabled-gate", () => {
  let db: DatabaseSync;
  const PROJECT = "test-project";

  beforeEach(() => {
    db = getMemoryDb();
    resetDispatcherForTest();
    mockDispatchViaInject.mockReset();
    mockDispatchViaInject.mockResolvedValue({ ok: true, sessionKey: "agent:test:dispatch:test" });
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("fails dispatch when agent is individually disabled", async () => {
    const task = createTask({
      projectId: PROJECT, title: "Test disabled agent", createdBy: "agent:pm", assignedTo: "agent:worker",
      description: "Acceptance criteria: test passes",
    }, db);

    // Disable the agent
    disableAgent(PROJECT, "agent:worker", "test disable", db);

    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(1); // Item was processed (but failed)

    // Verify item was failed
    const status = getQueueStatus(PROJECT, db);
    expect(status.queued).toBe(0);
    expect(status.failed).toBe(1);

    // Check the failure reason
    const failedItem = db.prepare(
      "SELECT last_error FROM dispatch_queue WHERE project_id = ? AND status = 'failed'",
    ).get(PROJECT) as Record<string, unknown>;
    expect(failedItem.last_error).toContain("disabled");
  });

  it("fails dispatch when domain is disabled", async () => {
    const task = createTask({
      projectId: PROJECT, title: "Test disabled domain", createdBy: "agent:pm", assignedTo: "agent:worker",
      description: "Acceptance criteria: test passes",
    }, db);

    // Disable the domain
    disableDomain(PROJECT, "maintenance", undefined, db);

    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(1);

    const status = getQueueStatus(PROJECT, db);
    expect(status.queued).toBe(0);
    expect(status.failed).toBe(1);

    const failedItem = db.prepare(
      "SELECT last_error FROM dispatch_queue WHERE project_id = ? AND status = 'failed'",
    ).get(PROJECT) as Record<string, unknown>;
    expect(failedItem.last_error).toContain("Domain is disabled");
  });

  it("dispatches successfully when agent is enabled", async () => {
    const task = createTask({
      projectId: PROJECT, title: "Test enabled agent", createdBy: "agent:pm", assignedTo: "agent:worker",
      description: "Acceptance criteria: test passes",
    }, db);

    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(1);

    // Item should be dispatched (not failed)
    const dispatchedRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? AND status = 'dispatched'",
    ).get(PROJECT) as Record<string, unknown>;
    expect(dispatchedRow.cnt).toBe(1);
  });

  it("dispatches successfully after agent is re-enabled", async () => {
    const task = createTask({
      projectId: PROJECT, title: "Test re-enabled agent", createdBy: "agent:pm", assignedTo: "agent:worker",
      description: "Acceptance criteria: test passes",
    }, db);

    // Disable then re-enable
    disableAgent(PROJECT, "agent:worker", "temporary", db);
    enableAgent(PROJECT, "agent:worker", db);

    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(1);

    const dispatchedRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? AND status = 'dispatched'",
    ).get(PROJECT) as Record<string, unknown>;
    expect(dispatchedRow.cnt).toBe(1);
  });

  it("dispatches successfully after domain is re-enabled", async () => {
    const task = createTask({
      projectId: PROJECT, title: "Test re-enabled domain", createdBy: "agent:pm", assignedTo: "agent:worker",
      description: "Acceptance criteria: test passes",
    }, db);

    // Disable then re-enable domain
    disableDomain(PROJECT, "temporary", undefined, db);
    enableDomain(PROJECT, db);

    enqueue(PROJECT, task.id, { prompt: "do it" }, undefined, db);

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(1);

    const dispatchedRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? AND status = 'dispatched'",
    ).get(PROJECT) as Record<string, unknown>;
    expect(dispatchedRow.cnt).toBe(1);
  });
});
