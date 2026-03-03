import { describe, expect, it } from "vitest";

const { calculateCostCents } = await import("../src/cost.js");

describe("calculateCostCents — negative token clamping", () => {
  it("returns 0 (not negative) with negative inputTokens", () => {
    const cost = calculateCostCents({
      inputTokens: -1000,
      outputTokens: 0,
    });
    expect(cost).toBe(0);
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("returns 0 with negative outputTokens", () => {
    const cost = calculateCostCents({
      inputTokens: 0,
      outputTokens: -5000,
    });
    expect(cost).toBe(0);
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("returns 0 with negative cacheReadTokens", () => {
    const cost = calculateCostCents({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: -2000,
    });
    expect(cost).toBe(0);
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("returns 0 with all zeros", () => {
    const cost = calculateCostCents({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBe(0);
  });

  it("handles mixed negative and positive — only positive tokens contribute", () => {
    const costWithNegative = calculateCostCents({
      inputTokens: -5000,
      outputTokens: 1_000_000,
      cacheReadTokens: -1000,
      model: "sonnet",
    });

    const costPositiveOnly = calculateCostCents({
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      model: "sonnet",
    });

    // Negative tokens should be clamped to 0, so both costs should match
    expect(costWithNegative).toBe(costPositiveOnly);
    expect(costWithNegative).toBeGreaterThan(0);
  });
});
