import { describe, expect, it } from "vitest";
import { estimateBudget, MODEL_COSTS } from "../../src/config/budget-guide.js";

describe("estimateBudget", () => {
  it("estimates budget for a simple team", () => {
    const result = estimateBudget([
      { agentId: "lead", model: "anthropic/claude-opus-4-6", role: "manager" },
      { agentId: "dev1", model: "anthropic/claude-sonnet-4-6", role: "employee" },
      { agentId: "dev2", model: "anthropic/claude-sonnet-4-6", role: "employee" },
    ]);

    expect(result.recommended).toBeGreaterThan(0);
    expect(result.low).toBeLessThan(result.recommended);
    expect(result.high).toBeGreaterThan(result.recommended);
    expect(result.breakdown).toHaveLength(3);
  });

  it("provides per-agent breakdown", () => {
    const result = estimateBudget([
      { agentId: "mgr", model: "anthropic/claude-opus-4-6", role: "manager" },
      { agentId: "worker", model: "anthropic/claude-sonnet-4-6", role: "employee" },
    ]);

    const mgrBreakdown = result.breakdown.find((b) => b.agentId === "mgr")!;
    expect(mgrBreakdown.sessionsPerDay).toBe(6);
    expect(mgrBreakdown.model).toBe("anthropic/claude-opus-4-6");

    const workerBreakdown = result.breakdown.find((b) => b.agentId === "worker")!;
    expect(workerBreakdown.sessionsPerDay).toBe(4);
  });

  it("falls back to sonnet pricing for unknown models", () => {
    const result = estimateBudget([
      { agentId: "x", model: "custom/unknown-model", role: "employee" },
    ]);

    const sonnetCost = MODEL_COSTS["anthropic/claude-sonnet-4-6"];
    const breakdown = result.breakdown[0];
    expect(breakdown.costPerSession).toBe(sonnetCost);
  });

  it("uses overridden model costs when provided", () => {
    const overrides = { "custom/cheap": 50 };
    const result = estimateBudget(
      [{ agentId: "x", model: "custom/cheap", role: "employee" }],
      overrides,
    );

    expect(result.breakdown[0].costPerSession).toBe(50);
  });

  it("formats budget summary text", async () => {
    const { formatBudgetSummary } = await import("../../src/config/budget-guide.js");
    const result = estimateBudget([
      { agentId: "lead", model: "anthropic/claude-opus-4-6", role: "manager" },
      { agentId: "dev", model: "anthropic/claude-sonnet-4-6", role: "employee" },
    ]);

    const summary = formatBudgetSummary(result);
    expect(summary).toContain("Recommended");
    expect(summary).toContain("lead");
    expect(summary).toContain("dev");
  });
});
