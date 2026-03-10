import { describe, it, expect, beforeEach } from "vitest";
import { shouldDispatch } from "../../src/dispatch/dispatcher.js";
import { updateProviderUsage, clearAllUsage } from "../../src/rate-limits.js";
import { recordCost } from "../../src/cost.js";
import { getDb } from "../../src/db.js";

describe("dispatch gate — budget + rate limits", () => {
  const projectId = "test-dispatch-gate";

  beforeEach(() => {
    clearAllUsage();
    const db = getDb(projectId);
    db.prepare("DELETE FROM budgets WHERE project_id = ?").run(projectId);
  });

  it("blocks dispatch when provider rate limited", () => {
    updateProviderUsage("anthropic", {
      windows: [{ label: "RPM", usedPercent: 98 }],
    });

    const result = shouldDispatch(projectId, "worker", "anthropic");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("rate limit");
  });

  it("allows dispatch when within budget and rate limits", () => {
    updateProviderUsage("anthropic", {
      windows: [{ label: "RPM", usedPercent: 30 }],
    });

    const result = shouldDispatch(projectId, "worker", "anthropic");
    expect(result.ok).toBe(true);
  });

  it("blocks dispatch when multi-window budget exceeded", () => {
    const db = getDb(projectId);
    // Insert agent-specific budget with a tiny hourly limit
    db.prepare(`
      INSERT INTO budgets (id, project_id, agent_id, daily_limit_cents, hourly_limit_cents, daily_spent_cents, daily_reset_at, created_at, updated_at)
      VALUES ('b-gate', ?, 'worker', 100000, 1, 0, ?, ?, ?)
    `).run(projectId, Date.now() + 86400000, Date.now(), Date.now());

    // Record enough cost to exceed the 1-cent hourly limit
    recordCost({ projectId, agentId: "worker", inputTokens: 100000, outputTokens: 50000, model: "claude-opus-4-6" });

    const result = shouldDispatch(projectId, "worker", "anthropic");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("budget exceeded");
  });
});
