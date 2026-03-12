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
