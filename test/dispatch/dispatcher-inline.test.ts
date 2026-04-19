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

const mockExecuteDispatch = vi.fn();
vi.mock("../../src/dispatch/executors.js", () => ({
  executeDispatch: mockExecuteDispatch,
  resolveDispatchExecutorName: vi.fn(() => "codex"),
}));

vi.mock("../../src/dispatch/spawn.js", () => ({
  buildTaskPrompt: vi.fn((_task: unknown, prompt: string) => prompt),
}));

vi.mock("../../src/telemetry/session-archive.js", () => ({
  getSessionArchive: vi.fn(() => null),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createTask, getTaskEvidence } = await import("../../src/tasks/ops.js");
const { enqueue, getQueueStatus } = await import("../../src/dispatch/queue.js");
const { dispatchLoop, resetDispatcherForTest } = await import("../../src/dispatch/dispatcher.js");
const { listEvents } = await import("../../src/events/store.js");
const { resetEnforcementConfigForTest } = await import("../../src/project.js");
const { getSessionArchive } = await import("../../src/telemetry/session-archive.js");

describe("dispatch/dispatcher inline executors", () => {
  let db: DatabaseSync;
  const PROJECT = "inline-executor-project";

  beforeEach(() => {
    db = getMemoryDb();
    resetDispatcherForTest();
    resetEnforcementConfigForTest();
    mockExecuteDispatch.mockReset();
    vi.mocked(getSessionArchive).mockReturnValue(null);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("completes queue items inline when the local executor finishes the task", async () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Inline success",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
      description: "Acceptance criteria: task is completed inline.",
    }, db);

    enqueue(PROJECT, task.id, { prompt: "finish it" }, undefined, db);
    mockExecuteDispatch.mockImplementation(async (request: { projectId: string; taskId: string }) => {
      db.prepare("UPDATE tasks SET state = 'DONE', updated_at = ? WHERE id = ? AND project_id = ?")
        .run(Date.now(), request.taskId, request.projectId);
      return {
        ok: true,
        executor: "codex",
        sessionKey: "dispatch:inline-success",
        completedInline: true,
      };
    });

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(1);

    const status = getQueueStatus(PROJECT, db);
    expect(status.completed).toBe(1);
    expect(status.failed).toBe(0);

    const events = listEvents(PROJECT, { type: "dispatch_succeeded" }, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.executor).toBe("codex");
    expect(events[0]!.payload.completedInline).toBe(true);
  });

  it("auto-finalizes inline worker runs into REVIEW when the executor returns a summary", async () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Inline summary",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
      description: "Acceptance criteria: task changes state.",
    }, db);

    enqueue(PROJECT, task.id, { prompt: "summarize the work" }, undefined, db);
    mockExecuteDispatch.mockResolvedValue({
      ok: true,
      executor: "codex",
      sessionKey: "dispatch:inline-summary",
      completedInline: true,
      summary: "Updated the jurisdiction dossier and reran pipeline_health.",
    });

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(1);

    const status = getQueueStatus(PROJECT, db);
    expect(status.completed).toBe(1);
    expect(status.failed).toBe(0);

    const updatedTask = db.prepare("SELECT state FROM tasks WHERE id = ? AND project_id = ?")
      .get(task.id, PROJECT) as { state: string };
    expect(updatedTask.state).toBe("REVIEW");

    const evidence = getTaskEvidence(PROJECT, task.id, db);
    expect(evidence.some((item) => item.content.includes("reran pipeline_health"))).toBe(true);

    const events = listEvents(PROJECT, { type: "dispatch_succeeded" }, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.completedInline).toBe(true);
  });

  it("completes recurring inline runs through REVIEW into DONE", async () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Recurring sweep",
      createdBy: "system:recurring-job",
      assignedTo: "agent:worker",
      description: "Acceptance criteria: leave a concrete recurring sweep summary.",
      metadata: {
        recurringJob: {
          agentId: "agent:worker",
          jobName: "active-job",
          schedule: "*/15 * * * *",
          reason: "cron due",
          scheduledAt: Date.now(),
        },
      },
    }, db);

    enqueue(PROJECT, task.id, { prompt: "run the recurring sweep" }, undefined, db);
    mockExecuteDispatch.mockResolvedValue({
      ok: true,
      executor: "codex",
      sessionKey: "dispatch:recurring-inline",
      completedInline: true,
      summary: "Checked onboarding backlog and confirmed no new sources need attention.",
    });

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(1);

    const status = getQueueStatus(PROJECT, db);
    expect(status.completed).toBe(1);
    expect(status.failed).toBe(0);

    const updatedTask = db.prepare("SELECT state FROM tasks WHERE id = ? AND project_id = ?")
      .get(task.id, PROJECT) as { state: string };
    expect(updatedTask.state).toBe("DONE");

    const evidence = getTaskEvidence(PROJECT, task.id, db);
    expect(evidence.some((item) => item.content.includes("onboarding backlog"))).toBe(true);
  });

  it("auto-retries one silent inline no-op before failing it", async () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Inline no-op",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
      description: "Acceptance criteria: task changes state.",
    }, db);

    enqueue(PROJECT, task.id, { prompt: "do nothing" }, undefined, db);
    mockExecuteDispatch.mockResolvedValue({
      ok: true,
      executor: "codex",
      sessionKey: "dispatch:inline-noop",
      completedInline: true,
      summarySynthetic: true,
      observedWork: false,
    });

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(2);
    expect(mockExecuteDispatch).toHaveBeenCalledTimes(2);
    expect(mockExecuteDispatch.mock.calls[0]?.[0]).toMatchObject({
      queueItemId: expect.any(String),
      disableMcpBridge: false,
    });
    expect(mockExecuteDispatch.mock.calls[1]?.[0]).toMatchObject({
      queueItemId: expect.any(String),
      disableMcpBridge: true,
    });

    const status = getQueueStatus(PROJECT, db);
    expect(status.completed).toBe(0);
    expect(status.failed).toBe(1);

    const updatedTask = db.prepare("SELECT state FROM tasks WHERE id = ? AND project_id = ?")
      .get(task.id, PROJECT) as { state: string };
    expect(updatedTask.state).toBe("ASSIGNED");

    const events = listEvents(PROJECT, { type: "dispatch_failed" }, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.completedInline).toBe(true);
    expect(events[0]!.payload.error).toContain("without a final summary or observed work");
  });

  it("recovers an archived transcript when inline execution omits a direct summary", async () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Inline archived summary",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
      description: "Acceptance criteria: task changes state.",
    }, db);

    enqueue(PROJECT, task.id, { prompt: "summarize from archive" }, undefined, db);
    vi.mocked(getSessionArchive).mockReturnValue({
      id: "archive-1",
      sessionKey: "dispatch:inline-archived",
      agentId: "agent:worker",
      projectId: PROJECT,
      outcome: "untracked",
      transcript: "Recovered archive summary for inline finalization.",
      createdAt: Date.now(),
      startedAt: Date.now(),
    } as any);
    mockExecuteDispatch.mockResolvedValue({
      ok: true,
      executor: "codex",
      sessionKey: "dispatch:inline-archived",
      completedInline: true,
    });

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(1);
    expect(mockExecuteDispatch).toHaveBeenCalledTimes(1);

    const status = getQueueStatus(PROJECT, db);
    expect(status.completed).toBe(1);
    expect(status.failed).toBe(0);

    const updatedTask = db.prepare("SELECT state FROM tasks WHERE id = ? AND project_id = ?")
      .get(task.id, PROJECT) as { state: string };
    expect(updatedTask.state).toBe("REVIEW");

    const evidence = getTaskEvidence(PROJECT, task.id, db);
    expect(evidence.some((item) => item.content.includes("Recovered archive summary"))).toBe(true);
  });

  it("uses a fallback operator summary when the archive only contains a raw Codex launch transcript", async () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Inline transcript-only",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
      description: "Acceptance criteria: task changes state.",
    }, db);

    enqueue(PROJECT, task.id, { prompt: "launch only" }, undefined, db);
    vi.mocked(getSessionArchive).mockReturnValue({
      id: "archive-2",
      sessionKey: "dispatch:inline-transcript-only",
      agentId: "agent:worker",
      projectId: PROJECT,
      outcome: "untracked",
      transcript: [
        "Reading additional input from stdin...",
        "OpenAI Codex v0.118.0 (research preview)",
        "--------",
        "<task-metadata title=\"Inline transcript-only\">",
      ].join("\n"),
      createdAt: Date.now(),
      startedAt: Date.now(),
    } as any);
    mockExecuteDispatch.mockResolvedValue({
      ok: true,
      executor: "codex",
      sessionKey: "dispatch:inline-transcript-only",
      completedInline: true,
      summarySynthetic: true,
      observedWork: false,
    });

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(2);
    expect(mockExecuteDispatch).toHaveBeenCalledTimes(2);

    const status = getQueueStatus(PROJECT, db);
    expect(status.completed).toBe(0);
    expect(status.failed).toBe(1);

    const updatedTask = db.prepare("SELECT state FROM tasks WHERE id = ? AND project_id = ?")
      .get(task.id, PROJECT) as { state: string };
    expect(updatedTask.state).toBe("ASSIGNED");

    const events = listEvents(PROJECT, { type: "dispatch_failed" }, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.completedInline).toBe(true);
    expect(events[0]!.payload.error).toContain("without a final summary or observed work");
  });

  it("finalizes inline work even if the task lease holder drifted before completion", async () => {
    const task = createTask({
      projectId: PROJECT,
      title: "Inline lease drift",
      createdBy: "agent:pm",
      assignedTo: "agent:worker",
      description: "Acceptance criteria: task changes state.",
    }, db);

    enqueue(PROJECT, task.id, { prompt: "complete despite lease drift" }, undefined, db);
    mockExecuteDispatch.mockImplementation(async (request: { projectId: string; taskId: string }) => {
      db.prepare(
        "UPDATE tasks SET lease_holder = ?, lease_expires_at = ? WHERE id = ? AND project_id = ?",
      ).run("dispatch:foreign-holder", Date.now() + 60_000, request.taskId, request.projectId);
      return {
        ok: true,
        executor: "codex",
        sessionKey: "dispatch:inline-lease-drift",
        completedInline: true,
        summary: "Applied the workflow mutation and documented the rerun contract.",
      };
    });

    const dispatched = await dispatchLoop(PROJECT, db);
    expect(dispatched).toBe(1);

    const status = getQueueStatus(PROJECT, db);
    expect(status.completed).toBe(1);
    expect(status.failed).toBe(0);

    const updatedTask = db.prepare("SELECT state, lease_holder FROM tasks WHERE id = ? AND project_id = ?")
      .get(task.id, PROJECT) as { state: string; lease_holder: string | null };
    expect(updatedTask.state).toBe("REVIEW");
    expect(updatedTask.lease_holder).toBeNull();
  });
});
