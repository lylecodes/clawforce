import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { getCapacityReport } = await import("../src/capacity.js");
const { updateProviderUsage, clearAllUsage } = await import("../src/rate-limits.js");
const { getDb } = await import("../src/db.js");
const { recordCost } = await import("../src/cost.js");

describe("capacity planner", () => {
  const projectId = "test-capacity";

  beforeEach(() => {
    clearAllUsage();
    const db = getDb(projectId);
    db.prepare("DELETE FROM cost_records WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM budgets WHERE project_id = ?").run(projectId);
  });

  it("returns capacity report with budget and rate limit status", () => {
    const db = getDb(projectId);
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b1', ?, NULL, 2000, 800, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    updateProviderUsage("anthropic", {
      windows: [
        { label: "RPM", usedPercent: 25 },
        { label: "TPM", usedPercent: 40 },
      ],
      plan: "tier-4",
    });

    const report = getCapacityReport(projectId);
    expect(report.budget.daily).toBeDefined();
    expect(report.budget.daily!.remainingCents).toBe(1200);
    expect(report.providers).toHaveLength(1);
    expect(report.providers[0].provider).toBe("anthropic");
    expect(report.throttleRisk).toBe("none");
  });

  it("detects throttle risk when provider approaching limits", () => {
    updateProviderUsage("anthropic", {
      windows: [{ label: "RPM", usedPercent: 88 }],
    });

    const report = getCapacityReport(projectId);
    expect(report.throttleRisk).toBe("warning");
  });

  it("estimates remaining sessions from historical cost", () => {
    const db = getDb(projectId);
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b2', ?, NULL, 2000, 0, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    // Simulate 5 past sessions averaging 100 cents each
    for (let i = 0; i < 5; i++) {
      recordCost({ projectId, agentId: "worker", inputTokens: 50000, outputTokens: 10000, model: "claude-sonnet-4-6", source: "llm_output", sessionKey: `sess-${i}` });
    }

    const report = getCapacityReport(projectId);
    expect(report.estimatedRemainingSessions).toBeGreaterThan(0);
  });
});
