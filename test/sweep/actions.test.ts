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

// Mock auto-kill to avoid needing real abort controllers
vi.mock("../../src/audit/auto-kill.js", () => ({
  killAllStuckAgents: vi.fn(async () => 0),
}));

// Mock stuck detector
vi.mock("../../src/audit/stuck-detector.js", () => ({
  detectStuckAgents: vi.fn(() => []),
}));

// Mock dispatch modules to prevent actual spawning/cron creation
vi.mock("../../src/dispatch/spawn.js", () => ({
  buildTaskPrompt: vi.fn(() => "mock prompt"),
}));
vi.mock("../../src/dispatch/inject-dispatch.js", () => ({
  dispatchViaInject: vi.fn(async () => ({ ok: false, error: "mock: not available in tests" })),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { sweep } = await import("../../src/sweep/actions.js");
const { createTask, transitionTask } = await import("../../src/tasks/ops.js");
const { addDependency } = await import("../../src/tasks/deps.js");
const { createWorkflow, addTaskToPhase } = await import("../../src/workflow.js");
const { killAllStuckAgents } = await import("../../src/audit/auto-kill.js");
const { detectStuckAgents } = await import("../../src/audit/stuck-detector.js");
const { emitDiagnosticEvent } = await import("../../src/diagnostics.js");

describe("sweep", () => {
  let db: DatabaseSync;
  const PROJECT = "sweep-test";

  beforeEach(() => {
    db = getMemoryDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("returns zero counts on empty project", async () => {
    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.stale).toBe(0);
    expect(result.autoBlocked).toBe(0);
    expect(result.deadlineExpired).toBe(0);
    expect(result.workflowsAdvanced).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.complianceBlocked).toBe(0);
    expect(result.stuckKilled).toBe(0);
  });

  it("detects stale tasks", async () => {
    const task = createTask(
      { projectId: PROJECT, title: "Stale task", createdBy: "agent:a" },
      db,
    );
    transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:a" },
      db,
    );

    // Backdate the task and transition
    const staleTime = Date.now() - 5 * 60 * 60 * 1000; // 5 hours ago
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(staleTime, task.id);
    db.prepare("UPDATE transitions SET created_at = ? WHERE task_id = ?").run(staleTime, task.id);

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.stale).toBe(1);
  });

  it("expires deadlines for active tasks", async () => {
    const task = createTask(
      {
        projectId: PROJECT,
        title: "Deadline task",
        createdBy: "agent:a",
        deadline: Date.now() - 1000, // already expired
      },
      db,
    );
    // Must be in an active state for FAILED transition to be valid
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:a" }, db);

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.deadlineExpired).toBe(1);
  });

  it("advances workflows when phase gate is satisfied", async () => {
    const task1 = createTask(
      { projectId: PROJECT, title: "Phase 1 task", createdBy: "agent:a" },
      db,
    );
    const workflow = createWorkflow(
      {
        projectId: PROJECT,
        name: "Test workflow",
        phases: [
          { name: "Phase 1", gateCondition: "all_done" },
          { name: "Phase 2" },
        ],
        createdBy: "agent:a",
      },
      db,
    );

    addTaskToPhase({ projectId: PROJECT, workflowId: workflow.id, phase: 0, taskId: task1.id }, db);

    // Complete the task through the lifecycle
    transitionTask({ projectId: PROJECT, taskId: task1.id, toState: "ASSIGNED", actor: "agent:a" }, db);
    transitionTask({ projectId: PROJECT, taskId: task1.id, toState: "IN_PROGRESS", actor: "agent:a" }, db);
    const { attachEvidence } = await import("../../src/tasks/ops.js");
    attachEvidence({ projectId: PROJECT, taskId: task1.id, type: "output", content: "done", attachedBy: "agent:a" }, db);
    transitionTask({ projectId: PROJECT, taskId: task1.id, toState: "REVIEW", actor: "agent:a" }, db);
    transitionTask({
      projectId: PROJECT, taskId: task1.id, toState: "DONE", actor: "agent:b",
      verificationRequired: false,
    }, db);

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.workflowsAdvanced).toBe(1);
  });

  it("escalates exhausted failed tasks", async () => {
    const task = createTask(
      { projectId: PROJECT, title: "Failed task", createdBy: "agent:a", maxRetries: 1 },
      db,
    );

    // Set retry_count >= max_retries and state FAILED
    db.prepare("UPDATE tasks SET state = 'FAILED', retry_count = 1 WHERE id = ?").run(task.id);

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.escalated).toBe(1);

    // Verify escalated flag is set
    const row = db.prepare("SELECT metadata FROM tasks WHERE id = ?").get(task.id) as Record<string, unknown>;
    const meta = JSON.parse(row.metadata as string);
    expect(meta.escalated).toBeTruthy();
  });

  it("calls stuck detection and kill", async () => {
    const mockStuck = [
      { sessionKey: "s1", agentId: "a1", projectId: PROJECT, runtimeMs: 600000, lastToolCallMs: null, requiredCallsMade: 0, requiredCallsTotal: 2, reason: "stuck" },
    ];
    vi.mocked(detectStuckAgents).mockReturnValue(mockStuck);
    vi.mocked(killAllStuckAgents).mockResolvedValueOnce(1);

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.stuckKilled).toBe(1);
    expect(killAllStuckAgents).toHaveBeenCalledWith(mockStuck);
  });

  it("filters stuck agents to current project", async () => {
    const mockStuck = [
      { sessionKey: "s1", agentId: "a1", projectId: "other-project", runtimeMs: 600000, lastToolCallMs: null, requiredCallsMade: 0, requiredCallsTotal: 2, reason: "stuck" },
    ];
    vi.mocked(detectStuckAgents).mockReturnValue(mockStuck);

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.stuckKilled).toBe(0);
    expect(killAllStuckAgents).toHaveBeenCalledWith([]); // filtered out
  });

  it("emits task_stale diagnostic event when a task is marked stale", async () => {
    const task = createTask(
      { projectId: PROJECT, title: "Will go stale", createdBy: "agent:a" },
      db,
    );
    transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:a" },
      db,
    );

    // Backdate to make stale
    const staleTime = Date.now() - 5 * 60 * 60 * 1000;
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(staleTime, task.id);
    db.prepare("UPDATE transitions SET created_at = ? WHERE task_id = ?").run(staleTime, task.id);

    await sweep({ projectId: PROJECT, dbOverride: db });

    expect(vi.mocked(emitDiagnosticEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task_stale",
        taskId: task.id,
        projectId: PROJECT,
      }),
    );
  });

  it("auto-blocks severely stale task (already stale for 2x threshold)", async () => {
    const task = createTask(
      { projectId: PROJECT, title: "Severely stale", createdBy: "agent:a" },
      db,
    );
    transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:a" },
      db,
    );

    const now = Date.now();
    const thresholdMs = 4 * 60 * 60 * 1000; // 4 hours (default)
    // Set stale_since to well beyond the threshold (stale for >4h already)
    const staleSince = now - thresholdMs - 1000;
    db.prepare(
      "UPDATE tasks SET updated_at = ?, metadata = json_set(COALESCE(metadata, '{}'), '$.stale', true, '$.stale_since', ?) WHERE id = ?",
    ).run(now - 5 * 60 * 60 * 1000, staleSince, task.id);

    // Backdate transitions so it's detected as stale again
    const staleTime = now - 5 * 60 * 60 * 1000;
    db.prepare("UPDATE transitions SET created_at = ? WHERE task_id = ?").run(staleTime, task.id);

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.stale).toBeGreaterThanOrEqual(1);
    expect(result.autoBlocked).toBe(1);

    // Verify the task is now BLOCKED
    const row = db.prepare("SELECT state FROM tasks WHERE id = ?").get(task.id) as Record<string, unknown>;
    expect(row.state).toBe("BLOCKED");
  });

  it("unblocks stale auto-blocked tasks after 2x stale threshold in BLOCKED", async () => {
    const task = createTask(
      { projectId: PROJECT, title: "Blocked stale task", createdBy: "agent:a" },
      db,
    );
    transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:a" },
      db,
    );
    transitionTask(
      {
        projectId: PROJECT,
        taskId: task.id,
        toState: "BLOCKED",
        actor: "system:sweep",
        reason: "Auto-blocked: no activity for 9h",
      },
      db,
    );

    const now = Date.now();
    const staleThresholdMs = 4 * 60 * 60 * 1000;
    const blockedAt = now - (staleThresholdMs * 2 + 1000);
    db.prepare(
      "UPDATE transitions SET created_at = ? WHERE task_id = ? AND to_state = 'BLOCKED'",
    ).run(blockedAt, task.id);

    await sweep({ projectId: PROJECT, dbOverride: db, staleThresholdMs });

    const row = db.prepare("SELECT state FROM tasks WHERE id = ?").get(task.id) as Record<string, unknown>;
    expect(row.state).toBe("OPEN");
  });

  it("returns autoBlocked: 0 when no severely stale tasks exist", async () => {
    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.autoBlocked).toBe(0);
  });

  it("unblocks dependency-blocked task when all hard dependencies are DONE", async () => {
    const blocker = createTask({ projectId: PROJECT, title: "Blocker", createdBy: "agent:a" }, db);
    const dependent = createTask({ projectId: PROJECT, title: "Dependent", createdBy: "agent:a" }, db);

    const dep = addDependency({ projectId: PROJECT, taskId: dependent.id, dependsOnTaskId: blocker.id, createdBy: "agent:a" }, db);
    expect(dep.ok).toBe(true);

    transitionTask({ projectId: PROJECT, taskId: dependent.id, toState: "BLOCKED", actor: "agent:a", reason: "Blocked on dependency" }, db);

    transitionTask({ projectId: PROJECT, taskId: blocker.id, toState: "ASSIGNED", actor: "agent:a" }, db);
    transitionTask({ projectId: PROJECT, taskId: blocker.id, toState: "IN_PROGRESS", actor: "agent:a" }, db);
    const { attachEvidence } = await import("../../src/tasks/ops.js");
    attachEvidence({ projectId: PROJECT, taskId: blocker.id, type: "output", content: "done", attachedBy: "agent:a" }, db);
    transitionTask({ projectId: PROJECT, taskId: blocker.id, toState: "REVIEW", actor: "agent:a" }, db);
    transitionTask({ projectId: PROJECT, taskId: blocker.id, toState: "DONE", actor: "agent:b", verificationRequired: false }, db);

    await sweep({ projectId: PROJECT, dbOverride: db });

    const row = db.prepare("SELECT state FROM tasks WHERE id = ?").get(dependent.id) as Record<string, unknown>;
    expect(row.state).toBe("OPEN");
  });

  it("recovers stale dispatched queue items with no active session", async () => {
    // Create a task to associate with the dispatch queue item
    const task = createTask(
      { projectId: PROJECT, title: "Dispatched but orphaned", createdBy: "agent:a" },
      db,
    );
    transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:a" },
      db,
    );

    const itemId = "test-dispatch-item-stale";
    const now = Date.now();
    const dispatchedAt = now - 15 * 60 * 1000; // 15 minutes ago (past 10-min default)

    // Insert a dispatch queue item in 'dispatched' status with stale dispatched_at
    db.prepare(`
      INSERT INTO dispatch_queue (id, project_id, task_id, priority, status, dispatch_attempts, max_dispatch_attempts, created_at, dispatched_at)
      VALUES (?, ?, ?, 2, 'dispatched', 1, 3, ?, ?)
    `).run(itemId, PROJECT, task.id, dispatchedAt - 60_000, dispatchedAt);

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.staleDispatchRecovered).toBe(1);

    // Verify the original item was failed
    const failedItem = db.prepare("SELECT status, last_error FROM dispatch_queue WHERE id = ?").get(itemId) as Record<string, unknown>;
    expect(failedItem.status).toBe("failed");
    expect(failedItem.last_error).toContain("Stale dispatched item");

    // Verify a retry item was created (it may have been picked up by the dispatch loop backstop,
    // so check for any item other than the original — in any status)
    const retryItems = db.prepare(
      "SELECT id, status FROM dispatch_queue WHERE project_id = ? AND task_id = ? AND id != ?",
    ).all(PROJECT, task.id, itemId) as Record<string, unknown>[];
    expect(retryItems.length).toBeGreaterThanOrEqual(1);

    // Verify diagnostic event was emitted
    expect(vi.mocked(emitDiagnosticEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dispatch_stale_recovered",
        projectId: PROJECT,
        taskId: task.id,
        queueItemId: itemId,
      }),
    );
  });

  it("does not recover recently dispatched queue items", async () => {
    const task = createTask(
      { projectId: PROJECT, title: "Recently dispatched", createdBy: "agent:a" },
      db,
    );
    transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:a" },
      db,
    );

    const itemId = "test-dispatch-item-recent";
    const now = Date.now();
    const dispatchedAt = now - 5 * 60 * 1000; // 5 minutes ago (under 10-min threshold)

    db.prepare(`
      INSERT INTO dispatch_queue (id, project_id, task_id, priority, status, dispatch_attempts, max_dispatch_attempts, created_at, dispatched_at)
      VALUES (?, ?, ?, 2, 'dispatched', 1, 3, ?, ?)
    `).run(itemId, PROJECT, task.id, dispatchedAt - 60_000, dispatchedAt);

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.staleDispatchRecovered).toBe(0);

    // Item should still be dispatched
    const item = db.prepare("SELECT status FROM dispatch_queue WHERE id = ?").get(itemId) as Record<string, unknown>;
    expect(item.status).toBe("dispatched");
  });

  it("emits task_escalated diagnostic event when task is escalated", async () => {
    const task = createTask(
      { projectId: PROJECT, title: "Exhausted task", createdBy: "agent:a", maxRetries: 1 },
      db,
    );
    db.prepare("UPDATE tasks SET state = 'FAILED', retry_count = 1 WHERE id = ?").run(task.id);

    await sweep({ projectId: PROJECT, dbOverride: db });

    expect(vi.mocked(emitDiagnosticEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task_escalated",
        taskId: task.id,
        projectId: PROJECT,
      }),
    );
  });
});
