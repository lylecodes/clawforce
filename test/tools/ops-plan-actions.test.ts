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
const { createPlan, getPlan } = await import("../../src/scheduling/plans.js");

describe("ops-tool plan actions", () => {
  let db: DatabaseSync;
  const PROJECT = "ops-plan-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("creates a plan via createPlan and retrieves it", () => {
    const plan = createPlan({
      projectId: PROJECT,
      agentId: "eng-lead",
      plannedItems: [
        { agentId: "frontend", taskTitle: "Fix nav", estimatedCostCents: 200, confidence: "high" as const },
      ],
    }, db);

    const fetched = getPlan(PROJECT, plan.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("planned");
    expect(fetched!.estimatedCostCents).toBe(200);
  });
});
