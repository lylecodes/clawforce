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
const { createGoal, getGoal, updateGoal } = await import("../../src/goals/ops.js");

describe("goal priority", () => {
  let db: DatabaseSync;
  const PROJECT = "priority-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("creates a goal with priority", () => {
    const goal = createGoal({
      projectId: PROJECT,
      title: "Urgent fix",
      createdBy: "test",
      priority: "P0",
    }, db);

    expect(goal.priority).toBe("P0");

    const fetched = getGoal(PROJECT, goal.id, db);
    expect(fetched!.priority).toBe("P0");
  });

  it("defaults to no priority when not specified", () => {
    const goal = createGoal({
      projectId: PROJECT,
      title: "Normal goal",
      createdBy: "test",
    }, db);

    expect(goal.priority).toBeUndefined();
  });

  it("updates priority on existing goal", () => {
    const goal = createGoal({
      projectId: PROJECT,
      title: "Reprioritize me",
      createdBy: "test",
    }, db);

    const updated = updateGoal(PROJECT, goal.id, { priority: "P1" }, db);
    expect(updated.priority).toBe("P1");
  });
});
