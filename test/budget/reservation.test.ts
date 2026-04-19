import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "../../src/sqlite-driver.js";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "key",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");

describe("budget reservations", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
    // Insert a project-level budget row
    const now = Date.now();
    const future = now + 86400000;
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents,
        daily_reset_at, reserved_cents, reserved_tokens, reserved_requests, created_at, updated_at)
      VALUES ('b1', 'p1', NULL, 10000, 0, ?, 0, 0, 0, ?, ?)
    `).run(future, now, now);
  });

  it("reserveBudget increments all reservation counters", async () => {
    const { reserveBudget } = await import("../../src/budget/reservation.js");

    reserveBudget("p1", 500, 100000, 3, db);

    const row = db.prepare("SELECT reserved_cents, reserved_tokens, reserved_requests FROM budgets WHERE id = 'b1'").get() as Record<string, number>;
    expect(row.reserved_cents).toBe(500);
    expect(row.reserved_tokens).toBe(100000);
    expect(row.reserved_requests).toBe(3);
  });

  it("reserveBudget accumulates across multiple reservations", async () => {
    const { reserveBudget } = await import("../../src/budget/reservation.js");

    reserveBudget("p1", 200, 50000, 2, db);
    reserveBudget("p1", 300, 75000, 1, db);

    const row = db.prepare("SELECT reserved_cents, reserved_tokens, reserved_requests FROM budgets WHERE id = 'b1'").get() as Record<string, number>;
    expect(row.reserved_cents).toBe(500);
    expect(row.reserved_tokens).toBe(125000);
    expect(row.reserved_requests).toBe(3);
  });

  it("settlePlanItem decrements reservation", async () => {
    const { reserveBudget, settlePlanItem } = await import("../../src/budget/reservation.js");

    reserveBudget("p1", 500, 100000, 3, db);
    settlePlanItem("p1", 200, 40000, 1, db);

    const row = db.prepare("SELECT reserved_cents, reserved_tokens, reserved_requests FROM budgets WHERE id = 'b1'").get() as Record<string, number>;
    expect(row.reserved_cents).toBe(300);
    expect(row.reserved_tokens).toBe(60000);
    expect(row.reserved_requests).toBe(2);
  });

  it("settlePlanItem clamps to zero (never goes negative)", async () => {
    const { reserveBudget, settlePlanItem } = await import("../../src/budget/reservation.js");

    reserveBudget("p1", 100, 50000, 1, db);
    // Settle more than reserved
    settlePlanItem("p1", 200, 80000, 3, db);

    const row = db.prepare("SELECT reserved_cents, reserved_tokens, reserved_requests FROM budgets WHERE id = 'b1'").get() as Record<string, number>;
    expect(row.reserved_cents).toBe(0);
    expect(row.reserved_tokens).toBe(0);
    expect(row.reserved_requests).toBe(0);
  });

  it("releasePlanReservation releases remaining budget", async () => {
    const { reserveBudget, releasePlanReservation } = await import("../../src/budget/reservation.js");

    reserveBudget("p1", 500, 100000, 5, db);
    releasePlanReservation("p1", 500, 100000, 5, db);

    const row = db.prepare("SELECT reserved_cents, reserved_tokens, reserved_requests FROM budgets WHERE id = 'b1'").get() as Record<string, number>;
    expect(row.reserved_cents).toBe(0);
    expect(row.reserved_tokens).toBe(0);
    expect(row.reserved_requests).toBe(0);
  });

  it("cleanupStaleReservations force-abandons old executing plans", async () => {
    const { reserveBudget, cleanupStaleReservations } = await import("../../src/budget/reservation.js");

    // Reserve budget
    reserveBudget("p1", 500, 100000, 3, db);

    // Create a plan that started 5 hours ago (stale)
    const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
    db.prepare(`
      INSERT INTO dispatch_plans (id, project_id, agent_id, status, planned_items, estimated_cost_cents, started_at, created_at)
      VALUES ('plan1', 'p1', 'agent1', 'executing', ?, 500, ?, ?)
    `).run(
      JSON.stringify([
        { agentId: "a", taskTitle: "T1", estimatedCostCents: 300, estimatedTokens: 60000, confidence: "high" },
        { agentId: "b", taskTitle: "T2", estimatedCostCents: 200, estimatedTokens: 40000, confidence: "medium" },
        { agentId: "c", taskTitle: "T3", estimatedCostCents: 0, confidence: "low" },
      ]),
      fiveHoursAgo,
      fiveHoursAgo,
    );

    // Cleanup with 4h TTL
    const cleaned = cleanupStaleReservations("p1", 4 * 60 * 60 * 1000, db);

    expect(cleaned).toBe(1);

    // Plan should be abandoned
    const plan = db.prepare("SELECT status FROM dispatch_plans WHERE id = 'plan1'").get() as Record<string, string>;
    expect(plan.status).toBe("abandoned");

    // Reservations should be released
    const row = db.prepare("SELECT reserved_cents, reserved_tokens, reserved_requests FROM budgets WHERE id = 'b1'").get() as Record<string, number>;
    expect(row.reserved_cents).toBe(0);
    expect(row.reserved_tokens).toBe(0);
    expect(row.reserved_requests).toBe(0);
  });

  it("cleanupStaleReservations ignores plans within TTL", async () => {
    const { reserveBudget, cleanupStaleReservations } = await import("../../src/budget/reservation.js");

    reserveBudget("p1", 500, 100000, 3, db);

    // Create a plan that started 1 hour ago (not stale with 4h TTL)
    const oneHourAgo = Date.now() - 1 * 60 * 60 * 1000;
    db.prepare(`
      INSERT INTO dispatch_plans (id, project_id, agent_id, status, planned_items, estimated_cost_cents, started_at, created_at)
      VALUES ('plan1', 'p1', 'agent1', 'executing', '[]', 500, ?, ?)
    `).run(oneHourAgo, oneHourAgo);

    const cleaned = cleanupStaleReservations("p1", 4 * 60 * 60 * 1000, db);

    expect(cleaned).toBe(0);

    // Plan should still be executing
    const plan = db.prepare("SELECT status FROM dispatch_plans WHERE id = 'plan1'").get() as Record<string, string>;
    expect(plan.status).toBe("executing");

    // Reservations should be untouched
    const row = db.prepare("SELECT reserved_cents FROM budgets WHERE id = 'b1'").get() as Record<string, number>;
    expect(row.reserved_cents).toBe(500);
  });
});
