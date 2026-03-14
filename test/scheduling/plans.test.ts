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

const { getMemoryDb } = await import("../../src/db.js");

describe("dispatch plan CRUD", () => {
  let db: DatabaseSync;
  const PROJECT = "plan-test";
  const AGENT = "eng-lead";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("creates a plan with planned items and estimated cost", async () => {
    const { createPlan, getPlan } = await import("../../src/scheduling/plans.js");

    const plan = createPlan({
      projectId: PROJECT,
      agentId: AGENT,
      plannedItems: [
        { agentId: "frontend", taskTitle: "Fix nav", estimatedCostCents: 210, confidence: "high" as const },
        { agentId: "backend", taskTitle: "API endpoint", estimatedCostCents: 150, confidence: "medium" as const },
      ],
    }, db);

    expect(plan.status).toBe("planned");
    expect(plan.estimatedCostCents).toBe(360);
    expect(plan.plannedItems).toHaveLength(2);

    const fetched = getPlan(PROJECT, plan.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched!.plannedItems).toHaveLength(2);
  });

  it("transitions plan from planned → executing → completed", async () => {
    const { createPlan, startPlan, completePlan, getPlan } = await import("../../src/scheduling/plans.js");

    const plan = createPlan({
      projectId: PROJECT,
      agentId: AGENT,
      plannedItems: [
        { agentId: "frontend", taskTitle: "Fix nav", estimatedCostCents: 200, confidence: "high" as const },
      ],
    }, db);

    startPlan(PROJECT, plan.id, db);
    const executing = getPlan(PROJECT, plan.id, db);
    expect(executing!.status).toBe("executing");

    completePlan(PROJECT, plan.id, {
      actualResults: [
        { plannedIndex: 0, taskId: "task-123", actualCostCents: 180, status: "dispatched" as const },
      ],
    }, db);
    const completed = getPlan(PROJECT, plan.id, db);
    expect(completed!.status).toBe("completed");
    expect(completed!.actualCostCents).toBe(180);
    expect(completed!.completedAt).toBeGreaterThan(0);
  });

  it("abandons a plan", async () => {
    const { createPlan, abandonPlan, getPlan } = await import("../../src/scheduling/plans.js");

    const plan = createPlan({
      projectId: PROJECT,
      agentId: AGENT,
      plannedItems: [
        { agentId: "frontend", taskTitle: "Cancelled work", estimatedCostCents: 100, confidence: "low" as const },
      ],
    }, db);

    abandonPlan(PROJECT, plan.id, db);
    const abandoned = getPlan(PROJECT, plan.id, db);
    expect(abandoned!.status).toBe("abandoned");
  });

  it("lists plans for an agent, most recent first", async () => {
    const { createPlan, listPlans } = await import("../../src/scheduling/plans.js");

    createPlan({ projectId: PROJECT, agentId: AGENT, plannedItems: [{ agentId: "a", taskTitle: "T1", estimatedCostCents: 100, confidence: "low" as const }] }, db);
    createPlan({ projectId: PROJECT, agentId: AGENT, plannedItems: [{ agentId: "a", taskTitle: "T2", estimatedCostCents: 200, confidence: "low" as const }] }, db);
    createPlan({ projectId: PROJECT, agentId: "other-agent", plannedItems: [{ agentId: "a", taskTitle: "T3", estimatedCostCents: 300, confidence: "low" as const }] }, db);

    const plans = listPlans(PROJECT, AGENT, db);
    expect(plans).toHaveLength(2);
    expect(plans[0].plannedItems[0].taskTitle).toBe("T2"); // most recent first
  });
});

describe("pre-flight plan validation and reservations", () => {
  let db: DatabaseSync;
  const PROJECT = "budget-plan-test";
  const AGENT = "eng-lead";

  function insertBudget(dailyLimitCents: number, dailySpentCents = 0, reservedCents = 0) {
    const now = Date.now();
    const future = now + 86400000;
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents,
        daily_reset_at, reserved_cents, reserved_tokens, reserved_requests, created_at, updated_at)
      VALUES ('budget1', ?, NULL, ?, ?, ?, ?, 0, 0, ?, ?)
    `).run(PROJECT, dailyLimitCents, dailySpentCents, future, reservedCents, now, now);
  }

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("validatePlanBudget passes when plan fits within budget", async () => {
    const { validatePlanBudget } = await import("../../src/scheduling/plans.js");
    insertBudget(10000, 2000);

    const result = validatePlanBudget(
      { estimatedCostCents: 3000 },
      PROJECT,
      db,
    );
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(8000);
  });

  it("validatePlanBudget blocks when plan exceeds remaining budget", async () => {
    const { validatePlanBudget } = await import("../../src/scheduling/plans.js");
    insertBudget(10000, 8000);

    const result = validatePlanBudget(
      { estimatedCostCents: 5000 },
      PROJECT,
      db,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("exceeds remaining daily budget");
  });

  it("validatePlanBudget accounts for existing reservations", async () => {
    const { validatePlanBudget } = await import("../../src/scheduling/plans.js");
    insertBudget(10000, 2000, 5000);

    // remaining = 10000 - 2000 - 5000 = 3000
    const result = validatePlanBudget(
      { estimatedCostCents: 4000 },
      PROJECT,
      db,
    );
    expect(result.ok).toBe(false);
    expect(result.remaining).toBe(3000);
  });

  it("validatePlanBudget passes when no budget configured", async () => {
    const { validatePlanBudget } = await import("../../src/scheduling/plans.js");
    // No budget inserted
    const result = validatePlanBudget(
      { estimatedCostCents: 99999 },
      PROJECT,
      db,
    );
    expect(result.ok).toBe(true);
  });

  it("startPlan validates budget and reserves on success", async () => {
    const { createPlan, startPlan, getPlan } = await import("../../src/scheduling/plans.js");
    insertBudget(10000);

    const plan = createPlan({
      projectId: PROJECT,
      agentId: AGENT,
      plannedItems: [
        { agentId: "worker", taskTitle: "Build feature", estimatedCostCents: 500, estimatedTokens: 50000, confidence: "high" as const },
        { agentId: "worker", taskTitle: "Write tests", estimatedCostCents: 300, estimatedTokens: 30000, confidence: "medium" as const },
      ],
    }, db);

    const result = startPlan(PROJECT, plan.id, db);
    expect(result.ok).toBe(true);

    // Plan should be executing
    const executing = getPlan(PROJECT, plan.id, db);
    expect(executing!.status).toBe("executing");

    // started_at should be set
    const row = db.prepare("SELECT started_at FROM dispatch_plans WHERE id = ?").get(plan.id) as Record<string, number | null>;
    expect(row.started_at).toBeGreaterThan(0);

    // Budget should have reservation
    const budget = db.prepare("SELECT reserved_cents, reserved_tokens, reserved_requests FROM budgets WHERE id = 'budget1'").get() as Record<string, number>;
    expect(budget.reserved_cents).toBe(800); // 500 + 300
    expect(budget.reserved_tokens).toBe(80000); // 50000 + 30000
    expect(budget.reserved_requests).toBe(2);
  });

  it("startPlan blocks when budget insufficient", async () => {
    const { createPlan, startPlan, getPlan } = await import("../../src/scheduling/plans.js");
    insertBudget(500, 200);

    const plan = createPlan({
      projectId: PROJECT,
      agentId: AGENT,
      plannedItems: [
        { agentId: "worker", taskTitle: "Big job", estimatedCostCents: 400, confidence: "high" as const },
      ],
    }, db);

    const result = startPlan(PROJECT, plan.id, db);
    expect(result.ok).toBe(false);

    // Plan should remain in planned state
    const stillPlanned = getPlan(PROJECT, plan.id, db);
    expect(stillPlanned!.status).toBe("planned");

    // No reservation should be created
    const budget = db.prepare("SELECT reserved_cents FROM budgets WHERE id = 'budget1'").get() as Record<string, number>;
    expect(budget.reserved_cents).toBe(0);
  });

  it("completePlan releases reservation", async () => {
    const { createPlan, startPlan, completePlan } = await import("../../src/scheduling/plans.js");
    insertBudget(10000);

    const plan = createPlan({
      projectId: PROJECT,
      agentId: AGENT,
      plannedItems: [
        { agentId: "worker", taskTitle: "Task", estimatedCostCents: 500, estimatedTokens: 40000, confidence: "high" as const },
      ],
    }, db);

    startPlan(PROJECT, plan.id, db);

    // Verify reservation exists
    let budget = db.prepare("SELECT reserved_cents, reserved_tokens, reserved_requests FROM budgets WHERE id = 'budget1'").get() as Record<string, number>;
    expect(budget.reserved_cents).toBe(500);

    completePlan(PROJECT, plan.id, {
      actualResults: [
        { plannedIndex: 0, taskId: "task-1", actualCostCents: 450, status: "dispatched" as const },
      ],
    }, db);

    // Reservation should be released
    budget = db.prepare("SELECT reserved_cents, reserved_tokens, reserved_requests FROM budgets WHERE id = 'budget1'").get() as Record<string, number>;
    expect(budget.reserved_cents).toBe(0);
    expect(budget.reserved_tokens).toBe(0);
    expect(budget.reserved_requests).toBe(0);
  });

  it("abandonPlan releases reservation", async () => {
    const { createPlan, startPlan, abandonPlan } = await import("../../src/scheduling/plans.js");
    insertBudget(10000);

    const plan = createPlan({
      projectId: PROJECT,
      agentId: AGENT,
      plannedItems: [
        { agentId: "worker", taskTitle: "Cancelled", estimatedCostCents: 300, confidence: "low" as const },
      ],
    }, db);

    startPlan(PROJECT, plan.id, db);

    // Verify reservation exists
    let budget = db.prepare("SELECT reserved_cents FROM budgets WHERE id = 'budget1'").get() as Record<string, number>;
    expect(budget.reserved_cents).toBe(300);

    abandonPlan(PROJECT, plan.id, db);

    // Reservation should be released
    budget = db.prepare("SELECT reserved_cents, reserved_tokens, reserved_requests FROM budgets WHERE id = 'budget1'").get() as Record<string, number>;
    expect(budget.reserved_cents).toBe(0);
    expect(budget.reserved_requests).toBe(0);
  });

  it("abandonPlan from planned state does not touch reservations", async () => {
    const { createPlan, abandonPlan } = await import("../../src/scheduling/plans.js");
    insertBudget(10000);

    const plan = createPlan({
      projectId: PROJECT,
      agentId: AGENT,
      plannedItems: [
        { agentId: "worker", taskTitle: "Never started", estimatedCostCents: 200, confidence: "low" as const },
      ],
    }, db);

    // Abandon without starting (no reservation was made)
    abandonPlan(PROJECT, plan.id, db);

    const budget = db.prepare("SELECT reserved_cents FROM budgets WHERE id = 'budget1'").get() as Record<string, number>;
    expect(budget.reserved_cents).toBe(0);
  });
});
