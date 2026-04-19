import { randomUUID } from "node:crypto";
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
const { createGoal, findRootInitiative, getInitiativeSpend } = await import("../../src/goals/ops.js");

/** Insert a task directly into the DB and return its ID. */
function insertTask(db: DatabaseSync, projectId: string, goalId: string): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, state, priority, goal_id, created_by, created_at, updated_at, retry_count, max_retries)
    VALUES (?, ?, 'Test Task', 'OPEN', 'P2', ?, 'test', ?, ?, 0, 3)
  `).run(id, projectId, goalId, now, now);
  return id;
}

/** Insert a cost record for a task. */
function insertCostRecord(db: DatabaseSync, projectId: string, taskId: string, costCents: number, createdAt?: number): void {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO cost_records (id, project_id, agent_id, task_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, source, created_at)
    VALUES (?, ?, 'test-agent', ?, 100, 50, 0, 0, ?, 'dispatch', ?)
  `).run(id, projectId, taskId, costCents, createdAt ?? Date.now());
}

describe("findRootInitiative", () => {
  let db: DatabaseSync;
  const PROJECT = "initiative-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("returns null when goal has no allocation", () => {
    const goal = createGoal({
      projectId: PROJECT,
      title: "No budget goal",
      createdBy: "test",
    }, db);

    const result = findRootInitiative(PROJECT, goal.id, db);
    expect(result).toBeNull();
  });

  it("returns the goal itself when it has allocation", () => {
    const goal = createGoal({
      projectId: PROJECT,
      title: "Funded initiative",
      createdBy: "test",
    }, db);

    // Set allocation directly
    db.prepare("UPDATE goals SET allocation = ? WHERE id = ?").run(5000, goal.id);

    const result = findRootInitiative(PROJECT, goal.id, db);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(goal.id);
    expect(result!.allocation).toBe(5000);
  });

  it("walks up to parent with allocation (3 levels deep)", () => {
    const root = createGoal({
      projectId: PROJECT,
      title: "Root initiative",
      createdBy: "test",
    }, db);
    db.prepare("UPDATE goals SET allocation = ? WHERE id = ?").run(10000, root.id);

    const mid = createGoal({
      projectId: PROJECT,
      title: "Mid-level goal",
      parentGoalId: root.id,
      createdBy: "test",
    }, db);

    const leaf = createGoal({
      projectId: PROJECT,
      title: "Leaf goal",
      parentGoalId: mid.id,
      createdBy: "test",
    }, db);

    const result = findRootInitiative(PROJECT, leaf.id, db);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(root.id);
    expect(result!.allocation).toBe(10000);
  });

  it("returns null when no ancestor has allocation", () => {
    const root = createGoal({
      projectId: PROJECT,
      title: "Root (no budget)",
      createdBy: "test",
    }, db);

    const child = createGoal({
      projectId: PROJECT,
      title: "Child (no budget)",
      parentGoalId: root.id,
      createdBy: "test",
    }, db);

    const result = findRootInitiative(PROJECT, child.id, db);
    expect(result).toBeNull();
  });
});

describe("getInitiativeSpend", () => {
  let db: DatabaseSync;
  const PROJECT = "spend-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("aggregates cost across tasks in goal tree (parent + child goals)", () => {
    const parent = createGoal({
      projectId: PROJECT,
      title: "Parent initiative",
      createdBy: "test",
    }, db);
    db.prepare("UPDATE goals SET allocation = ? WHERE id = ?").run(50000, parent.id);

    const child = createGoal({
      projectId: PROJECT,
      title: "Child goal",
      parentGoalId: parent.id,
      createdBy: "test",
    }, db);

    // Create tasks under both goals
    const task1 = insertTask(db, PROJECT, parent.id);
    const task2 = insertTask(db, PROJECT, child.id);

    // Add cost records for today
    insertCostRecord(db, PROJECT, task1, 100);
    insertCostRecord(db, PROJECT, task1, 200);
    insertCostRecord(db, PROJECT, task2, 150);

    const spend = getInitiativeSpend(PROJECT, parent.id, db);
    expect(spend).toBe(450);
  });

  it("excludes yesterday's costs from spend", () => {
    const goal = createGoal({
      projectId: PROJECT,
      title: "Date filter test",
      createdBy: "test",
    }, db);
    db.prepare("UPDATE goals SET allocation = ? WHERE id = ?").run(50, goal.id);

    const taskId = insertTask(db, PROJECT, goal.id);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);
    insertCostRecord(db, PROJECT, taskId, 300, yesterday.getTime());

    // Today's cost
    insertCostRecord(db, PROJECT, taskId, 100);

    const spend = getInitiativeSpend(PROJECT, goal.id, db);
    expect(spend).toBe(100); // only today's cost
  });

  it("returns 0 when no tasks have cost records", () => {
    const goal = createGoal({
      projectId: PROJECT,
      title: "Empty initiative",
      createdBy: "test",
    }, db);
    db.prepare("UPDATE goals SET allocation = ? WHERE id = ?").run(10000, goal.id);

    // Create a task but no cost records
    insertTask(db, PROJECT, goal.id);

    const spend = getInitiativeSpend(PROJECT, goal.id, db);
    expect(spend).toBe(0);
  });
});
