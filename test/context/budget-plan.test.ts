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
const { resolveBudgetPlanSource } = await import("../../src/context/sources/budget-plan.js");
const { setBudget } = await import("../../src/budget.js");
const { createTask } = await import("../../src/tasks/ops.js");

describe("budget_plan briefing source", () => {
  let db: DatabaseSync;
  const PROJECT = "test-budget-plan";

  beforeEach(() => {
    db = getMemoryDb();

    // Set up a project budget
    setBudget({
      projectId: PROJECT,
      config: { dailyLimitCents: 10000 },
    }, db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("returns null when no budget is configured", () => {
    const dbNoBudget = getMemoryDb();
    const result = resolveBudgetPlanSource("no-budget-project", dbNoBudget);
    expect(result).toBeNull();
    dbNoBudget.close();
  });

  it("returns markdown with daily budget info", () => {
    const result = resolveBudgetPlanSource(PROJECT, db);
    expect(result).not.toBeNull();
    expect(result).toContain("## Budget Plan");
    expect(result).toContain("$100.00"); // daily budget
    expect(result).toContain("Remaining");
  });

  it("includes reserve calculation", () => {
    const result = resolveBudgetPlanSource(PROJECT, db);
    expect(result).not.toBeNull();
    expect(result).toContain("Reserve:");
  });

  it("includes worker session capacity estimate", () => {
    const result = resolveBudgetPlanSource(PROJECT, db);
    expect(result).not.toBeNull();
    expect(result).toContain("worker sessions remaining");
  });

  it("includes pipeline status with task counts", () => {
    // Create some tasks in different states
    createTask({
      projectId: PROJECT,
      title: "Open task 1",
      description: "Acceptance criteria: test",
      createdBy: "test",
    }, db);
    createTask({
      projectId: PROJECT,
      title: "Open task 2",
      description: "Acceptance criteria: test",
      createdBy: "test",
    }, db);

    const result = resolveBudgetPlanSource(PROJECT, db);
    expect(result).not.toBeNull();
    expect(result).toContain("Pipeline Status");
    expect(result).toContain("OPEN:");
    expect(result).toContain("ASSIGNED:");
    expect(result).toContain("IN_PROGRESS:");
    expect(result).toContain("REVIEW:");
  });

  it("includes recommendation string from BudgetPacer", () => {
    const result = resolveBudgetPlanSource(PROJECT, db);
    expect(result).not.toBeNull();
    expect(result).toContain("Recommendation:");
  });

  it("includes dispatch status", () => {
    const result = resolveBudgetPlanSource(PROJECT, db);
    expect(result).not.toBeNull();
    expect(result).toContain("Worker dispatch:");
    expect(result).toContain("Lead dispatch:");
  });

  it("returns null for empty projectId", () => {
    const result = resolveBudgetPlanSource("", db);
    expect(result).toBeNull();
  });
});
