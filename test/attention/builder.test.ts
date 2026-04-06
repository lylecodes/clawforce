/**
 * Tests for the Attention Item Builder.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { buildAttentionSummary } from "../../src/attention/builder.js";

// We use a real in-memory SQLite DB (with full schema) for these tests,
// so we don't have to mock the DB layer. We do mock higher-level functions
// that are expensive or hard to set up (approval resolver, budget-windows, safety).

// Mock: approval/resolve
let _pendingProposals: Array<{ id: string; title: string; description: string | null; proposed_by: string; risk_tier: string | null }> = [];

vi.mock("../../src/approval/resolve.js", () => ({
  listPendingProposals: vi.fn(() => _pendingProposals),
}));

// Mock: budget-windows
let _budgetStatus: Record<string, unknown> = { alerts: [] };

vi.mock("../../src/budget-windows.js", () => ({
  getBudgetStatus: vi.fn(() => _budgetStatus),
}));

// Mock: safety
let _emergencyStop = false;

vi.mock("../../src/safety.js", () => ({
  isEmergencyStopActive: vi.fn(() => _emergencyStop),
}));

// Mock: tasks/ops — only needed for REVIEW state detection
let _reviewTasks: Array<{ id: string; title: string | null; assignedTo: string | null }> = [];

vi.mock("../../src/tasks/ops.js", () => ({
  listTasks: vi.fn((projectId: string, filters?: { state?: string }) => {
    if (filters?.state === "REVIEW") return _reviewTasks;
    return [];
  }),
}));

// Mock: history/store
let _recentChanges: Array<{ id: string; projectId: string; resourceType: string; resourceId: string; action: string; provenance: string; actor: string; before: null; after: null; reversible: boolean; createdAt: number }> = [];

vi.mock("../../src/history/store.js", () => ({
  listRecentChanges: vi.fn(() => _recentChanges),
  ensureHistoryTable: vi.fn(),
}));

// We import getMemoryDb to get a real DB (with schema) to pass to buildAttentionSummary
import { getMemoryDb } from "../../src/db.js";

const PROJECT_ID = "test-project";

function freshDb(): DatabaseSync {
  return getMemoryDb();
}

// Helper to insert a task into the DB
function insertTask(
  db: DatabaseSync,
  opts: { id: string; state: string; title?: string; deadline?: number; updatedAt?: number },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, state, priority, assigned_to, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'P2', NULL, 'test', ?, ?)`,
  ).run(opts.id, PROJECT_ID, opts.title ?? opts.id, opts.state, now, opts.updatedAt ?? now);
  if (opts.deadline !== undefined) {
    db.prepare(
      "UPDATE tasks SET deadline = ? WHERE id = ? AND project_id = ?",
    ).run(opts.deadline, opts.id, PROJECT_ID);
  }
}

// Helper to insert a cost record
function insertCost(db: DatabaseSync, taskId: string, costCents: number): void {
  db.prepare(
    `INSERT INTO cost_records (id, project_id, agent_id, task_id, cost_cents, input_tokens, output_tokens, model, created_at)
     VALUES (?, ?, 'agent1', ?, ?, 0, 0, 'test-model', ?)`,
  ).run(`cost-${Math.random()}`, PROJECT_ID, taskId, costCents, Date.now());
}

// Helper to insert an unread user-addressed message
function insertUnreadMessage(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT INTO messages (id, project_id, from_agent, to_agent, type, priority, content, status, created_at)
     VALUES (?, ?, 'agent1', 'user', 'info', 'NORMAL', 'hello', 'delivered', ?)`,
  ).run(id, PROJECT_ID, Date.now());
}

// Helper to insert a proposal row directly (bypasses the mock for DB-level tests if needed)
// The proposals are detected via listPendingProposals (mocked above), not by DB query.

beforeEach(() => {
  // Reset mocked state
  _pendingProposals = [];
  _budgetStatus = { alerts: [] };
  _emergencyStop = false;
  _reviewTasks = [];
  _recentChanges = [];
});

describe("buildAttentionSummary — empty project", () => {
  it("returns zero items and correct shape", () => {
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);
    expect(summary.projectId).toBe(PROJECT_ID);
    expect(summary.items).toHaveLength(0);
    expect(summary.counts.actionNeeded).toBe(0);
    expect(summary.counts.watching).toBe(0);
    expect(summary.counts.fyi).toBe(0);
    expect(typeof summary.generatedAt).toBe("number");
  });
});

describe("buildAttentionSummary — approvals", () => {
  it("pending approval creates an action-needed item", () => {
    _pendingProposals = [
      { id: "p1", title: "Deploy to prod", description: "Risk: HIGH", proposed_by: "agent1", risk_tier: "HIGH" },
    ];
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const approvalItems = summary.items.filter((i) => i.category === "approval");
    expect(approvalItems).toHaveLength(1);
    expect(approvalItems[0]!.urgency).toBe("action-needed");
    expect(approvalItems[0]!.title).toContain("Deploy to prod");
    expect(approvalItems[0]!.destination).toBe("/approvals");
    expect(approvalItems[0]!.focusContext?.proposalId).toBe("p1");
    expect(summary.counts.actionNeeded).toBe(1);
  });
});

describe("buildAttentionSummary — budget", () => {
  it("budget >90% creates an action-needed item", () => {
    _budgetStatus = {
      alerts: [],
      daily: { window: "daily", limitCents: 1000, spentCents: 950, remainingCents: 50, usedPercent: 95 },
    };
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const budgetItems = summary.items.filter((i) => i.category === "budget");
    expect(budgetItems).toHaveLength(1);
    expect(budgetItems[0]!.urgency).toBe("action-needed");
    expect(budgetItems[0]!.title).toContain("95%");
    expect(budgetItems[0]!.destination).toBe("/config");
    expect(budgetItems[0]!.focusContext?.section).toBe("budget");
  });

  it("budget 70-90% creates a watching item", () => {
    _budgetStatus = {
      alerts: [],
      daily: { window: "daily", limitCents: 1000, spentCents: 800, remainingCents: 200, usedPercent: 80 },
    };
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const budgetItems = summary.items.filter((i) => i.category === "budget");
    expect(budgetItems).toHaveLength(1);
    expect(budgetItems[0]!.urgency).toBe("watching");
    expect(budgetItems[0]!.title).toContain("80%");
    expect(budgetItems[0]!.destination).toBe("/config");
  });

  it("budget below 70% creates no budget item", () => {
    _budgetStatus = {
      alerts: [],
      daily: { window: "daily", limitCents: 1000, spentCents: 500, remainingCents: 500, usedPercent: 50 },
    };
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const budgetItems = summary.items.filter((i) => i.category === "budget");
    expect(budgetItems).toHaveLength(0);
  });

  it("90% threshold maps to action-needed not watching", () => {
    _budgetStatus = {
      alerts: [],
      hourly: { window: "hourly", limitCents: 100, spentCents: 90, remainingCents: 10, usedPercent: 90 },
    };
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const budgetItems = summary.items.filter((i) => i.category === "budget");
    expect(budgetItems).toHaveLength(1);
    expect(budgetItems[0]!.urgency).toBe("action-needed");
  });
});

describe("buildAttentionSummary — failed/cancelled tasks in last 24h", () => {
  it("recently cancelled tasks create watching items", () => {
    const db = freshDb();
    const recentlyFailed = Date.now() - 3_600_000; // 1 hour ago
    insertTask(db, { id: "t1", state: "CANCELLED", title: "Broken task", updatedAt: recentlyFailed });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const taskItems = summary.items.filter(
      (i) => i.category === "task" && i.urgency === "watching",
    );
    expect(taskItems.length).toBeGreaterThanOrEqual(1);
    const failedItem = taskItems.find((i) => i.focusContext?.taskId === "t1");
    expect(failedItem).toBeDefined();
    expect(failedItem!.urgency).toBe("watching");
    expect(failedItem!.destination).toBe("/tasks");
  });

  it("cancelled tasks older than 24h do not create items", () => {
    const db = freshDb();
    const oldFailed = Date.now() - 48 * 3_600_000; // 2 days ago
    insertTask(db, { id: "t2", state: "CANCELLED", title: "Old failure", updatedAt: oldFailed });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const item = summary.items.find((i) => i.focusContext?.taskId === "t2");
    expect(item).toBeUndefined();
  });
});

describe("buildAttentionSummary — completed tasks", () => {
  it("recently completed tasks create fyi items", () => {
    const db = freshDb();
    const recentDone = Date.now() - 3_600_000; // 1 hour ago
    insertTask(db, { id: "t1", state: "DONE", title: "Finished task", updatedAt: recentDone });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const fyiItems = summary.items.filter((i) => i.urgency === "fyi" && i.category === "task");
    expect(fyiItems.length).toBeGreaterThanOrEqual(1);
    expect(fyiItems[0]!.destination).toBe("/tasks");
    expect(fyiItems[0]!.focusContext?.state).toBe("DONE");
  });

  it("completed tasks older than 24h do not create fyi items", () => {
    const db = freshDb();
    const oldDone = Date.now() - 48 * 3_600_000; // 2 days ago
    insertTask(db, { id: "t3", state: "DONE", title: "Old completed task", updatedAt: oldDone });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const fyiItems = summary.items.filter((i) => i.urgency === "fyi" && i.category === "task");
    expect(fyiItems).toHaveLength(0);
  });
});

describe("buildAttentionSummary — emergency stop", () => {
  it("active kill switch creates action-needed item pointing to /ops", () => {
    _emergencyStop = true;
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const healthItems = summary.items.filter((i) => i.category === "health" && i.urgency === "action-needed");
    expect(healthItems).toHaveLength(1);
    expect(healthItems[0]!.destination).toBe("/ops");
    expect(healthItems[0]!.title).toContain("Emergency stop");
  });

  it("no kill switch means no health action-needed item from that detector", () => {
    _emergencyStop = false;
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const killItems = summary.items.filter(
      (i) => i.category === "health" && i.urgency === "action-needed" && i.title.includes("Emergency"),
    );
    expect(killItems).toHaveLength(0);
  });
});

describe("buildAttentionSummary — stale tasks past deadline", () => {
  it("tasks past deadline create action-needed items", () => {
    const db = freshDb();
    const pastDeadline = Date.now() - 2 * 3_600_000; // 2 hours ago
    insertTask(db, { id: "t-overdue", state: "IN_PROGRESS", title: "Late task", deadline: pastDeadline });

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const overdueItems = summary.items.filter(
      (i) => i.category === "task" && i.urgency === "action-needed" && i.focusContext?.taskId === "t-overdue",
    );
    expect(overdueItems).toHaveLength(1);
    expect(overdueItems[0]!.destination).toBe("/tasks");
    expect(overdueItems[0]!.title).toContain("Overdue");
  });
});

describe("buildAttentionSummary — high cost running tasks", () => {
  it("running task with cost >$1 creates watching item", () => {
    const db = freshDb();
    insertTask(db, { id: "t-expensive", state: "IN_PROGRESS", title: "Pricey task" });
    insertCost(db, "t-expensive", 150); // $1.50

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const costItems = summary.items.filter(
      (i) => i.category === "task" && i.urgency === "watching" && i.focusContext?.taskId === "t-expensive",
    );
    expect(costItems).toHaveLength(1);
    expect(costItems[0]!.destination).toBe("/tasks");
    expect(costItems[0]!.title).toContain("High-cost");
  });

  it("running task with cost ≤$1 does not create high-cost item", () => {
    const db = freshDb();
    insertTask(db, { id: "t-cheap", state: "IN_PROGRESS", title: "Cheap task" });
    insertCost(db, "t-cheap", 50); // $0.50

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const costItems = summary.items.filter(
      (i) => i.category === "task" && i.urgency === "watching" && i.focusContext?.taskId === "t-cheap",
    );
    expect(costItems).toHaveLength(0);
  });
});

describe("buildAttentionSummary — unread messages", () => {
  it("unread messages addressed to user create action-needed comms item", () => {
    const db = freshDb();
    insertUnreadMessage(db, "msg-1");
    insertUnreadMessage(db, "msg-2");

    const summary = buildAttentionSummary(PROJECT_ID, db);
    const commsItems = summary.items.filter((i) => i.category === "comms" && i.urgency === "action-needed");
    expect(commsItems).toHaveLength(1);
    expect(commsItems[0]!.destination).toBe("/comms");
    expect(commsItems[0]!.metadata?.count).toBe(2);
  });
});

describe("buildAttentionSummary — REVIEW task detection", () => {
  it("tasks in REVIEW state create action-needed items", () => {
    _reviewTasks = [{ id: "t-review", title: "Needs review", assignedTo: "agent1" }];
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const reviewItems = summary.items.filter(
      (i) => i.category === "task" && i.urgency === "action-needed" && i.focusContext?.taskId === "t-review",
    );
    expect(reviewItems).toHaveLength(1);
    expect(reviewItems[0]!.destination).toBe("/tasks");
    expect(reviewItems[0]!.title).toContain("review");
  });
});

describe("buildAttentionSummary — counts accuracy", () => {
  it("counts match item urgency distribution", () => {
    // action-needed: 1 approval + 1 budget (>90%)
    _pendingProposals = [{ id: "p1", title: "X", description: null, proposed_by: "a", risk_tier: null }];
    _budgetStatus = {
      alerts: [],
      daily: { window: "daily", limitCents: 100, spentCents: 95, remainingCents: 5, usedPercent: 95 },
    };

    const db = freshDb();

    // watching: 1 recently failed task
    const recentlyFailed = Date.now() - 3_600_000;
    insertTask(db, { id: "tf", state: "CANCELLED", title: "Failed", updatedAt: recentlyFailed });

    // fyi: 1 recently completed task
    const recentDone = Date.now() - 3_600_000;
    insertTask(db, { id: "td", state: "DONE", title: "Done", updatedAt: recentDone });

    const summary = buildAttentionSummary(PROJECT_ID, db);

    // Verify counts match actual items
    expect(summary.counts.actionNeeded).toBe(
      summary.items.filter((i) => i.urgency === "action-needed").length,
    );
    expect(summary.counts.watching).toBe(
      summary.items.filter((i) => i.urgency === "watching").length,
    );
    expect(summary.counts.fyi).toBe(
      summary.items.filter((i) => i.urgency === "fyi").length,
    );

    // At minimum: 1 approval + 1 budget action-needed
    expect(summary.counts.actionNeeded).toBeGreaterThanOrEqual(2);
    // At minimum: 1 failed task watching
    expect(summary.counts.watching).toBeGreaterThanOrEqual(1);
    // At minimum: 1 completed task fyi
    expect(summary.counts.fyi).toBeGreaterThanOrEqual(1);
  });
});

describe("buildAttentionSummary — destinations and focusContext", () => {
  it("approval item has correct destination and focusContext", () => {
    _pendingProposals = [{ id: "p99", title: "Risky deploy", description: "desc", proposed_by: "agent", risk_tier: "HIGH" }];
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const ap = summary.items.find((i) => i.category === "approval");
    expect(ap?.destination).toBe("/approvals");
    expect(ap?.focusContext?.proposalId).toBe("p99");
  });

  it("budget item has /config destination and budget section", () => {
    _budgetStatus = {
      alerts: [],
      monthly: { window: "monthly", limitCents: 5000, spentCents: 4600, remainingCents: 400, usedPercent: 92 },
    };
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const bi = summary.items.find((i) => i.category === "budget");
    expect(bi?.destination).toBe("/config");
    expect(bi?.focusContext?.section).toBe("budget");
  });

  it("emergency stop item has /ops destination", () => {
    _emergencyStop = true;
    const db = freshDb();
    const summary = buildAttentionSummary(PROJECT_ID, db);

    const hi = summary.items.find((i) => i.category === "health" && i.urgency === "action-needed");
    expect(hi?.destination).toBe("/ops");
  });
});
