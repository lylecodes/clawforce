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

const mockDispatch = vi.hoisted(() => vi.fn());
vi.mock("../../src/dispatch/spawn.js", () => ({
  dispatchClaudeCode: mockDispatch,
}));

const { getMemoryDb } = await import("../../src/db.js");
const { createClawforceVerifyTool } = await import("../../src/tools/verify-tool.js");
const { createTask, transitionTask, attachEvidence } = await import("../../src/tasks/ops.js");

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

  it("dispatches verification request for a REVIEW task", async () => {
    const task = createTask({ projectId: PROJECT, title: "Verify me", createdBy: "agent:a" }, db);
    moveToReview(task.id);

    mockDispatch.mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: "VERDICT: PASS\n\nThe work meets all requirements.",
      stderr: "",
    });

    const result = await exec({
      action: "request",
      project_id: PROJECT,
      task_id: task.id,
      project_dir: "/tmp",
    });

    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.passed).toBe(true);
    expect(mockDispatch).toHaveBeenCalledOnce();
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
      reason: "Missing test coverage",
    });

    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.task.state).toBe("IN_PROGRESS");
  });

  it("defaults project_id to 'default' when omitted", async () => {
    // Should not throw — project_id is now optional
    const result = await exec({
      action: "verdict",
      task_id: "nonexistent",
      passed: true,
      reason: "ok",
    });
    const data = parseResult(result);
    // Task won't exist in default project, but it should not error on missing project_id
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

  it("handles dispatch failure", async () => {
    const task = createTask({ projectId: PROJECT, title: "Fail dispatch", createdBy: "agent:a" }, db);
    moveToReview(task.id);

    mockDispatch.mockResolvedValue({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "connection timeout",
    });

    const result = await exec({
      action: "request",
      project_id: PROJECT,
      task_id: task.id,
      project_dir: "/tmp",
    });

    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.passed).toBe(false);
    expect(data.reason).toContain("exit code");
  });
});
