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

// Mock auto-kill to avoid needing real abort controllers
vi.mock("../../src/audit/auto-kill.js", () => ({
  killAllStuckAgents: vi.fn(async () => 0),
}));

// Mock stuck detector
vi.mock("../../src/audit/stuck-detector.js", () => ({
  detectStuckAgents: vi.fn(() => []),
  detectPersistedStuckAgents: vi.fn(() => []),
}));

// Mock dispatch modules to prevent actual spawning/cron creation
vi.mock("../../src/dispatch/spawn.js", () => ({
  buildTaskPrompt: vi.fn(() => "mock prompt"),
}));
vi.mock("../../src/dispatch/inject-dispatch.js", () => ({
  dispatchViaInject: vi.fn(async () => ({ ok: false, error: "mock: not available in tests" })),
}));
vi.mock("../../src/dispatch/executors.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/dispatch/executors.js")>("../../src/dispatch/executors.js");
  return {
    ...actual,
    executeDispatch: vi.fn(async () => ({
      ok: false,
      executor: "codex",
      error: "mock direct dispatch blocked in tests",
    })),
    resolveDispatchExecutorName: vi.fn(() => "codex"),
  };
});
vi.mock("../../src/manager-cron.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/manager-cron.js")>("../../src/manager-cron.js");
  return {
    ...actual,
    getCronService: vi.fn(() => null),
  };
});

const { getMemoryDb } = await import("../../src/db.js");
const { sweep } = await import("../../src/sweep/actions.js");
const { createTask, transitionTask } = await import("../../src/tasks/ops.js");
const { enqueue, claimNext, getQueueStatus } = await import("../../src/dispatch/queue.js");
const { addDependency } = await import("../../src/tasks/deps.js");
const { createWorkflow, addTaskToPhase } = await import("../../src/workflow.js");
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");
const { createEntity, recordEntityIssue, resolveEntityIssue } = await import("../../src/entities/ops.js");
const { killAllStuckAgents } = await import("../../src/audit/auto-kill.js");
const { detectStuckAgents, detectPersistedStuckAgents } = await import("../../src/audit/stuck-detector.js");
const { emitDiagnosticEvent, safeLog } = await import("../../src/diagnostics.js");
const { getCronService } = await import("../../src/manager-cron.js");
const { acquireControllerLease } = await import("../../src/runtime/controller-leases.js");

describe("sweep", () => {
  let db: DatabaseSync;
  const PROJECT = "sweep-test";

  beforeEach(() => {
    db = getMemoryDb();
    vi.clearAllMocks();
    vi.mocked(detectStuckAgents).mockReturnValue([]);
    vi.mocked(detectPersistedStuckAgents).mockReturnValue([]);
  });

  afterEach(() => {
    resetEnforcementConfigForTest();
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
    expect(vi.mocked(safeLog)).not.toHaveBeenCalledWith(
      "sweep.unblockStale",
      expect.anything(),
    );
  });

  it("skips sweep when a foreign controller owns the project", async () => {
    const task = createTask(
      { projectId: PROJECT, title: "Stale task", createdBy: "agent:a" },
      db,
    );
    transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:a" },
      db,
    );
    const staleTime = Date.now() - 5 * 60 * 60 * 1000;
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(staleTime, task.id);
    db.prepare("UPDATE transitions SET created_at = ? WHERE task_id = ?").run(staleTime, task.id);

    acquireControllerLease(PROJECT, {
      ownerId: "controller:foreign",
      ownerLabel: "foreign-owner",
      purpose: "lifecycle",
      ttlMs: 60_000,
    }, db);

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.stale).toBe(0);
    expect(result.controller?.skipped).toBe(true);
    expect(result.controller?.ownerId).toBe("controller:foreign");
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

  it("reconciles approved workflow mutations that were handled without landing side effects", async () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks (
        id, project_id, title, description, state, priority, assigned_to, created_by, created_at, updated_at,
        entity_type, entity_id
      ) VALUES (?, ?, ?, ?, 'REVIEW', 'P2', 'los-angeles-owner', 'agent:a', ?, ?, 'jurisdiction', 'entity-la')
    `).run(
      "task-la",
      PROJECT,
      "Remediate Los Angeles: Missing field",
      "Acceptance criteria:\n- narrow the issue.",
      now - 20_000,
      now - 20_000,
    );

    db.prepare(`
      INSERT INTO proposals (
        id, project_id, title, description, proposed_by, session_key, status,
        approval_policy_snapshot, risk_tier, created_at, resolved_at, entity_type, entity_id,
        origin, reasoning
      ) VALUES (?, ?, ?, ?, ?, NULL, 'approved', ?, ?, ?, ?, ?, ?, 'workflow_mutation', ?)
    `).run(
      "proposal-la",
      PROJECT,
      "Workflow mutation review: repeated verification environment blocked for Los Angeles",
      "Fix the workflow",
      "workflow-steward",
      JSON.stringify({
        replayType: "workflow_mutation",
        stewardAgentId: "workflow-steward",
        sourceTaskId: "task-la",
        sourceTaskTitle: "Remediate Los Angeles: Missing field",
        reasonCode: "verification_environment_blocked",
        mutationCategory: "verification_path",
        stewardTask: {
          title: "Restructure workflow for Los Angeles: verification environment blocked",
          description: "Acceptance criteria:\n- leave an operator-facing summary.",
          priority: "P1",
          kind: "infra",
          tags: ["workflow-mutation"],
          metadata: { sourceTaskId: "task-la" },
        },
      }),
      "medium",
      now - 10_000,
      now - 5_000,
      "jurisdiction",
      "entity-la",
      "{\"source\":\"review_loop\"}",
    );

    db.prepare(`
      INSERT INTO events (
        id, project_id, type, source, payload, dedup_key, status, created_at, processed_at
      ) VALUES (?, ?, 'proposal_approved', 'internal', ?, ?, 'handled', ?, ?)
    `).run(
      "event-la",
      PROJECT,
      JSON.stringify({ proposalId: "proposal-la" }),
      "proposal-approved:proposal-la",
      now - 4_000,
      now - 3_000,
    );

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.proposalExecutionsRecovered).toBeGreaterThanOrEqual(1);

    const stewardTask = db.prepare(`
      SELECT id, state, assigned_to
      FROM tasks
      WHERE project_id = ?
        AND origin = 'lead_proposal'
        AND origin_id = 'proposal-la'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(PROJECT) as { id: string; state: string; assigned_to: string } | undefined;
    expect(stewardTask?.assigned_to).toBe("workflow-steward");

    const sourceTask = db.prepare("SELECT state FROM tasks WHERE id = 'task-la'").get() as { state: string } | undefined;
    expect(sourceTask?.state).toBe("BLOCKED");

    const proposal = db.prepare(`
      SELECT execution_status, execution_task_id
      FROM proposals
      WHERE id = 'proposal-la'
    `).get() as { execution_status: string; execution_task_id: string } | undefined;
    expect(proposal?.execution_status).toBe("applied");
    expect(proposal?.execution_task_id).toBe(stewardTask?.id);

    const pendingEvents = db.prepare(`
      SELECT COUNT(*) as count
      FROM events
      WHERE project_id = ?
        AND status = 'pending'
    `).get(PROJECT) as { count: number };
    expect(pendingEvents.count).toBe(0);
  });

  it("can settle task-created workflow without foreground dispatch in events_only mode", async () => {
    createTask({
      projectId: PROJECT,
      title: "Steward task",
      description: "Acceptance criteria:\n- leave a summary.",
      assignedTo: "workflow-steward",
      createdBy: "system:test",
    }, db);

    const result = await sweep({
      projectId: PROJECT,
      dbOverride: db,
      backstopDispatchMode: "events_only",
    });

    expect(result.eventsProcessed).toBeGreaterThan(0);
    expect(result.dispatched).toBe(0);

    const queue = getQueueStatus(PROJECT, db);
    expect(queue.queued).toBeGreaterThanOrEqual(1);
    expect(queue.leased ?? 0).toBe(0);
    expect(queue.dispatched ?? 0).toBe(0);

    const pendingEvents = db.prepare(`
      SELECT COUNT(*) as count
      FROM events
      WHERE project_id = ?
        AND status = 'pending'
    `).get(PROJECT) as { count: number };
    expect(pendingEvents.count).toBe(0);
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

  it("commits sweep when an overdue task also has an active queue item", async () => {
    const task = createTask(
      {
        projectId: PROJECT,
        title: "Queued deadline task",
        createdBy: "agent:a",
        deadline: Date.now() - 1000,
      },
      db,
    );
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:a" }, db);

    const queueItem = enqueue(PROJECT, task.id, undefined, undefined, db)!;
    claimNext(PROJECT, 60_000, "agent:test", db);

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.deadlineExpired).toBe(1);

    const status = getQueueStatus(PROJECT, db);
    expect(status.failed).toBe(1);
    expect(status.recentItems[0]?.id).toBe(queueItem.id);
    expect(status.recentItems[0]?.lastError).toBe("Task transitioned to FAILED");
  });

  it("commits sweep when stale reservation cleanup audits inside the caller transaction", async () => {
    const task = createTask({ projectId: PROJECT, title: "Leased task", createdBy: "agent:a" }, db);
    enqueue(PROJECT, task.id, undefined, undefined, db);
    const claimed = claimNext(PROJECT, 60_000, "agent:test", db)!;

    const staleLeasedAt = Date.now() - 5 * 3600_000;
    const futureLeaseExpiry = Date.now() + 60_000;
    db.prepare("UPDATE dispatch_queue SET leased_at = ?, lease_expires_at = ? WHERE id = ?")
      .run(staleLeasedAt, futureLeaseExpiry, claimed.id);

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.reservationsReleased).toBe(1);

    const status = getQueueStatus(PROJECT, db);
    expect(status.failed).toBe(1);
    expect(status.recentItems[0]?.lastError).toBe("reservation_timeout");
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

  it("kills persisted stuck sessions when no in-memory tracker owns them", async () => {
    const mockPersisted = [
      { sessionKey: "persisted-1", agentId: "a1", projectId: PROJECT, runtimeMs: 600000, lastToolCallMs: null, requiredCallsMade: 0, requiredCallsTotal: 1, reason: "persisted stale" },
    ];
    vi.mocked(detectPersistedStuckAgents).mockReturnValue(mockPersisted);
    vi.mocked(killAllStuckAgents).mockResolvedValueOnce(1);

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.stuckKilled).toBe(1);
    expect(killAllStuckAgents).toHaveBeenCalledWith(mockPersisted);
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
    db.prepare(
      "UPDATE tasks SET lease_holder = ?, lease_acquired_at = ?, lease_expires_at = ? WHERE id = ?",
    ).run(`dispatch:${itemId}`, dispatchedAt, dispatchedAt + 2 * 60 * 60 * 1000, task.id);

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

    const taskRow = db.prepare(
      "SELECT lease_holder FROM tasks WHERE id = ?",
    ).get(task.id) as Record<string, unknown>;
    expect(taskRow.lease_holder).toBeNull();

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

  it("recovers stale dispatch cron jobs that never started a session", async () => {
    const task = createTask(
      { projectId: PROJECT, title: "Cron-wedged dispatch", createdBy: "agent:a" },
      db,
    );
    transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:a" },
      db,
    );

    const itemId = "test-dispatch-cron-item";
    const now = Date.now();
    db.prepare(`
      INSERT INTO dispatch_queue (id, project_id, task_id, priority, status, dispatch_attempts, max_dispatch_attempts, created_at, dispatched_at)
      VALUES (?, ?, ?, 2, 'dispatched', 1, 3, ?, ?)
    `).run(itemId, PROJECT, task.id, now - 120_000, now - 90_000);
    db.prepare(
      "UPDATE tasks SET lease_holder = ?, lease_acquired_at = ?, lease_expires_at = ? WHERE id = ?",
    ).run(`dispatch:${itemId}`, now - 90_000, now + 2 * 60 * 60 * 1000, task.id);

    const remove = vi.fn(async () => undefined);
    vi.mocked(getCronService).mockReturnValue({
      add: vi.fn(async () => undefined),
      list: vi.fn(async () => [
        {
          id: "cron-job-1",
          name: `dispatch:${encodeURIComponent(PROJECT)}:${itemId}`,
          enabled: true,
          deleteAfterRun: true,
          schedule: { kind: "at", at: new Date(now - 90_000).toISOString() },
          state: { nextRunAtMs: now - 90_000 },
        },
      ]),
      update: vi.fn(async () => undefined),
      remove,
      run: vi.fn(async () => undefined),
    });

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.orphanedCronRecovered).toBe(1);
    expect(remove).toHaveBeenCalledWith("cron-job-1");

    const taskRow = db.prepare(
      "SELECT lease_holder FROM tasks WHERE id = ?",
    ).get(task.id) as Record<string, unknown>;
    expect(taskRow.lease_holder).toBeNull();

    const queueRow = db.prepare(
      "SELECT status, last_error, dispatch_attempts FROM dispatch_queue WHERE id = ?",
    ).get(itemId) as Record<string, unknown>;
    expect(queueRow.status).toBe("failed");
    expect(queueRow.last_error).toBeTruthy();
    expect(queueRow.dispatch_attempts).toBe(2);

    expect(vi.mocked(emitDiagnosticEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dispatch_cron_recovered",
        projectId: PROJECT,
        taskId: task.id,
        queueItemId: itemId,
        recovery: "missed_start",
      }),
    );
  });

  it("dead-letters stale dispatch cron jobs after max missed starts", async () => {
    const task = createTask(
      { projectId: PROJECT, title: "Cron-exhausted dispatch", createdBy: "agent:a" },
      db,
    );
    transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:a" },
      db,
    );

    const itemId = "test-dispatch-cron-exhausted";
    const now = Date.now();
    db.prepare(`
      INSERT INTO dispatch_queue (id, project_id, task_id, priority, status, dispatch_attempts, max_dispatch_attempts, created_at, dispatched_at)
      VALUES (?, ?, ?, 2, 'dispatched', 3, 3, ?, ?)
    `).run(itemId, PROJECT, task.id, now - 120_000, now - 90_000);
    db.prepare(
      "UPDATE tasks SET lease_holder = ?, lease_acquired_at = ?, lease_expires_at = ? WHERE id = ?",
    ).run(`dispatch:${itemId}`, now - 90_000, now + 2 * 60 * 60 * 1000, task.id);

    const remove = vi.fn(async () => undefined);
    vi.mocked(getCronService).mockReturnValue({
      add: vi.fn(async () => undefined),
      list: vi.fn(async () => [
        {
          id: "cron-job-2",
          name: `dispatch:${encodeURIComponent(PROJECT)}:${itemId}`,
          enabled: true,
          deleteAfterRun: true,
          schedule: { kind: "at", at: new Date(now - 90_000).toISOString() },
          state: { nextRunAtMs: now - 90_000 },
        },
      ]),
      update: vi.fn(async () => undefined),
      remove,
      run: vi.fn(async () => undefined),
    });

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.orphanedCronRecovered).toBe(1);
    expect(remove).toHaveBeenCalledWith("cron-job-2");

    const queueRow = db.prepare(
      "SELECT status, last_error, dispatch_attempts FROM dispatch_queue WHERE id = ?",
    ).get(itemId) as Record<string, unknown>;
    expect(queueRow.status).toBe("failed");
    expect(String(queueRow.last_error)).toContain("exhausted dispatch retries");
    expect(queueRow.dispatch_attempts).toBe(3);

    const deadLetterEvents = db.prepare(
      "SELECT type, payload FROM events WHERE project_id = ? AND type = 'dispatch_dead_letter'",
    ).all(PROJECT) as Record<string, unknown>[];
    expect(deadLetterEvents).toHaveLength(1);
    expect(JSON.parse(String(deadLetterEvents[0]!.payload))).toMatchObject({
      taskId: task.id,
      queueItemId: itemId,
      attempts: 3,
    });

    expect(vi.mocked(emitDiagnosticEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dispatch_cron_dead_lettered",
        projectId: PROJECT,
        taskId: task.id,
        queueItemId: itemId,
        recovery: "missed_start",
        attempts: 3,
        maxAttempts: 3,
      }),
    );
  });

  it("ignores dispatch cron jobs owned by another project", async () => {
    const remove = vi.fn(async () => undefined);
    vi.mocked(getCronService).mockReturnValue({
      add: vi.fn(async () => undefined),
      list: vi.fn(async () => [
        {
          id: "cron-job-foreign",
          name: `dispatch:${encodeURIComponent("other-project")}:foreign-queue-item`,
          enabled: true,
          deleteAfterRun: true,
          schedule: { kind: "at", at: new Date(Date.now() - 90_000).toISOString() },
          state: { nextRunAtMs: Date.now() - 90_000 },
        },
      ]),
      update: vi.fn(async () => undefined),
      remove,
      run: vi.fn(async () => undefined),
    });

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.orphanedCronRecovered).toBe(0);
    expect(remove).not.toHaveBeenCalled();
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

  it("recovers orphaned dispatch leases from terminal queue items and re-enqueues the task", async () => {
    const task = createTask(
      { projectId: PROJECT, title: "Assigned with orphaned dispatch lease", createdBy: "agent:a" },
      db,
    );
    transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:a" },
      db,
    );

    const orphanedQueueItemId = "test-orphaned-dispatch-item";
    const now = Date.now();
    db.prepare(`
      INSERT INTO dispatch_queue (id, project_id, task_id, priority, status, dispatch_attempts, max_dispatch_attempts, last_error, completed_at, created_at)
      VALUES (?, ?, ?, 2, 'failed', 1, 3, 'Could not acquire task lease — another agent holds it', ?, ?)
    `).run(orphanedQueueItemId, PROJECT, task.id, now, now - 60_000);
    db.prepare(
      "UPDATE tasks SET lease_holder = ?, lease_acquired_at = ?, lease_expires_at = ? WHERE id = ?",
    ).run(`dispatch:${orphanedQueueItemId}`, now - 60_000, now + 60 * 60 * 1000, task.id);

    const result = await sweep({ projectId: PROJECT, dbOverride: db });
    expect(result.orphanedDispatchRecovered).toBe(1);

    const taskRow = db.prepare(
      "SELECT lease_holder FROM tasks WHERE id = ?",
    ).get(task.id) as Record<string, unknown>;
    expect(taskRow.lease_holder).toBeNull();

    const retryItems = db.prepare(
      "SELECT id, status FROM dispatch_queue WHERE project_id = ? AND task_id = ? AND id != ?",
    ).all(PROJECT, task.id, orphanedQueueItemId) as Record<string, unknown>[];
    expect(retryItems.length).toBeGreaterThanOrEqual(1);

    expect(vi.mocked(emitDiagnosticEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dispatch_orphaned_lease_recovered",
        projectId: PROJECT,
        taskId: task.id,
        queueItemId: orphanedQueueItemId,
      }),
    );
  });

  it("replays stranded recurring runs that only failed on missing acceptance criteria", async () => {
    registerWorkforceConfig(PROJECT, {
      name: PROJECT,
      agents: {
        worker: {
          extends: "employee",
          title: "Worker",
          jobs: {
            coordination: {
              cron: "*/30 * * * *",
              nudge: "Review coordination.",
            },
          },
        },
      },
    });

    const task = createTask({
      projectId: PROJECT,
      title: "Run recurring workflow worker.coordination",
      description: "Legacy recurring task without acceptance criteria.",
      createdBy: "system:recurring-job",
      assignedTo: "worker",
      kind: "infra",
      origin: "reactive",
      tags: ["recurring-job", "agent:worker", "job:coordination"],
      metadata: {
        recurringJob: {
          agentId: "worker",
          jobName: "coordination",
          schedule: "*/30 * * * *",
          reason: "cron due",
          scheduledAt: Date.now() - 60_000,
        },
      },
    }, db);

    db.prepare(
      `INSERT INTO dispatch_queue (
        id, project_id, task_id, priority, status, dispatch_attempts, max_dispatch_attempts, last_error, created_at, completed_at
      ) VALUES (?, ?, ?, 2, 'failed', 1, 3, ?, ?, ?)`,
    ).run(
      "failed-recurring-item",
      PROJECT,
      task.id,
      "Task description missing acceptance criteria — manager must define what 'done' looks like",
      Date.now() - 30_000,
      Date.now() - 29_000,
    );

    db.prepare(
      "INSERT INTO project_metadata (project_id, key, value) VALUES (?, ?, ?)",
    ).run(PROJECT, "recurring_job:worker:coordination:active_task_id", task.id);

    const result = await sweep({
      projectId: PROJECT,
      dbOverride: db,
      backstopDispatchMode: "events_only",
    });
    expect(result.orphanedDispatchRecovered).toBe(1);

    const oldTask = db.prepare(
      "SELECT state FROM tasks WHERE id = ?",
    ).get(task.id) as Record<string, unknown>;
    expect(oldTask.state).toBe("CANCELLED");

    const replayedTask = db.prepare(
      `SELECT id, description
       FROM tasks
       WHERE project_id = ?
         AND json_extract(metadata, '$.replayOfTaskId') = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(PROJECT, task.id) as Record<string, unknown> | undefined;
    expect(replayedTask?.id).toBeTruthy();
    expect(String(replayedTask?.description ?? "")).toContain("## Acceptance Criteria");

    const replayQueue = db.prepare(
      "SELECT status FROM dispatch_queue WHERE project_id = ? AND task_id = ? AND status = 'queued' LIMIT 1",
    ).get(PROJECT, replayedTask?.id) as Record<string, unknown> | undefined;
    expect(replayQueue?.status).toBe("queued");

    expect(vi.mocked(emitDiagnosticEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "recurring_dispatch_recovered",
        projectId: PROJECT,
        taskId: task.id,
        replayTaskId: replayedTask?.id,
      }),
    );
  });

  it("blocks active tasks that are already marked dispatch-dead-lettered", async () => {
    const task = createTask(
      { projectId: PROJECT, title: "Dead-lettered task", createdBy: "agent:a" },
      db,
    );
    transitionTask(
      { projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "agent:a" },
      db,
    );

    db.prepare(
      "UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.dispatch_dead_letter', true, '$.dispatch_dead_letter_at', ?) WHERE id = ?",
    ).run(Date.now(), task.id);

    await sweep({ projectId: PROJECT, dbOverride: db });

    const row = db.prepare("SELECT state FROM tasks WHERE id = ?").get(task.id) as Record<string, unknown>;
    expect(row.state).toBe("BLOCKED");
  });

  it("cancels dead-lettered reactive tasks when their linked issue is already resolved", async () => {
    registerWorkforceConfig(PROJECT, {
      agents: {},
      entities: {
        jurisdiction: {
          title: "Jurisdiction",
          runtimeCreate: true,
          states: {
            shadow: { initial: true },
          },
          transitions: [],
          health: {
            values: ["healthy", "warning", "degraded", "blocked"],
            default: "healthy",
          },
          issues: {
            types: {
              extraction_failure: {
                defaultSeverity: "medium",
              },
            },
          },
          metadataSchema: {
            region: { type: "string", required: true },
          },
        },
      },
    }, "/tmp/sweep-dead-letter-resolved");

    const entity = createEntity({
      projectId: PROJECT,
      kind: "jurisdiction",
      title: "Los Angeles",
      metadata: { region: "ca-la" },
      createdBy: "tester",
    }, db);
    const issue = recordEntityIssue({
      projectId: PROJECT,
      entityId: entity.id,
      issueKey: "la.extraction.rate-period-start-month",
      issueType: "extraction_failure",
      source: "pipeline_health",
      title: "Missing field: rate_period_start_month",
      actor: "tester",
    }, db);
    resolveEntityIssue({
      projectId: PROJECT,
      issueId: issue.id,
      actor: "tester",
    }, db);

    const task = createTask({
      projectId: PROJECT,
      title: "Reactive remediation residue",
      createdBy: "tester",
      assignedTo: "agent:worker",
      origin: "reactive",
      originId: issue.id,
      entityId: entity.id,
      entityType: entity.kind,
      metadata: {
        entityIssue: {
          issueId: issue.id,
          closeTaskOnResolved: true,
        },
        dispatch_dead_letter: true,
        dispatch_dead_letter_at: Date.now(),
      },
    }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "ASSIGNED", actor: "tester" }, db);
    transitionTask({ projectId: PROJECT, taskId: task.id, toState: "BLOCKED", actor: "tester", reason: "Stale residue" }, db);

    await sweep({ projectId: PROJECT, dbOverride: db });

    const row = db.prepare("SELECT state FROM tasks WHERE id = ?").get(task.id) as Record<string, unknown>;
    expect(row.state).toBe("CANCELLED");
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
