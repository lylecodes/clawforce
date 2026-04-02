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
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

// Mock child_process (used by cmdStatus, cmdHealth, cmdKill for ps/tsc)
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
}));

// Mock diagnostics module if it gets pulled in transitively
vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
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

describe("CLI commands", () => {
  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
    captureStart();
  });

  afterEach(() => {
    captureStop();
    try { db.close(); } catch { /* already closed */ }
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
    it("approves a pending proposal", () => {
      cli.cmdApprove(db, PROJECT_ID, "proposal-0");
      const output = getLogOutput();
      expect(output).toContain("Approved:");

      // Verify DB update
      const proposal = db.prepare("SELECT status FROM proposals WHERE id = 'proposal-0'").get() as { status: string };
      expect(proposal.status).toBe("approved");
    });

    it("creates an approval event", () => {
      cli.cmdApprove(db, PROJECT_ID, "proposal-3");
      const event = db.prepare(
        "SELECT type FROM events WHERE type = 'proposal_approved' ORDER BY created_at DESC LIMIT 1"
      ).get() as { type: string } | undefined;
      expect(event?.type).toBe("proposal_approved");
    });
  });

  // ─── cmdReject ──────────────────────────────────────────────────

  describe("cmdReject", () => {
    it("rejects a pending proposal", () => {
      cli.cmdReject(db, PROJECT_ID, "proposal-0");
      const output = getLogOutput();
      expect(output).toContain("Rejected:");

      const proposal = db.prepare("SELECT status FROM proposals WHERE id = 'proposal-0'").get() as { status: string };
      expect(proposal.status).toBe("rejected");
    });

    it("includes feedback", () => {
      cli.cmdReject(db, PROJECT_ID, "proposal-3", "Not appropriate");
      const output = getLogOutput();
      expect(output).toContain("Feedback: Not appropriate");

      const proposal = db.prepare("SELECT user_feedback FROM proposals WHERE id = 'proposal-3'").get() as { user_feedback: string };
      expect(proposal.user_feedback).toBe("Not appropriate");
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
