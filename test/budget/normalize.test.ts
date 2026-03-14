import { describe, expect, it } from "vitest";
import { normalizeBudgetConfig } from "../../src/budget/normalize.js";
import type { BudgetConfigV2 } from "../../src/types.js";

describe("normalizeBudgetConfig", () => {
  it("passes through v2 config unchanged", () => {
    const v2: BudgetConfigV2 = { daily: { cents: 5000, tokens: 2000000 } };
    expect(normalizeBudgetConfig(v2)).toEqual(v2);
  });

  it("converts legacy flat config to v2", () => {
    const legacy = { dailyLimitCents: 5000, hourlyLimitCents: 1000, sessionLimitCents: 500 };
    const result = normalizeBudgetConfig(legacy);
    expect(result.daily?.cents).toBe(5000);
    expect(result.hourly?.cents).toBe(1000);
    expect(result.session?.cents).toBe(500);
  });

  it("handles mixed legacy fields", () => {
    const legacy = { dailyLimitCents: 3000, monthlyLimitCents: 50000, taskLimitCents: 200 };
    const result = normalizeBudgetConfig(legacy);
    expect(result.daily?.cents).toBe(3000);
    expect(result.monthly?.cents).toBe(50000);
    expect(result.task?.cents).toBe(200);
  });

  it("returns empty config for undefined input", () => {
    expect(normalizeBudgetConfig(undefined)).toEqual({});
  });
});
