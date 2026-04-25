/**
 * CLI command tests — comprehensive coverage for src/cli.ts
 *
 * Strategy:
 * - Use in-memory SQLite with full migrations for schema
 * - Mock console.log to capture output
 * - Verify commands don't throw, and JSON mode returns parseable JSON
 * - Seed realistic data for meaningful output validation
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "../../src/sqlite-driver.js";
import crypto from "node:crypto";

// Mock child_process (used by cmdStatus, cmdHealth, cmdKill, and cron bootstrap imports)
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: vi.fn(() => ""),
    execFile: vi.fn((...args: unknown[]) => {
      const callback = typeof args[args.length - 1] === "function"
        ? args[args.length - 1] as (err: Error | null, stdout?: string, stderr?: string) => void
        : null;
      callback?.(null, "", "");
      return {} as ReturnType<typeof actual.execFile>;
    }),
  };
});

// Mock diagnostics module if it gets pulled in transitively
vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/config/watcher.js", () => ({
  startConfigWatcher: vi.fn(),
  stopConfigWatcher: vi.fn(),
}));

const mockDashboardServer = {
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  server: {
    address: vi.fn(() => ({ port: 3117 })),
  },
};

vi.mock("../../src/dashboard/server.js", () => ({
  createDashboardServer: vi.fn(() => mockDashboardServer),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

import { runMigrations } from "../../src/migrations.js";

// Import CLI functions — guarded main block won't execute
const cli = await import("../../src/cli.js");
const configInit = await import("../../src/config/init.js");
const configWatcher = await import("../../src/config/watcher.js");
const dashboardServer = await import("../../src/dashboard/server.js");
const dbModule = await import("../../src/db.js");
const projectModule = await import("../../src/project.js");
const { createTask } = await import("../../src/tasks/ops.js");
const {
  acquireControllerLease,
  getControllerLease,
  resetControllerIdentityForTest,
} = await import("../../src/runtime/controller-leases.js");
const { ingestEvent } = await import("../../src/events/store.js");
const lifecycle = await import("../../src/lifecycle.js");

// ─── Helpers ────────────────────────────────────────────────────────

const PROJECT_ID = "test-project";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

function seedTestData(db: DatabaseSync): void {
  const now = Date.now();
  const hourAgo = now - 3600_000;
  const twoHoursAgo = now - 2 * 3600_000;

  // Budget
  db.prepare(`
    INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, session_limit_cents, task_limit_cents, daily_spent_cents, daily_reset_at, monthly_spent_cents, created_at, updated_at)
    VALUES (?, ?, NULL, 50000, NULL, NULL, 12500, ?, 45000, ?, ?)
  `).run("budget-1", PROJECT_ID, now - 12 * 3600_000, now, now);

  // Agent-specific budget
  db.prepare(`
    INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, session_limit_cents, task_limit_cents, daily_spent_cents, daily_reset_at, monthly_spent_cents, created_at, updated_at)
    VALUES (?, ?, 'cf-lead', 20000, 5000, NULL, 8000, ?, 20000, ?, ?)
  `).run("budget-2", PROJECT_ID, now - 12 * 3600_000, now, now);

  // Tasks
  const taskIds = ["task-1", "task-2", "task-3", "task-4", "task-5"];
  const states = ["ASSIGNED", "IN_PROGRESS", "REVIEW", "DONE", "FAILED"];
  const agents = ["cf-lead", "cf-worker-1", "cf-worker-2", "cf-lead", "cf-worker-1"];
  for (let i = 0; i < taskIds.length; i++) {
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, description, state, priority, assigned_to, created_by, created_at, updated_at, retry_count, max_retries)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 3)
    `).run(
      taskIds[i]!, PROJECT_ID,
      `Test task ${i + 1}`, `Description for task ${i + 1}`,
      states[i]!, i < 2 ? "P1" : "P2",
      agents[i]!, "system",
      now - (5 - i) * 3600_000, now - i * 1800_000,
    );
  }

  // Transitions
  const transitionPairs = [
    ["OPEN", "ASSIGNED", "agent:cf-lead:cron:uuid1"],
    ["ASSIGNED", "IN_PROGRESS", "agent:cf-worker-1:dispatch:uuid2"],
    ["IN_PROGRESS", "REVIEW", "agent:cf-worker-1:dispatch:uuid3"],
    ["REVIEW", "DONE", "agent:cf-lead:cron:uuid4"],
    ["ASSIGNED", "FAILED", "agent:cf-worker-1:dispatch:uuid5"],
  ];
  for (let i = 0; i < transitionPairs.length; i++) {
    db.prepare(`
      INSERT INTO transitions (id, task_id, from_state, to_state, actor, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `trans-${i}`, taskIds[i % taskIds.length]!,
      transitionPairs[i]![0], transitionPairs[i]![1], transitionPairs[i]![2],
      `Transition reason ${i}`, now - (5 - i) * 1800_000,
    );
  }

  // Cost records
  const costAgents = ["cf-lead", "cf-worker-1", "cf-worker-2"];
  const models = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-sonnet-4-6"];
  for (let i = 0; i < 6; i++) {
    const agentIdx = i % 3;
    db.prepare(`
      INSERT INTO cost_records (id, project_id, agent_id, session_key, task_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, model, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatch', ?)
    `).run(
      `cost-${i}`, PROJECT_ID,
      costAgents[agentIdx]!, `agent:${costAgents[agentIdx]}:cron:session-${i}`,
      taskIds[agentIdx]!,
      5000 + i * 1000, 2000 + i * 500, 1000, 500,
      500 + i * 100, models[agentIdx]!,
      now - i * 600_000,
    );
  }

  // Dispatch queue items
  const queueStatuses = ["queued", "dispatched", "completed", "failed", "cancelled", "leased"];
  for (let i = 0; i < queueStatuses.length; i++) {
    db.prepare(`
      INSERT INTO dispatch_queue (id, project_id, task_id, priority, status, last_error, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `queue-${i}`, PROJECT_ID,
      taskIds[i % taskIds.length]!, 2 - (i % 3),
      queueStatuses[i]!,
      queueStatuses[i] === "failed" ? "Agent process exited with code 1" : null,
      now - i * 600_000,
      queueStatuses[i] === "completed" ? now : null,
    );
  }

  // Session archives
  const sessionOutcomes = ["success", "success", "compliance_timeout", "success"];
  for (let i = 0; i < 4; i++) {
    const agentIdx = i % 3;
    const sessionKey = `agent:${costAgents[agentIdx]}:cron:session-${i}`;
    db.prepare(`
      INSERT INTO session_archives (id, session_key, agent_id, project_id, outcome, total_cost_cents, started_at, ended_at, duration_ms, tool_call_count, error_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `sa-${i}`, sessionKey,
      costAgents[agentIdx]!, PROJECT_ID,
      sessionOutcomes[i]!, 500 + i * 100,
      now - (4 - i) * 3600_000, now - (4 - i) * 3600_000 + 300_000,
      300_000, 15 + i * 5, i === 2 ? 1 : 0, now,
    );
  }

  // Tool call details
  const toolNames = ["clawforce_task", "clawforce_log", "Bash", "Read"];
  for (let i = 0; i < 8; i++) {
    db.prepare(`
      INSERT INTO tool_call_details (id, session_key, project_id, agent_id, tool_name, action, sequence_number, duration_ms, success, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `tc-${i}`, "agent:cf-lead:cron:session-0", PROJECT_ID, "cf-lead",
      toolNames[i % toolNames.length]!, i % 2 === 0 ? "read" : "write",
      i, 100 + i * 50, 1, null, now - (8 - i) * 60_000,
    );
  }

  // Proposals
  const proposalStatuses = ["pending", "approved", "rejected", "pending"];
  for (let i = 0; i < 4; i++) {
    db.prepare(`
      INSERT INTO proposals (id, project_id, title, description, proposed_by, session_key, status, reasoning, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `proposal-${i}`, PROJECT_ID,
      `Proposal ${i + 1}: ${["Refactor module", "Add logging", "Update deps", "New feature"][i]}`,
      `Description for proposal ${i}`,
      `agent:cf-${i < 2 ? "lead" : "worker-1"}:cron:uuid-${i}`,
      `agent:cf-${i < 2 ? "lead" : "worker-1"}:cron:uuid-${i}`,
      proposalStatuses[i]!, `Reasoning for proposal ${i}`,
      now - i * 3600_000,
      proposalStatuses[i] !== "pending" ? now : null,
    );
  }

  // Trust score history
  const trustAgents = ["cf-lead", "cf-worker-1", "cf-worker-2"];
  for (let i = 0; i < trustAgents.length; i++) {
    // Current score
    db.prepare(`
      INSERT INTO trust_score_history (id, project_id, agent_id, score, tier, trigger_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `trust-${i}`, PROJECT_ID,
      trustAgents[i]!, 0.85 - i * 0.1, i === 0 ? "trusted" : "standard",
      "task_completion", now - i * 3600_000,
    );
    // Old score (24h+ ago)
    db.prepare(`
      INSERT INTO trust_score_history (id, project_id, agent_id, score, tier, trigger_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `trust-old-${i}`, PROJECT_ID,
      trustAgents[i]!, 0.80 - i * 0.1, "standard",
      "initial", now - 48 * 3600_000,
    );
  }

  // Messages
  for (let i = 0; i < 3; i++) {
    db.prepare(`
      INSERT INTO messages (id, from_agent, to_agent, project_id, type, priority, content, status, created_at, read_at)
      VALUES (?, ?, ?, ?, 'direct', 'normal', ?, ?, ?, ?)
    `).run(
      `msg-${i}`,
      i % 2 === 0 ? "cf-lead" : "user",
      i % 2 === 0 ? "user" : "cf-lead",
      PROJECT_ID,
      `Test message ${i + 1}`,
      "queued",
      now - i * 1800_000,
      i === 0 ? now : null,
    );
  }

  // Tracked sessions (active)
  db.prepare(`
    INSERT INTO tracked_sessions (session_key, agent_id, project_id, started_at, requirements, satisfied, tool_call_count, last_persisted_at)
    VALUES (?, ?, ?, ?, '[]', '[]', 5, ?)
  `).run("agent:cf-lead:cron:active-1", "cf-lead", PROJECT_ID, now - 600_000, now);

  // Disabled agents
  db.prepare(`
    INSERT INTO disabled_agents (id, project_id, agent_id, reason, disabled_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("da-1", PROJECT_ID, "cf-worker-3", "rate limit exceeded", now);

  // Project metadata
  db.prepare(`
    INSERT INTO project_metadata (project_id, key, value) VALUES (?, ?, ?)
  `).run(PROJECT_ID, "cron_last_run", String(now));

  // Disabled scopes
  // (not domain-level, so cmdRunning shows them)
  db.prepare(`
    INSERT INTO disabled_scopes (id, project_id, scope_type, scope_value, reason, disabled_at, disabled_by)
    VALUES (?, ?, 'team', 'workers', 'maintenance', ?, 'cli')
  `).run("ds-1", PROJECT_ID, now);
}

// ─── Console capture ────────────────────────────────────────────────

let logOutput: string[];
let errorOutput: string[];
const originalLog = console.log;
const originalError = console.error;

function captureStart(): void {
  logOutput = [];
  errorOutput = [];
  console.log = (...args: unknown[]) => {
    logOutput.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errorOutput.push(args.map(String).join(" "));
  };
}

function captureStop(): string {
  console.log = originalLog;
  console.error = originalError;
  return logOutput.join("\n");
}

function getLogOutput(): string {
  return logOutput.join("\n");
}

function getJsonOutput(): unknown {
  const text = logOutput.join("\n");
  return JSON.parse(text);
}

// ─── Test Suite ─────────────────────────────────────────────────────

let db: DatabaseSync;
const originalControllerGeneration = process.env.CLAWFORCE_CONTROLLER_GENERATION;

describe("CLI commands", () => {
  beforeEach(() => {
    process.env.CLAWFORCE_CONTROLLER_GENERATION = originalControllerGeneration;
    resetControllerIdentityForTest();
    db = createTestDb();
    seedTestData(db);
    captureStart();
  });

  it("falls back from gateway sweep when the skipped controller is expired", () => {
    expect(cli.shouldFallbackToLocalSweep({
      mode: "gateway",
      controller: {
        skipped: true,
        ownerId: "controller:stale",
        expiresAt: Date.now() - 1,
      },
    })).toBe(true);

    expect(cli.shouldFallbackToLocalSweep({
      mode: "gateway",
      controller: {
        skipped: true,
        ownerId: "controller:active",
        expiresAt: Date.now() + 60_000,
      },
    })).toBe(false);

    expect(cli.shouldFallbackToLocalSweep({
      mode: "local",
      controller: {
        skipped: true,
        expiresAt: Date.now() - 1,
      },
    })).toBe(false);
  });

  afterEach(() => {
    process.env.CLAWFORCE_CONTROLLER_GENERATION = originalControllerGeneration;
    resetControllerIdentityForTest();
    captureStop();
    try { db.close(); } catch { /* already closed */ }
  });

  it("drainProjectWorkflow requests the current controller generation so stale controllers do not block CLI follow-on work", async () => {
    process.env.CLAWFORCE_CONTROLLER_GENERATION = "gen-cli-current";
    resetControllerIdentityForTest();

    acquireControllerLease(PROJECT_ID, {
      ownerId: "controller:stale",
      ownerLabel: "stale-controller",
      purpose: "sweep",
      generation: "gen-stale",
      ttlMs: 60_000,
    }, db);

    const result = await cli.drainProjectWorkflow(PROJECT_ID, 1, {
      db,
      reason: "test:cli_workflow_drain",
      metadata: { test: true },
    });

    expect(result.controller?.skipped).toBe(false);
    const lease = getControllerLease(PROJECT_ID, db);
    expect(lease?.generation).toBe("gen-cli-current");
    expect(lease?.requiredGeneration).toBeNull();
  });

  it("drains events without foreground dispatch for entities-event admin processing", async () => {
    process.env.CLAWFORCE_CONTROLLER_GENERATION = "gen-cli-current";
    resetControllerIdentityForTest();

    acquireControllerLease(PROJECT_ID, {
      ownerId: "controller:stale",
      ownerLabel: "stale-controller",
      purpose: "sweep",
      generation: "gen-stale",
      ttlMs: 60_000,
    }, db);

    ingestEvent(PROJECT_ID, "budget_changed", "internal", {
      oldLimit: 100,
      newLimit: 150,
      source: "test",
    }, undefined, db);

    const result = await cli.drainProjectWorkflow(PROJECT_ID, 5, {
      db,
      dispatchMode: "events_only",
      reason: "test:events_only_drain",
      metadata: { test: true },
    });

    expect(result.eventsProcessed).toBeGreaterThan(0);
    expect(result.dispatched).toBe(0);
    expect(result.controller).toBeUndefined();
    const pending = db.prepare(
      "SELECT COUNT(*) as count FROM events WHERE project_id = ? AND status = 'pending'",
    ).get(PROJECT_ID) as { count: number };
    expect(pending.count).toBe(0);
  });

  // ─── cmdStatus ──────────────────────────────────────────────────

  describe("cmdStatus", () => {
    it("runs without error", () => {
      expect(() => cli.cmdStatus(db)).not.toThrow();
    });

    it("outputs gateway, budget, task, and queue info", () => {
      cli.cmdStatus(db);
      const output = getLogOutput();
      expect(output).toContain("ClawForce Status");
      expect(output).toContain("Budget");
      expect(output).toContain("Tasks");
      expect(output).toContain("Queue");
    });

    it("shows budget percentage", () => {
      cli.cmdStatus(db);
      const output = getLogOutput();
      expect(output).toContain("25%");
    });

    it("JSON mode returns valid structure", () => {
      cli.cmdStatus(db, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json).toHaveProperty("budget");
      expect(json).toHaveProperty("tasks");
      expect(json).toHaveProperty("queue");
      expect(json).toHaveProperty("burn_rate");
      expect((json.budget as Record<string, unknown>).daily_limit_cents).toBe(50000);
    });
  });

  // ─── cmdTasks ───────────────────────────────────────────────────

  describe("cmdTasks", () => {
    it("shows active tasks without filter", () => {
      cli.cmdTasks(db);
      const output = getLogOutput();
      expect(output).toContain("ASSIGNED");
      expect(output).toContain("IN_PROGRESS");
      expect(output).toContain("REVIEW");
      // DONE and CANCELLED should not appear in active view
      expect(output).not.toContain("[DONE]");
    });

    it("filters by state", () => {
      cli.cmdTasks(db, "DONE");
      const output = getLogOutput();
      expect(output).toContain("DONE");
      expect(output).not.toContain("[ASSIGNED]");
    });

    it("shows no tasks message for empty filter", () => {
      cli.cmdTasks(db, "CANCELLED");
      const output = getLogOutput();
      expect(output).toContain("No tasks found");
    });

    it("JSON mode with filter", () => {
      cli.cmdTasks(db, "ASSIGNED", true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json).toHaveProperty("filter", "ASSIGNED");
      expect(json).toHaveProperty("tasks");
      expect(Array.isArray(json.tasks)).toBe(true);
      const tasks = json.tasks as Array<Record<string, unknown>>;
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.state).toBe("ASSIGNED");
    });

    it("JSON mode without filter shows active", () => {
      cli.cmdTasks(db, undefined, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.filter).toBe("active");
    });

    it("treats filter text as a bound parameter", () => {
      cli.cmdTasks(db, "ASSIGNED' OR 1=1 --");
      const output = getLogOutput();
      expect(output).toContain("No tasks found");
    });
  });

  // ─── cmdCosts ───────────────────────────────────────────────────

  describe("cmdCosts", () => {
    it("shows costs by agent (default)", () => {
      cli.cmdCosts(db);
      const output = getLogOutput();
      expect(output).toContain("Costs by Agent");
      expect(output).toContain("Total:");
    });

    it("shows costs by task", () => {
      cli.cmdCosts(db, "task");
      const output = getLogOutput();
      expect(output).toContain("Costs by Task");
    });

    it("shows costs by day", () => {
      cli.cmdCosts(db, "day");
      const output = getLogOutput();
      expect(output).toContain("Costs by Day");
    });

    it("respects hours parameter", () => {
      // With 0 hours, should see no data since window is 0
      cli.cmdCosts(db, undefined, 0);
      const output = getLogOutput();
      expect(output).toContain("Costs by Agent");
    });

    it("JSON mode by agent", () => {
      cli.cmdCosts(db, undefined, 24, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.group_by).toBe("agent");
      expect(json).toHaveProperty("total_cents");
      expect(json).toHaveProperty("rows");
    });

    it("JSON mode by task", () => {
      cli.cmdCosts(db, "task", 24, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.group_by).toBe("task");
    });

    it("JSON mode by day", () => {
      cli.cmdCosts(db, "day", undefined, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.group_by).toBe("day");
    });
  });

  // ─── cmdQueue ───────────────────────────────────────────────────

  describe("cmdQueue", () => {
    it("shows dispatch queue status", () => {
      cli.cmdQueue(db);
      const output = getLogOutput();
      expect(output).toContain("Dispatch Queue");
    });

    it("shows failure reasons", () => {
      cli.cmdQueue(db);
      const output = getLogOutput();
      expect(output).toContain("Failure reasons");
      expect(output).toContain("Agent process exited");
    });

    it("JSON mode returns counts and failures", () => {
      cli.cmdQueue(db, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json).toHaveProperty("counts");
      expect(json).toHaveProperty("failures");
      expect(json).toHaveProperty("recent");
      const counts = json.counts as Record<string, number>;
      expect(counts.queued).toBe(1);
      expect(counts.failed).toBe(1);
    });
  });

  describe("cmdQueueRetry", () => {
    it("requeues a failed dispatch item for a still-assigned task", async () => {
      db.prepare("UPDATE tasks SET state = 'ASSIGNED', assigned_to = 'cf-worker-1' WHERE id = ? AND project_id = ?")
        .run("task-4", PROJECT_ID);

      await cli.cmdQueueRetry(PROJECT_ID, db, {
        taskId: "task-4",
        json: true,
      });

      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json).toHaveProperty("previousItem");
      expect(json).toHaveProperty("queueItem");

      const counts = db.prepare(
        "SELECT COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? AND task_id = ? AND status = 'queued'",
      ).get(PROJECT_ID, "task-4") as Record<string, unknown>;
      expect(Number(counts.cnt)).toBeGreaterThanOrEqual(1);
    });

    it("fails cleanly when the task is not retryable", async () => {
      db.prepare("UPDATE tasks SET state = 'BLOCKED' WHERE id = ? AND project_id = ?")
        .run("task-4", PROJECT_ID);

      await cli.cmdQueueRetry(PROJECT_ID, db, {
        taskId: "task-4",
        json: true,
      });

      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(String(json.reason)).toContain("not a recurring workflow run");
    });

    it("processes follow-on events and can dispatch requeued work when requested", async () => {
      db.prepare("UPDATE tasks SET state = 'ASSIGNED', assigned_to = 'cf-worker-1' WHERE id = ? AND project_id = ?")
        .run("task-4", PROJECT_ID);
      ingestEvent(PROJECT_ID, "budget_changed", "internal", {
        oldLimit: 100,
        newLimit: 150,
        source: "test",
      }, undefined, db);

      await cli.cmdQueueRetry(PROJECT_ID, db, {
        taskId: "task-4",
        process: true,
        json: true,
      });

      const json = getJsonOutput() as Record<string, unknown>;
      const processed = json.processed as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(Number(processed.dispatched)).toBeGreaterThan(0);
      const pending = db.prepare(
        "SELECT COUNT(*) as count FROM events WHERE project_id = ? AND status = 'pending'",
      ).get(PROJECT_ID) as { count: number };
      expect(pending.count).toBe(0);
    });

    it("returns promptly with event-only follow-on when a live controller already exists", async () => {
      db.prepare("UPDATE tasks SET state = 'ASSIGNED', assigned_to = 'cf-worker-1' WHERE id = ? AND project_id = ?")
        .run("task-4", PROJECT_ID);
      ingestEvent(PROJECT_ID, "budget_changed", "internal", {
        oldLimit: 100,
        newLimit: 150,
        source: "test",
      }, undefined, db);
      acquireControllerLease(PROJECT_ID, {
        ownerId: "controller:live",
        ownerLabel: "live-controller",
        purpose: "controller",
        ttlMs: 60_000,
      }, db);

      await cli.cmdQueueRetry(PROJECT_ID, db, {
        taskId: "task-4",
        process: true,
        json: true,
      });

      const json = getJsonOutput() as Record<string, unknown>;
      const processed = json.processed as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(Number(processed.dispatched)).toBe(0);
      const pending = db.prepare(
        "SELECT COUNT(*) as count FROM events WHERE project_id = ? AND status = 'pending'",
      ).get(PROJECT_ID) as { count: number };
      expect(pending.count).toBe(0);
    });

    it("loads project config before replaying a blocked recurring run", async () => {
      const recurringTask = createTask({
        projectId: PROJECT_ID,
        title: "Run recurring workflow worker.intake-triage",
        createdBy: "system:recurring-job",
        assignedTo: "worker",
        description: "## Acceptance Criteria\n- recover the recurring run cleanly.",
        metadata: {
          recurringJob: {
            agentId: "worker",
            jobName: "intake-triage",
            schedule: "*/20 * * * *",
            reason: "never run before",
            scheduledAt: Date.now(),
          },
        },
        tags: ["recurring-job", "agent:worker", "job:intake-triage"],
        kind: "infra",
        origin: "reactive",
      }, db);
      db.prepare(`
        INSERT INTO dispatch_queue (
          id, project_id, task_id, priority, payload, status, dispatch_attempts, max_dispatch_attempts, last_error, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, 'failed', 3, 3, ?, ?, ?)
      `).run(
        "queue-recurring-failed",
        PROJECT_ID,
        recurringTask.id,
        1,
        JSON.stringify({ prompt: "retry this" }),
        "Dispatch retries exhausted",
        Date.now() - 1_000,
        Date.now(),
      );
      db.prepare("UPDATE tasks SET state = 'BLOCKED', updated_at = ? WHERE id = ? AND project_id = ?")
        .run(Date.now(), recurringTask.id, PROJECT_ID);

      const initSpy = vi.spyOn(configInit, "initializeAllDomains").mockReturnValue({
        domains: [],
        errors: [],
        warnings: [],
        claimedProjectDirs: [],
      });
      const agentSpy = vi.spyOn(projectModule, "getAgentConfig").mockReturnValue({
        agentId: "worker",
        config: {
          jobs: {
            "intake-triage": {
              cron: "*/20 * * * *",
              nudge: "Recover blocked recurring work.",
            },
          },
        },
      } as any);

      try {
        await cli.cmdQueueRetry(PROJECT_ID, db, {
          taskId: recurringTask.id,
          json: true,
        });

        const json = getJsonOutput() as Record<string, unknown>;
        expect(initSpy).toHaveBeenCalled();
        expect(json.ok).toBe(true);
        const queueItem = json.queueItem as Record<string, unknown>;
        expect(queueItem.taskId).not.toBe(recurringTask.id);
      } finally {
        initSpy.mockRestore();
        agentSpy.mockRestore();
      }
    });
  });

  describe("cmdQueueRelease", () => {
    it("releases an active leased queue item back to queued", async () => {
      db.prepare("UPDATE tasks SET state = 'ASSIGNED', assigned_to = 'cf-worker-1' WHERE id = ? AND project_id = ?")
        .run("task-1", PROJECT_ID);
      db.prepare("UPDATE dispatch_queue SET status = 'leased', leased_by = 'dispatcher:test', leased_at = ?, lease_expires_at = ? WHERE id = ?")
        .run(Date.now(), Date.now() + 60_000, "q-1");

      await cli.cmdQueueRelease(PROJECT_ID, db, {
        taskId: "task-1",
        reason: "restart controller",
        json: true,
      });

      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.ok).toBe(true);
      const queueItem = json.queueItem as Record<string, unknown>;
      expect(queueItem.status).toBe("queued");
    });

    it("fails cleanly when no active queue item exists", async () => {
      await cli.cmdQueueRelease(PROJECT_ID, db, {
        taskId: "task-missing-active",
        json: true,
      });

      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(String(json.reason)).toContain("No active leased/dispatched queue item");
    });

    it("drains follow-on events and can dispatch released work when requested", async () => {
      db.prepare("UPDATE tasks SET state = 'ASSIGNED', assigned_to = 'cf-worker-1' WHERE id = ? AND project_id = ?")
        .run("task-1", PROJECT_ID);
      db.prepare("UPDATE dispatch_queue SET status = 'leased', leased_by = 'dispatcher:test', leased_at = ?, lease_expires_at = ? WHERE id = ?")
        .run(Date.now(), Date.now() + 60_000, "q-1");
      ingestEvent(PROJECT_ID, "budget_changed", "internal", {
        oldLimit: 150,
        newLimit: 175,
        source: "test",
      }, undefined, db);

      await cli.cmdQueueRelease(PROJECT_ID, db, {
        taskId: "task-1",
        process: true,
        json: true,
      });

      const json = getJsonOutput() as Record<string, unknown>;
      const processed = json.processed as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(Number(processed.dispatched)).toBeGreaterThan(0);
      const pending = db.prepare(
        "SELECT COUNT(*) as count FROM events WHERE project_id = ? AND status = 'pending'",
      ).get(PROJECT_ID) as { count: number };
      expect(pending.count).toBe(0);
    });
  });

  // ─── cmdTransitions ─────────────────────────────────────────────

  describe("cmdTransitions", () => {
    it("shows recent transitions", () => {
      cli.cmdTransitions(db, 24);
      const output = getLogOutput();
      expect(output).toContain("Transitions");
      expect(output).toMatch(/OPEN.*ASSIGNED/);
    });

    it("shows no transitions for zero-hour window", () => {
      cli.cmdTransitions(db, 0);
      const output = getLogOutput();
      expect(output).toContain("No transitions");
    });
  });

  // ─── cmdErrors ──────────────────────────────────────────────────

  describe("cmdErrors", () => {
    it("shows failed tasks and dispatches", () => {
      cli.cmdErrors(db, 24);
      const output = getLogOutput();
      expect(output).toContain("Errors");
    });

    it("runs without error on empty window", () => {
      expect(() => cli.cmdErrors(db, 0)).not.toThrow();
    });
  });

  // ─── cmdAgents ──────────────────────────────────────────────────

  describe("cmdAgents", () => {
    it("shows agent activity", () => {
      cli.cmdAgents(db);
      const output = getLogOutput();
      expect(output).toContain("Agents");
      expect(output).toContain("cf-lead");
    });

    it("JSON mode", () => {
      cli.cmdAgents(db, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json).toHaveProperty("agents");
      expect(json).toHaveProperty("assignments");
      const agents = json.agents as Array<Record<string, unknown>>;
      expect(agents.length).toBeGreaterThan(0);
    });
  });

  // ─── cmdStreams ─────────────────────────────────────────────────

  describe("cmdStreams", () => {
    it("lists available data streams", () => {
      cli.cmdStreams(db);
      const output = getLogOutput();
      expect(output).toContain("Available Data Streams");
      expect(output).toContain("cost_summary");
      expect(output).toContain("trust_scores");
    });
  });

  // ─── cmdQuery ───────────────────────────────────────────────────

  describe("cmdQuery", () => {
    it("executes a SQL query", () => {
      cli.cmdQuery(db, "SELECT COUNT(*) as cnt FROM tasks");
      const output = getLogOutput();
      expect(output).toContain("cnt");
      expect(output).toContain("5");
    });

    it("handles no rows", () => {
      cli.cmdQuery(db, "SELECT * FROM tasks WHERE id = 'nonexistent'");
      const output = getLogOutput();
      expect(output).toContain("(no rows)");
    });

    it("handles SQL errors gracefully", () => {
      cli.cmdQuery(db, "SELECT * FROM nonexistent_table");
      const output = errorOutput.join("\n");
      expect(output).toContain("SQL error");
    });
  });

  // ─── cmdDashboard ───────────────────────────────────────────────

  describe("cmdDashboard", () => {
    it("runs without error", () => {
      expect(() => cli.cmdDashboard(db, PROJECT_ID, 24)).not.toThrow();
    });

    it("shows all dashboard sections", () => {
      cli.cmdDashboard(db, PROJECT_ID, 24);
      const output = getLogOutput();
      expect(output).toContain("Dashboard");
      expect(output).toContain("Agent Status");
      expect(output).toContain("Pending Proposals");
      expect(output).toContain("Queue Health");
      expect(output).toContain("Recent Transitions");
      expect(output).toContain("Budget");
    });

    it("JSON mode returns complete structure", () => {
      cli.cmdDashboard(db, PROJECT_ID, 24, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json).toHaveProperty("hours", 24);
      expect(json).toHaveProperty("total_sessions");
      expect(json).toHaveProperty("total_cost_cents");
      expect(json).toHaveProperty("anomalies");
      expect(json).toHaveProperty("agents");
      expect(json).toHaveProperty("pending_proposals");
      expect(json).toHaveProperty("queue");
      expect(json).toHaveProperty("budget");
      expect(json).toHaveProperty("active_tasks");
      expect(Array.isArray(json.anomalies)).toBe(true);
    });

    it("JSON mode budget data matches seeded values", () => {
      cli.cmdDashboard(db, PROJECT_ID, 24, true);
      const json = getJsonOutput() as Record<string, unknown>;
      const budget = json.budget as Record<string, number>;
      expect(budget.daily_limit_cents).toBe(50000);
      expect(budget.daily_spent_cents).toBe(12500);
    });
  });

  // ─── cmdSessions ───────────────────────────────────────────────

  describe("cmdSessions", () => {
    it("shows sessions", () => {
      cli.cmdSessions(db, PROJECT_ID, 24);
      const output = getLogOutput();
      expect(output).toContain("Sessions");
    });

    it("filters by agent", () => {
      cli.cmdSessions(db, PROJECT_ID, 24, "cf-lead");
      const output = getLogOutput();
      expect(output).toContain("agent: cf-lead");
    });

    it("shows no sessions for narrow window", () => {
      cli.cmdSessions(db, PROJECT_ID, 0);
      const output = getLogOutput();
      expect(output).toContain("No sessions found");
    });

    it("JSON mode", () => {
      cli.cmdSessions(db, PROJECT_ID, 24, undefined, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json).toHaveProperty("hours", 24);
      expect(json).toHaveProperty("sessions");
      expect(Array.isArray(json.sessions)).toBe(true);
    });

    it("JSON mode with agent filter", () => {
      cli.cmdSessions(db, PROJECT_ID, 24, "cf-lead", true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.agent_filter).toBe("cf-lead");
    });

    it("renders colon-bearing agent IDs without truncating them", () => {
      const now = Date.now();
      db.prepare(`
        INSERT INTO session_archives (id, session_key, agent_id, project_id, outcome, total_cost_cents, started_at, ended_at, duration_ms, tool_call_count, error_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "sa-colon",
        "agent:agent:verifier:cron:session-colon",
        "agent:verifier",
        PROJECT_ID,
        "success",
        25,
        now - 120_000,
        now - 60_000,
        60_000,
        1,
        0,
        now,
      );

      cli.cmdSessions(db, PROJECT_ID, 24, "agent:verifier");
      const output = getLogOutput();
      expect(output).toContain("agent:verifier (cron)");
    });
  });

  // ─── cmdSessionDetail ──────────────────────────────────────────

  describe("cmdSessionDetail", () => {
    it("shows detailed session info", () => {
      cli.cmdSessionDetail(db, PROJECT_ID, "agent:cf-lead:cron:session-0");
      const output = getLogOutput();
      expect(output).toContain("Session:");
      expect(output).toContain("cf-lead");
      expect(output).toContain("Tool Call Sequence");
    });

    it("matches partial session key", () => {
      cli.cmdSessionDetail(db, PROJECT_ID, "agent:cf-lead:cron:session-0");
      const output = getLogOutput();
      expect(output).toContain("cf-lead");
    });
  });

  // ─── cmdProposals ──────────────────────────────────────────────

  describe("cmdProposals", () => {
    it("shows pending proposals by default", () => {
      cli.cmdProposals(db, PROJECT_ID, "pending");
      const output = getLogOutput();
      expect(output).toContain("Proposals (pending");
      expect(output).toContain("pending");
    });

    it("shows all proposals", () => {
      cli.cmdProposals(db, PROJECT_ID, "all");
      const output = getLogOutput();
      expect(output).toContain("approved");
      expect(output).toContain("rejected");
    });

    it("filters by hours", () => {
      cli.cmdProposals(db, PROJECT_ID, "all", 1);
      const output = getLogOutput();
      expect(output).toContain("last 1h");
    });

    it("shows no proposals for empty filter", () => {
      cli.cmdProposals(db, PROJECT_ID, "nonexistent-status");
      const output = getLogOutput();
      expect(output).toContain("No proposals found");
    });

    it("JSON mode", () => {
      cli.cmdProposals(db, PROJECT_ID, "all", undefined, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json).toHaveProperty("proposals");
      const proposals = json.proposals as Array<Record<string, unknown>>;
      expect(proposals.length).toBe(4);
    });
  });

  // ─── cmdFlows ──────────────────────────────────────────────────

  describe("cmdFlows", () => {
    it("shows flows", () => {
      cli.cmdFlows(db, PROJECT_ID, 24);
      const output = getLogOutput();
      expect(output).toContain("Flows");
    });

    it("shows no sessions for narrow window", () => {
      cli.cmdFlows(db, PROJECT_ID, 0);
      const output = getLogOutput();
      expect(output).toContain("No sessions found");
    });

    it("filters by agent", () => {
      cli.cmdFlows(db, PROJECT_ID, 24, "cf-lead");
      const output = getLogOutput();
      expect(output).toContain("agent: cf-lead");
    });

    it("expand mode shows full tool calls", () => {
      cli.cmdFlows(db, PROJECT_ID, 24, undefined, true);
      const output = getLogOutput();
      // In expanded mode we should see individual tool calls
      expect(output).toContain("Flows");
    });
  });

  // ─── cmdMetrics ─────────────────────────────────────────────────

  describe("cmdMetrics", () => {
    it("shows per-agent metrics", () => {
      cli.cmdMetrics(db, PROJECT_ID, 24);
      const output = getLogOutput();
      expect(output).toContain("Per-Agent Metrics");
    });

    it("shows no data for narrow window", () => {
      cli.cmdMetrics(db, PROJECT_ID, 0);
      const output = getLogOutput();
      expect(output).toContain("No session data available");
    });

    it("JSON mode", () => {
      cli.cmdMetrics(db, PROJECT_ID, 24, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json).toHaveProperty("hours", 24);
      expect(json).toHaveProperty("agents");
      const agents = json.agents as Array<Record<string, unknown>>;
      expect(agents.length).toBeGreaterThan(0);
      // Each agent should have proposals and completed_tasks
      expect(agents[0]).toHaveProperty("proposals");
      expect(agents[0]).toHaveProperty("completed_tasks");
    });
  });

  // ─── cmdBudget ──────────────────────────────────────────────────

  describe("cmdBudget", () => {
    it("shows budget pacing", () => {
      cli.cmdBudget(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("Budget Pacing");
      expect(output).toContain("Daily:");
      expect(output).toContain("Burn rate:");
    });

    it("shows per-agent budgets", () => {
      cli.cmdBudget(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("Per-Agent:");
      expect(output).toContain("cf-lead");
    });

    it("shows pacing section", () => {
      cli.cmdBudget(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("Pacing:");
      expect(output).toContain("Target rate:");
    });

    it("JSON mode", () => {
      cli.cmdBudget(db, PROJECT_ID, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json).toHaveProperty("budget");
      expect(json).toHaveProperty("burn_rate_cents_per_hour");
      expect(json).toHaveProperty("agent_budgets");
      const agentBudgets = json.agent_budgets as Array<Record<string, unknown>>;
      expect(agentBudgets.length).toBe(1);
      expect(agentBudgets[0]!.agent_id).toBe("cf-lead");
    });
  });

  // ─── cmdTrust ───────────────────────────────────────────────────

  describe("cmdTrust", () => {
    it("shows trust overview", () => {
      cli.cmdTrust(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("Trust Overview");
      expect(output).toContain("cf-lead");
    });

    it("shows trust scores and tiers", () => {
      cli.cmdTrust(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("score:");
      expect(output).toContain("tier:");
    });

    it("JSON mode", () => {
      cli.cmdTrust(db, PROJECT_ID, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json).toHaveProperty("agents");
      const agents = json.agents as Array<Record<string, unknown>>;
      expect(agents.length).toBe(3);
      expect(agents[0]).toHaveProperty("score");
      expect(agents[0]).toHaveProperty("tier");
      expect(agents[0]).toHaveProperty("trend_24h");
    });
  });

  // ─── cmdInbox ───────────────────────────────────────────────────

  describe("cmdInbox", () => {
    it("shows inbox messages", () => {
      cli.cmdInbox(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("Inbox");
      expect(output).toContain("Test message");
    });
  });

  // ─── cmdApprove ─────────────────────────────────────────────────

  describe("cmdApprove", () => {
    it("approves a pending proposal", async () => {
      const initSpy = vi.spyOn(configInit, "initializeAllDomains").mockReturnValue({
        domains: [],
        errors: [],
        warnings: [],
        claimedProjectDirs: [],
      });
      await cli.cmdApprove(db, PROJECT_ID, "proposal-0", { processFollowOn: false });
      const output = getLogOutput();
      expect(output).toContain("Approved:");
      expect(initSpy).toHaveBeenCalled();

      // Verify DB update
      const proposal = db.prepare("SELECT status FROM proposals WHERE id = 'proposal-0'").get() as { status: string };
      expect(proposal.status).toBe("approved");
    });

    it("records feedback when provided", async () => {
      await cli.cmdApprove(db, PROJECT_ID, "proposal-0", {
        feedback: "Approved during dogfood",
        processFollowOn: false,
      });
      const output = getLogOutput();
      expect(output).toContain("Feedback: Approved during dogfood");

      const proposal = db.prepare(
        "SELECT user_feedback FROM proposals WHERE id = 'proposal-0'",
      ).get() as { user_feedback: string };
      expect(proposal.user_feedback).toBe("Approved during dogfood");
    });

    it("creates an approval event", async () => {
      await cli.cmdApprove(db, PROJECT_ID, "proposal-3", { processFollowOn: false });
      const event = db.prepare(
        "SELECT type FROM events WHERE type = 'proposal_approved' ORDER BY created_at DESC LIMIT 1"
      ).get() as { type: string } | undefined;
      expect(event?.type).toBe("proposal_approved");
    });

    it("drains follow-on events without foreground dispatch by default", async () => {
      vi.spyOn(configInit, "initializeAllDomains").mockReturnValue({
        domains: [],
        errors: [],
        warnings: [],
        claimedProjectDirs: [],
      });
      await cli.cmdApprove(db, PROJECT_ID, "proposal-0", {
        json: true,
        processFollowOn: true,
      });
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.followOnEventsProcessed).toBeGreaterThanOrEqual(0);
      expect(json.followOnDispatches).toBe(0);
    });
  });

  // ─── cmdReject ──────────────────────────────────────────────────

  describe("cmdReject", () => {
    it("rejects a pending proposal", async () => {
      const initSpy = vi.spyOn(configInit, "initializeAllDomains").mockReturnValue({
        domains: [],
        errors: [],
        warnings: [],
        claimedProjectDirs: [],
      });
      await cli.cmdReject(db, PROJECT_ID, "proposal-0", undefined, { processFollowOn: false });
      const output = getLogOutput();
      expect(output).toContain("Rejected:");
      expect(initSpy).toHaveBeenCalled();

      const proposal = db.prepare("SELECT status FROM proposals WHERE id = 'proposal-0'").get() as { status: string };
      expect(proposal.status).toBe("rejected");
    });

    it("includes feedback", async () => {
      await cli.cmdReject(db, PROJECT_ID, "proposal-3", "Not appropriate", { processFollowOn: false });
      const output = getLogOutput();
      expect(output).toContain("Feedback: Not appropriate");

      const proposal = db.prepare("SELECT user_feedback FROM proposals WHERE id = 'proposal-3'").get() as { user_feedback: string };
      expect(proposal.user_feedback).toBe("Not appropriate");
    });
  });

  // ─── cmdVerdict ─────────────────────────────────────────────────

  describe("cmdVerdict", () => {
    it("passes a review task and records DONE", async () => {
      const initSpy = vi.spyOn(configInit, "initializeAllDomains").mockReturnValue({
        domains: [],
        errors: [],
        warnings: [],
        claimedProjectDirs: [],
      });
      await cli.cmdVerdict(db, PROJECT_ID, "task-3", true, {
        actor: "operator:cli",
        reason: "Looks good",
        processFollowOn: false,
      });
      const output = getLogOutput();
      expect(output).toContain("Passed review");
      expect(output).toContain("DONE");

      const task = db.prepare("SELECT state FROM tasks WHERE id = 'task-3'").get() as { state: string };
      expect(task.state).toBe("DONE");
      expect(initSpy).toHaveBeenCalled();
    });

    it("returns JSON for failed verdicts", async () => {
      const initSpy = vi.spyOn(configInit, "initializeAllDomains").mockReturnValue({
        domains: [],
        errors: [],
        warnings: [],
        claimedProjectDirs: [],
      });
      await cli.cmdVerdict(db, PROJECT_ID, "task-3", false, {
        actor: "operator:cli",
        reason: "Needs more work",
        reasonCode: "verification_environment_blocked",
        json: true,
        processFollowOn: false,
      });
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.taskId).toBe("task-3");
      expect(json.passed).toBe(false);
       expect(json.reasonCode).toBe("verification_environment_blocked");
      expect((json.result as Record<string, unknown>).ok).toBe(true);
      expect(((json.result as Record<string, unknown>).task as Record<string, unknown>).state).toBe("BLOCKED");
      expect(json.followOnEventsProcessed).toBe(0);
      expect(initSpy).toHaveBeenCalled();
    });

    it("prints BLOCKED for verification_environment_blocked verdicts in human output", async () => {
      vi.spyOn(configInit, "initializeAllDomains").mockReturnValue({
        domains: [],
        errors: [],
        warnings: [],
        claimedProjectDirs: [],
      });
      await cli.cmdVerdict(db, PROJECT_ID, "task-3", false, {
        actor: "operator:cli",
        reason: "Sandbox blocked the decisive rerun",
        reasonCode: "verification_environment_blocked",
        processFollowOn: false,
      });

      const output = getLogOutput();
      expect(output).toContain("Failed review");
      expect(output).toContain("BLOCKED");
      expect(output).toContain("Reason code: verification_environment_blocked");
    });

    it("defaults to event-only follow-on processing unless wait is requested", async () => {
      vi.spyOn(configInit, "initializeAllDomains").mockReturnValue({
        domains: [],
        errors: [],
        warnings: [],
        claimedProjectDirs: [],
      });
      await cli.cmdVerdict(db, PROJECT_ID, "task-3", true, {
        actor: "operator:cli",
        reason: "Looks good",
        json: true,
        processFollowOn: true,
      });
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.passed).toBe(true);
      expect(json.followOnDispatches).toBe(0);
    });
  });

  describe("cmdReview", () => {
    it("shows task review detail", () => {
      const initSpy = vi.spyOn(configInit, "initializeAllDomains").mockReturnValue({
        domains: [],
        errors: [],
        warnings: [],
        claimedProjectDirs: [],
      });
      db.prepare(`
        INSERT INTO manager_reviews (
          id, project_id, task_id, reviewer_agent_id, verdict, reason_code, reasoning, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("review-1", PROJECT_ID, "task-3", "operator:cli", "rejected", "verification_environment_blocked", "Sandbox blocked the decisive rerun", Date.now());
      db.prepare(`
        INSERT INTO session_archives (
          id, session_key, agent_id, project_id, task_id, outcome, compliance_detail, started_at, ended_at, duration_ms, tool_call_count, error_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "review-session-1",
        "dispatch:test-review-1",
        "workflow-steward",
        PROJECT_ID,
        "task-3",
        "untracked",
        JSON.stringify({
          exitCode: 0,
          summarySynthetic: true,
          observedWork: false,
          resultSource: "synthetic",
          outputChars: 0,
          stdoutChars: 0,
          stderrChars: 68,
          promptChars: 2048,
          finalPromptChars: 3072,
          mcpBridgeDisabled: true,
          configOverrideCount: 3,
          stderrLooksLikeLaunchTranscript: true,
          stderr: "Reading additional input from stdin...\nOpenAI Codex v0.118.0",
        }),
        Date.now() - 5_000,
        Date.now() - 4_000,
        1_000,
        0,
        0,
        Date.now(),
      );

      cli.cmdReview(db, PROJECT_ID, "task-3", false);
      const output = getLogOutput();
      expect(output).toContain("## Review: Test task 3");
      expect(output).toContain("Reviews:");
      expect(output).toContain("[verification_environment_blocked]");
      expect(output).toContain("diag=source=synthetic");
      expect(output).toContain("config_overrides=3");
      expect(output).toContain("mcp_disabled=yes");
      expect(output).toContain("stderr_preview=Reading additional input from stdin...");
      expect(initSpy).toHaveBeenCalled();
    });
  });

  // ─── cmdMessage ─────────────────────────────────────────────────

  describe("cmdMessage", () => {
    it("sends a message", () => {
      cli.cmdMessage(db, PROJECT_ID, "cf-lead", "Hello from tests");
      const output = getLogOutput();
      expect(output).toContain("Message sent to cf-lead");

      const msg = db.prepare(
        "SELECT content, from_agent, to_agent FROM messages WHERE content = 'Hello from tests'"
      ).get() as Record<string, string>;
      expect(msg.from_agent).toBe("user");
      expect(msg.to_agent).toBe("cf-lead");
    });
  });

  // ─── cmdDisable / cmdEnable ─────────────────────────────────────

  describe("cmdDisable", () => {
    it("disables a domain", () => {
      cli.cmdDisable(db, PROJECT_ID, [], false);
      const output = getLogOutput();
      expect(output).toContain("Domain Disabled");

      // Verify DB
      const row = db.prepare(
        "SELECT reason FROM disabled_scopes WHERE project_id = ? AND scope_type = 'domain'"
      ).get(PROJECT_ID) as { reason: string };
      expect(row.reason).toContain("Disabled via CLI");
    });

    it("dry run does not modify DB", () => {
      cli.cmdDisable(db, PROJECT_ID, [], true);
      const output = getLogOutput();
      expect(output).toContain("DRY RUN");

      const row = db.prepare(
        "SELECT * FROM disabled_scopes WHERE project_id = ? AND scope_type = 'domain' AND scope_value = ?"
      ).get(PROJECT_ID, PROJECT_ID);
      expect(row).toBeUndefined();
    });

    it("shows already disabled when called twice", () => {
      cli.cmdDisable(db, PROJECT_ID, [], false);
      captureStop();
      captureStart();
      cli.cmdDisable(db, PROJECT_ID, [], false);
      const output = getLogOutput();
      expect(output).toContain("already disabled");
    });

    it("accepts custom reason", () => {
      cli.cmdDisable(db, PROJECT_ID, ["--reason=maintenance"], false);
      const row = db.prepare(
        "SELECT reason FROM disabled_scopes WHERE project_id = ? AND scope_type = 'domain'"
      ).get(PROJECT_ID) as { reason: string };
      expect(row.reason).toBe("maintenance");
    });
  });

  describe("cmdEnable", () => {
    it("enables a disabled domain", () => {
      // First disable
      cli.cmdDisable(db, PROJECT_ID, [], false);
      captureStop();
      captureStart();

      cli.cmdEnable(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("Domain Enabled");
    });

    it("says already enabled if not disabled", () => {
      cli.cmdEnable(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("already enabled");
    });
  });

  // ─── cmdKillResume ──────────────────────────────────────────────

  describe("cmdKillResume", () => {
    it("clears emergency stop flag", () => {
      // Set emergency stop
      db.prepare("INSERT OR REPLACE INTO project_metadata (project_id, key, value) VALUES (?, 'emergency_stop', 'true')").run(PROJECT_ID);

      cli.cmdKillResume(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("Emergency stop cleared");
    });

    it("says not active when no emergency stop", () => {
      cli.cmdKillResume(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("not active");
    });

    it("also re-enables domain if killed by cli:kill", () => {
      // Set emergency stop + kill-disabled domain
      db.prepare("INSERT OR REPLACE INTO project_metadata (project_id, key, value) VALUES (?, 'emergency_stop', 'true')").run(PROJECT_ID);
      db.prepare(`
        INSERT OR REPLACE INTO disabled_scopes (id, project_id, scope_type, scope_value, reason, disabled_at, disabled_by)
        VALUES ('kill-ds', ?, 'domain', ?, 'EMERGENCY: test', ?, 'cli:kill')
      `).run(PROJECT_ID, PROJECT_ID, Date.now());

      cli.cmdKillResume(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("re-enabled");
    });
  });

  // ─── cmdRunning ─────────────────────────────────────────────────

  describe("cmdRunning", () => {
    it("shows running state", () => {
      cli.cmdRunning(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("Running State");
      expect(output).toContain("Domain:");
    });

    it("shows tracked sessions as active without relying on ended_at", () => {
      db.prepare(`
        INSERT INTO tracked_sessions (session_key, agent_id, project_id, started_at, requirements, satisfied, tool_call_count, last_persisted_at, dispatch_context)
        VALUES (?, ?, ?, ?, '[]', '{}', 0, ?, ?)
      `).run(
        "dispatch:active-running",
        "worker-1",
        PROJECT_ID,
        Date.now() - 30_000,
        Date.now(),
        JSON.stringify({ taskId: "task-1", queueItemId: "queue-1" }),
      );

      cli.cmdRunning(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("Active Sessions: 2");
      expect(output).toContain("worker-1");
      expect(output).toContain("heartbeat=");
      expect(output).toContain("[live]");
    });

    it("hides stale tracked sessions from active running output", () => {
      db.prepare(`
        INSERT INTO tracked_sessions (session_key, agent_id, project_id, started_at, requirements, satisfied, tool_call_count, last_persisted_at, dispatch_context)
        VALUES (?, ?, ?, ?, '[]', '{}', 0, ?, ?)
      `).run(
        "dispatch:stale-probe",
        "workflow-steward",
        PROJECT_ID,
        Date.now() - 3_600_000,
        Date.now() - 3_600_000,
        JSON.stringify({ taskId: "task-1", queueItemId: "queue-stale" }),
      );

      cli.cmdRunning(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("Active Sessions: 1");
      expect(output).not.toContain("dispatch:stale-probe");
      expect(output).not.toContain("[stale]");
    });

    it("shows disabled scopes", () => {
      cli.cmdRunning(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("Disabled:");
      expect(output).toContain("workers");
    });

    it("shows queue status", () => {
      cli.cmdRunning(db, PROJECT_ID);
      const output = getLogOutput();
      expect(output).toContain("Queue:");
    });
  });

  describe("cmdController", () => {
    beforeEach(() => {
      vi.mocked(configWatcher.startConfigWatcher).mockClear();
      vi.mocked(configWatcher.stopConfigWatcher).mockClear();
      const runtimeDb = dbModule.getDb(PROJECT_ID);
      runtimeDb.prepare("DELETE FROM controller_leases WHERE project_id = ?").run(PROJECT_ID);
    });

    it("stays alive until explicitly aborted", async () => {
      const abortController = new AbortController();
      const initSpy = vi.spyOn(configInit, "initializeAllDomains").mockReturnValue({
        domains: [],
        errors: [],
        warnings: [],
        claimedProjectDirs: [],
      });
      const runPromise = cli.cmdController(PROJECT_ID, {
        intervalMs: 25,
        initialSweep: false,
        signal: abortController.signal,
      });

      const stateBeforeAbort = await Promise.race([
        runPromise.then(() => "resolved"),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
      ]);
      expect(stateBeforeAbort).toBe("pending");

      abortController.abort();
      await expect(runPromise).resolves.toBeUndefined();
      expect(initSpy).toHaveBeenCalled();
      expect(configWatcher.startConfigWatcher).toHaveBeenCalledTimes(1);
      expect(configWatcher.stopConfigWatcher).toHaveBeenCalledTimes(1);
      initSpy.mockRestore();
    });

    it("reloads the domain after acquiring the startup lease so setup can certify the applied config", async () => {
      const abortController = new AbortController();
      const initSpy = vi.spyOn(configInit, "initializeAllDomains").mockReturnValue({
        domains: [PROJECT_ID],
        errors: [],
        warnings: [],
        claimedProjectDirs: [],
      });
      const reloadSpy = vi.spyOn(configInit, "reloadDomain").mockReturnValue({
        domains: [PROJECT_ID],
        errors: [],
        warnings: [],
        claimedProjectDirs: [],
      });
      const recordSpy = vi.spyOn(configInit, "recordControllerAppliedDomainConfig").mockReturnValue(true);

      await cli.cmdController(PROJECT_ID, {
        intervalMs: 25,
        initialSweep: false,
        signal: abortController.signal,
        onStarted: () => abortController.abort(),
      });

      expect(initSpy).toHaveBeenCalled();
      expect(reloadSpy).toHaveBeenCalledWith(expect.any(String), PROJECT_ID);
      expect(recordSpy).toHaveBeenCalledWith(expect.any(String), PROJECT_ID, "config.controller.startup");
      initSpy.mockRestore();
      reloadSpy.mockRestore();
      recordSpy.mockRestore();
    });

    it("starts and stops a local controller cleanly on abort", async () => {
      const abortController = new AbortController();

      const runPromise = cli.cmdController(PROJECT_ID, {
        intervalMs: 25,
        initialSweep: false,
        signal: abortController.signal,
        onStarted: () => {
          expect(lifecycle.isClawforceInitialized()).toBe(true);
          expect(lifecycle.getActiveProjectIds()).toContain(PROJECT_ID);
          abortController.abort();
        },
      });

      await expect(runPromise).resolves.toBeUndefined();

      const output = getLogOutput();
      expect(output).toContain("## Controller");
      expect(output).toContain("State: running");
      expect(lifecycle.isClawforceInitialized()).toBe(false);
      expect(lifecycle.getActiveProjectIds()).not.toContain(PROJECT_ID);
      expect(configWatcher.startConfigWatcher).toHaveBeenCalledTimes(1);
      expect(configWatcher.stopConfigWatcher).toHaveBeenCalledTimes(1);
    });

    it("emits JSON startup output", async () => {
      const abortController = new AbortController();

      await cli.cmdController(PROJECT_ID, {
        intervalMs: 25,
        initialSweep: false,
        json: true,
        signal: abortController.signal,
        onStarted: () => abortController.abort(),
      });

      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.mode).toBe("controller");
      expect(json.projectId).toBe(PROJECT_ID);
      expect(json.intervalMs).toBe(25);
      expect(json.initialSweep).toBeNull();
    });

    it("refuses to start when another live controller already owns the lease", async () => {
      const runtimeDb = dbModule.getDb(PROJECT_ID);
      acquireControllerLease(PROJECT_ID, {
        ownerId: "controller:live",
        ownerLabel: "live-controller",
        purpose: "controller",
        ttlMs: 60_000,
      }, runtimeDb);

      await expect(cli.cmdController(PROJECT_ID, {
        intervalMs: 25,
        initialSweep: false,
      })).rejects.toThrow(/live-controller/);

      expect(configWatcher.startConfigWatcher).not.toHaveBeenCalled();
    });
  });

  describe("cmdServe", () => {
    beforeEach(() => {
      vi.mocked(configWatcher.startConfigWatcher).mockClear();
      vi.mocked(configWatcher.stopConfigWatcher).mockClear();
      vi.mocked(dashboardServer.createDashboardServer).mockClear();
      mockDashboardServer.start.mockClear();
      mockDashboardServer.stop.mockClear();
      mockDashboardServer.server.address.mockReturnValue({ port: 3117 });
    });

    it("starts and stops the standalone runtime cleanly on abort", async () => {
      const abortController = new AbortController();

      const runPromise = cli.cmdServe({
        intervalMs: 25,
        signal: abortController.signal,
        onStarted: () => {
          expect(lifecycle.isClawforceInitialized()).toBe(true);
          abortController.abort();
        },
      });

      await expect(runPromise).resolves.toBeUndefined();

      const output = getLogOutput();
      expect(output).toContain("## Standalone Runtime");
      expect(output).toContain("Mode: standalone");
      expect(mockDashboardServer.start).toHaveBeenCalledTimes(1);
      expect(mockDashboardServer.stop).toHaveBeenCalledTimes(1);
      expect(configWatcher.startConfigWatcher).toHaveBeenCalledTimes(1);
      expect(configWatcher.stopConfigWatcher).toHaveBeenCalledTimes(1);
      expect(lifecycle.isClawforceInitialized()).toBe(false);
    });

    it("emits JSON startup output", async () => {
      const abortController = new AbortController();

      await cli.cmdServe({
        intervalMs: 25,
        json: true,
        signal: abortController.signal,
        onStarted: () => abortController.abort(),
      });

      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.mode).toBe("standalone");
      expect(json.port).toBe(3117);
      expect(json.intervalMs).toBe(25);
      expect(json.domains).toEqual(expect.any(Array));
    });
  });

  // ─── detectAnomalies ───────────────────────────────────────────

  describe("detectAnomalies", () => {
    it("returns an array", () => {
      const anomalies = cli.detectAnomalies(db, PROJECT_ID, 24);
      expect(Array.isArray(anomalies)).toBe(true);
    });

    it("detects stuck queue items", () => {
      // Add an old queued item
      db.prepare(`
        INSERT INTO dispatch_queue (id, project_id, task_id, priority, status, created_at)
        VALUES ('stuck-1', ?, 'task-1', 1, 'queued', ?)
      `).run(PROJECT_ID, Date.now() - 60 * 60_000);

      const anomalies = cli.detectAnomalies(db, PROJECT_ID, 4);
      const stuckAnomaly = anomalies.find(a => a.includes("stuck in queue"));
      expect(stuckAnomaly).toBeDefined();
    });

    it("detects stale worker tasks", () => {
      // Add an old assigned worker task
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, assigned_to, created_by, created_at, updated_at, retry_count, max_retries)
        VALUES ('stale-worker-task', ?, 'Stale worker task', 'ASSIGNED', 'P2', 'cf-worker-stale', 'system', ?, ?, 0, 3)
      `).run(PROJECT_ID, Date.now() - 3 * 3600_000, Date.now() - 2 * 3600_000);

      const anomalies = cli.detectAnomalies(db, PROJECT_ID, 4);
      const workerAnomaly = anomalies.find(a => a.includes("cf-worker-stale"));
      expect(workerAnomaly).toBeDefined();
    });

    it("returns empty array on clean system", () => {
      const cleanDb = createTestDb();
      const anomalies = cli.detectAnomalies(cleanDb, "clean-project", 4);
      expect(anomalies).toEqual([]);
      cleanDb.close();
    });
  });

  // ─── cmdWatch ───────────────────────────────────────────────────

  describe("cmdWatch", () => {
    it("JSON mode returns valid structure", () => {
      cli.cmdWatch(db, PROJECT_ID, false, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json).toHaveProperty("has_changes");
      expect(json).toHaveProperty("anomalies");
      expect(json).toHaveProperty("completed_tasks");
      expect(json).toHaveProperty("failed_tasks");
      expect(json).toHaveProperty("new_sessions");
      expect(json).toHaveProperty("state_changes");
      expect(json).toHaveProperty("new_proposals");
    });

    it("includes active tracked sessions in the rendered watch output", () => {
      db.prepare(`
        INSERT INTO tracked_sessions (session_key, agent_id, project_id, started_at, requirements, satisfied, tool_call_count, last_persisted_at, dispatch_context)
        VALUES (?, ?, ?, ?, '[]', '{}', 0, ?, ?)
      `).run(
        "dispatch:watch-active",
        "worker-2",
        PROJECT_ID,
        Date.now() - 45_000,
        Date.now(),
        JSON.stringify({ taskId: "task-1", queueItemId: "queue-2" }),
      );

      cli.cmdWatch(db, PROJECT_ID, false, false);
      const output = getLogOutput();
      expect(output).toContain("Active:");
      expect(output).toContain("worker-2");
      expect(output).toContain("Test task 1");
      expect(output).toContain("heartbeat");
    });

    it("omits stale tracked sessions from watch JSON", () => {
      db.prepare(`
        INSERT INTO tracked_sessions (session_key, agent_id, project_id, started_at, requirements, satisfied, tool_call_count, last_persisted_at, dispatch_context)
        VALUES (?, ?, ?, ?, '[]', '{}', 0, ?, ?)
      `).run(
        "dispatch:stale-probe",
        "workflow-steward",
        PROJECT_ID,
        Date.now() - 3_600_000,
        Date.now() - 3_600_000,
        JSON.stringify({ taskId: "task-1", queueItemId: "queue-stale" }),
      );

      cli.cmdWatch(db, PROJECT_ID, false, true);
      const json = getJsonOutput() as { active_sessions?: Array<{ session_key?: string }> };
      expect(Array.isArray(json.active_sessions)).toBe(true);
      expect(json.active_sessions?.some((entry) => entry.session_key === "dispatch:stale-probe")).toBe(false);
    });
  });

  // ─── cmdReplay ──────────────────────────────────────────────────

  describe("cmdReplay", () => {
    it("replays session with tool call details", () => {
      cli.cmdReplay(db, PROJECT_ID, "agent:cf-lead:cron:session-0");
      const output = getLogOutput();
      expect(output).toContain("Replay:");
      expect(output).toContain("cf-lead");
      // Should show tool calls
      expect(output).toContain("clawforce_task");
    });
  });

  // ─── Empty Database Edge Cases ─────────────────────────────────

  describe("empty database edge cases", () => {
    let emptyDb: DatabaseSync;

    beforeEach(() => {
      emptyDb = createTestDb();
    });

    afterEach(() => {
      try { emptyDb.close(); } catch { /* ignore */ }
    });

    it("cmdStatus on empty db", () => {
      expect(() => cli.cmdStatus(emptyDb)).not.toThrow();
    });

    it("cmdStatus JSON on empty db", () => {
      cli.cmdStatus(emptyDb, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json).toHaveProperty("tasks");
      expect(json.budget).toBeNull();
    });

    it("cmdTasks on empty db", () => {
      cli.cmdTasks(emptyDb);
      const output = getLogOutput();
      expect(output).toContain("No tasks found");
    });

    it("cmdCosts on empty db", () => {
      expect(() => cli.cmdCosts(emptyDb)).not.toThrow();
    });

    it("cmdQueue on empty db", () => {
      expect(() => cli.cmdQueue(emptyDb)).not.toThrow();
    });

    it("cmdAgents on empty db", () => {
      cli.cmdAgents(emptyDb);
      const output = getLogOutput();
      expect(output).toContain("Agents");
    });

    it("cmdDashboard on empty db", () => {
      expect(() => cli.cmdDashboard(emptyDb, "empty-proj", 4)).not.toThrow();
    });

    it("cmdDashboard JSON on empty db", () => {
      cli.cmdDashboard(emptyDb, "empty-proj", 4, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.total_sessions).toBe(0);
      expect(json.total_cost_cents).toBe(0);
    });

    it("cmdSessions on empty db", () => {
      cli.cmdSessions(emptyDb, "empty-proj", 4);
      const output = getLogOutput();
      expect(output).toContain("No sessions found");
    });

    it("cmdMetrics on empty db", () => {
      cli.cmdMetrics(emptyDb, "empty-proj", 24);
      const output = getLogOutput();
      expect(output).toContain("No session data available");
    });

    it("cmdBudget on empty db", () => {
      cli.cmdBudget(emptyDb, "empty-proj");
      const output = getLogOutput();
      expect(output).toContain("No budget configured");
    });

    it("cmdBudget JSON on empty db", () => {
      cli.cmdBudget(emptyDb, "empty-proj", true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json.budget).toBeNull();
    });

    it("cmdTrust on empty db", () => {
      cli.cmdTrust(emptyDb, "empty-proj");
      const output = getLogOutput();
      expect(output).toContain("No trust history");
    });

    it("cmdTrust JSON on empty db", () => {
      cli.cmdTrust(emptyDb, "empty-proj", true);
      const json = getJsonOutput() as Record<string, unknown>;
      const agents = json.agents as unknown[];
      expect(agents).toEqual([]);
    });

    it("cmdInbox on empty db", () => {
      cli.cmdInbox(emptyDb, "empty-proj");
      const output = getLogOutput();
      expect(output).toContain("No messages");
    });

    it("cmdProposals on empty db", () => {
      cli.cmdProposals(emptyDb, "empty-proj", "pending");
      const output = getLogOutput();
      expect(output).toContain("No proposals found");
    });

    it("cmdRunning on empty db", () => {
      expect(() => cli.cmdRunning(emptyDb, "empty-proj")).not.toThrow();
    });

    it("cmdTransitions on empty db", () => {
      cli.cmdTransitions(emptyDb);
      const output = getLogOutput();
      expect(output).toContain("No transitions");
    });

    it("cmdErrors on empty db", () => {
      expect(() => cli.cmdErrors(emptyDb)).not.toThrow();
    });

    it("detectAnomalies on empty db", () => {
      const anomalies = cli.detectAnomalies(emptyDb, "empty-proj", 4);
      expect(anomalies).toEqual([]);
    });

    it("cmdWatch JSON on empty db", () => {
      cli.cmdWatch(emptyDb, "empty-proj", false, true);
      const json = getJsonOutput() as Record<string, unknown>;
      expect(json).toHaveProperty("has_changes");
    });
  });
});
