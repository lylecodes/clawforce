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

const { getMemoryDb } = await import("../../src/db.js");
const { createClawforceVerifyTool } = await import("../../src/tools/verify-tool.js");
const { createTask, transitionTask, attachEvidence } = await import("../../src/tasks/ops.js");
const { getQueueStatus } = await import("../../src/dispatch/queue.js");

describe("clawforce_verify tool", () => {
  let db: DatabaseSync;
  const PROJECT = "verify-test";

  beforeEach(async () => {
    db = getMemoryDb();
    const dbModule = await import("../../src/db.js");
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    vi.restoreAllMocks();
  });

  function exec(params: Record<string, unknown>) {
    const tool = createClawforceVerifyTool({ agentSessionKey: "session:verifier" });
    return tool.execute("call-1", params);
  }

  function parseResult(result: { content: Array<{ text: string }> }) {
    return JSON.parse(result.content[0]!.text);
  }

  /** Move task through lifecycle to REVIEW state. */
  function moveToReview(taskId: string): void {
    transitionTask({ projectId: PROJECT, taskId, toState: "ASSIGNED", actor: "agent:a" }, db);
    transitionTask({ projectId: PROJECT, taskId, toState: "IN_PROGRESS", actor: "agent:a" }, db);
    attachEvidence({ projectId: PROJECT, taskId, type: "output", content: "work done", attachedBy: "agent:a" }, db);
    transitionTask({ projectId: PROJECT, taskId, toState: "REVIEW", actor: "agent:a" }, db);
  }

  it("enqueues verification request for a REVIEW task", async () => {
    const task = createTask({ projectId: PROJECT, title: "Verify me", createdBy: "agent:a" }, db);
    moveToReview(task.id);

    const result = await exec({
      action: "request",
      project_id: PROJECT,
      task_id: task.id,
      project_dir: "/tmp",
      agent_id: "agent:verifier",
    });

    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.queued).toBe(true);
    expect(data.queueItemId).toBeDefined();

    // Verify it's actually in the dispatch queue
    const queueStatus = getQueueStatus(PROJECT, db);
    expect(queueStatus.queued).toBeGreaterThanOrEqual(1);
    const row = db.prepare(
      "SELECT payload FROM dispatch_queue WHERE project_id = ? AND task_id = ? AND status = 'queued' LIMIT 1",
    ).get(PROJECT, task.id) as Record<string, unknown> | undefined;
    const payload = JSON.parse(String(row?.payload ?? "{}")) as Record<string, unknown>;
    expect(payload.agentId).toBe("agent:verifier");
  });

  it("returns error for non-REVIEW task", async () => {
    const task = createTask({ projectId: PROJECT, title: "Not ready", createdBy: "agent:a" }, db);

    const result = await exec({
      action: "request",
      project_id: PROJECT,
      task_id: task.id,
      project_dir: "/tmp",
    });

    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.reason).toContain("OPEN");
  });

  it("dedup prevents double-enqueue for same task", async () => {
    const task = createTask({ projectId: PROJECT, title: "Dedup verify", createdBy: "agent:a" }, db);
    moveToReview(task.id);

    // First request — enqueues
    const r1 = await exec({ action: "request", project_id: PROJECT, task_id: task.id, project_dir: "/tmp" });
    expect(parseResult(r1).queued).toBe(true);

    // Second request — dedup
    const r2 = await exec({ action: "request", project_id: PROJECT, task_id: task.id, project_dir: "/tmp" });
    const d2 = parseResult(r2);
    expect(d2.ok).toBe(true);
    expect(d2.queued).toBe(false);
    expect(d2.reason).toContain("dedup");
  });

  it("submits a PASS verdict", async () => {
    const task = createTask({ projectId: PROJECT, title: "Judge me", createdBy: "agent:a" }, db);
    moveToReview(task.id);

    const result = await exec({
      action: "verdict",
      project_id: PROJECT,
      task_id: task.id,
      passed: "true",
      reason: "Looks good",
    });

    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.task.state).toBe("DONE");
  });

  it("submits a FAIL verdict", async () => {
    const task = createTask({ projectId: PROJECT, title: "Needs work", createdBy: "agent:a" }, db);
    moveToReview(task.id);

    const result = await exec({
      action: "verdict",
      project_id: PROJECT,
      task_id: task.id,
      passed: "false",
      reason_code: "verification_environment_blocked",
      reason: "Missing test coverage",
    });

    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.task.state).toBe("IN_PROGRESS");
  });

  it("defaults project_id to 'default' when omitted", async () => {
    const result = await exec({
      action: "verdict",
      task_id: "nonexistent",
      passed: true,
      reason: "ok",
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.reason).toBeDefined();
  });

  it("accepts boolean true for passed param", async () => {
    const task = createTask({ projectId: PROJECT, title: "Bool pass test", createdBy: "agent:a" }, db);
    moveToReview(task.id);

    const result = await exec({
      action: "verdict",
      project_id: PROJECT,
      task_id: task.id,
      passed: true,
      reason: "Looks good",
    });

    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.task.state).toBe("DONE");
  });

  it("accepts boolean false for passed param", async () => {
    const task = createTask({ projectId: PROJECT, title: "Bool fail test", createdBy: "agent:a" }, db);
    moveToReview(task.id);

    const result = await exec({
      action: "verdict",
      project_id: PROJECT,
      task_id: task.id,
      passed: false,
      reason: "Needs fixes",
    });

    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.task.state).toBe("IN_PROGRESS");
  });
});
