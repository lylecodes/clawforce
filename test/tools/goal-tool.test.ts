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
const dbModule = await import("../../src/db.js");
const { createClawforceGoalTool } = await import("../../src/tools/goal-tool.js");

describe("tools/goal-tool", () => {
  let db: DatabaseSync;
  const PROJECT = "goal-tool-test";

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { db.close(); } catch { /* already closed */ }
  });

  async function execute(params: Record<string, unknown>) {
    const tool = createClawforceGoalTool({ agentSessionKey: "test-session", projectId: PROJECT });
    const result = await tool.execute("call-1", params);
    return JSON.parse(result.content[0]!.text);
  }

  it("create action creates a goal", async () => {
    const result = await execute({
      action: "create",
      title: "Ship v2.0",
      description: "Release version 2",
      acceptance_criteria: "All tests pass",
    });

    expect(result.ok).toBe(true);
    expect(result.goal.title).toBe("Ship v2.0");
    expect(result.goal.status).toBe("active");
  });

  it("decompose action creates children", async () => {
    const created = await execute({ action: "create", title: "Parent Goal" });
    const goalId = created.goal.id;

    const result = await execute({
      action: "decompose",
      goal_id: goalId,
      sub_goals: [
        { title: "Sub-goal 1", department: "engineering" },
        { title: "Sub-goal 2", department: "design" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.children).toHaveLength(2);
    expect(result.children[0].parentGoalId).toBe(goalId);
  });

  it("status action returns progress", async () => {
    const created = await execute({ action: "create", title: "Root" });
    const rootId = created.goal.id;

    // Add children
    await execute({
      action: "decompose",
      goal_id: rootId,
      sub_goals: [
        { title: "Child 1" },
        { title: "Child 2" },
      ],
    });

    const result = await execute({ action: "status", goal_id: rootId });

    expect(result.ok).toBe(true);
    expect(result.progress.childGoals.total).toBe(2);
    expect(result.childGoals).toHaveLength(2);
  });

  it("achieve action achieves goal", async () => {
    const created = await execute({ action: "create", title: "Goal" });

    const result = await execute({ action: "achieve", goal_id: created.goal.id });

    expect(result.ok).toBe(true);
    expect(result.goal.status).toBe("achieved");
  });

  it("abandon action abandons goal with reason", async () => {
    const created = await execute({ action: "create", title: "Goal" });

    const result = await execute({
      action: "abandon",
      goal_id: created.goal.id,
      reason: "Priorities changed",
    });

    expect(result.ok).toBe(true);
    expect(result.goal.status).toBe("abandoned");
  });

  it("list action returns goals with filters", async () => {
    await execute({ action: "create", title: "Goal 1", department: "eng" });
    await execute({ action: "create", title: "Goal 2", department: "design" });

    const result = await execute({ action: "list", department: "eng" });

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.goals[0].title).toBe("Goal 1");
  });

  it("get action returns goal detail", async () => {
    const created = await execute({ action: "create", title: "Detail Goal" });

    const result = await execute({ action: "get", goal_id: created.goal.id });

    expect(result.ok).toBe(true);
    expect(result.goal.title).toBe("Detail Goal");
    expect(result.childGoals).toHaveLength(0);
    expect(result.tasks).toHaveLength(0);
  });

  it("invalid action returns error", async () => {
    const result = await execute({ action: "invalid_action" });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Unknown action");
  });

  it("create — sets allocation on goal", async () => {
    const result = await execute({
      action: "create",
      title: "UI Improvements",
      description: "Dashboard UX",
      allocation: 40,
    });
    expect(result.ok).toBe(true);
    expect(result.goal.allocation).toBe(40);
  });

  it("create — rejects allocation > 100", async () => {
    const result = await execute({
      action: "create",
      title: "Too much",
      allocation: 150,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("0-100");
  });

  it("create — rejects allocation < 0", async () => {
    const result = await execute({
      action: "create",
      title: "Negative",
      allocation: -5,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("0-100");
  });

  it("status — shows budget info when goal has allocation", async () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO goals (id, project_id, title, status, created_by, created_at, allocation)
      VALUES ('init-status', '${PROJECT}', 'UI Work', 'active', 'agent', ${now}, 40)
    `).run();

    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b-status', '${PROJECT}', NULL, 1000, 0, ${now + 86400000}, ${now}, ${now})
    `).run();

    const result = await execute({ action: "status", goal_id: "init-status" });
    expect(result.ok).toBe(true);
    expect(result.budget).toBeDefined();
    expect(result.budget.allocationPercent).toBe(40);
    expect(result.budget.allocationCents).toBe(400);
  });
});
