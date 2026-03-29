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
const { setBudget } = await import("../../src/budget.js");
const { listEvents } = await import("../../src/events/store.js");

describe("budget_changed event", () => {
  let db: DatabaseSync;
  const PROJECT = "test-budget-changed";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("emits budget_changed event when project budget is set for the first time", () => {
    setBudget({
      projectId: PROJECT,
      config: { dailyLimitCents: 10000 },
    }, db);

    const events = listEvents(PROJECT, { type: "budget_changed" }, db);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("budget_changed");
    expect(events[0].source).toBe("internal");

    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.oldLimit).toBe(0);
    expect(payload.newLimit).toBe(10000);
    expect(payload.source).toBe("setBudget");
  });

  it("emits budget_changed event when project budget is updated", () => {
    // First set
    setBudget({
      projectId: PROJECT,
      config: { dailyLimitCents: 10000 },
    }, db);

    // Update
    setBudget({
      projectId: PROJECT,
      config: { dailyLimitCents: 20000 },
    }, db);

    const events = listEvents(PROJECT, { type: "budget_changed" }, db);
    expect(events.length).toBe(2);

    // Second event should have old = 10000, new = 20000
    const secondPayload = events[1].payload as Record<string, unknown>;
    expect(secondPayload.oldLimit).toBe(10000);
    expect(secondPayload.newLimit).toBe(20000);
  });

  it("does not emit budget_changed for per-agent budgets", () => {
    setBudget({
      projectId: PROJECT,
      agentId: "worker-1",
      config: { dailyLimitCents: 5000 },
    }, db);

    const events = listEvents(PROJECT, { type: "budget_changed" }, db);
    expect(events.length).toBe(0);
  });

  it("uses dedup key to prevent duplicate events at same timestamp", () => {
    setBudget({
      projectId: PROJECT,
      config: { dailyLimitCents: 10000 },
    }, db);

    const events = listEvents(PROJECT, { type: "budget_changed" }, db);
    expect(events.length).toBe(1);
    expect(events[0].dedupKey).toBeTruthy();
    expect(events[0].dedupKey).toMatch(/^budget-changed:/);
  });
});
