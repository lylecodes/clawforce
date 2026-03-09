import { describe, it, expect } from "vitest";
import { parseBudgetShorthand } from "../src/budget-parser.js";

describe("budget parser", () => {
  it("parses $20/day", () => {
    const result = parseBudgetShorthand("$20/day");
    expect(result).toEqual({ dailyLimitCents: 2000 });
  });

  it("parses $5/hour", () => {
    const result = parseBudgetShorthand("$5/hour");
    expect(result).toEqual({ hourlyLimitCents: 500 });
  });

  it("parses $500/month", () => {
    const result = parseBudgetShorthand("$500/month");
    expect(result).toEqual({ monthlyLimitCents: 50000 });
  });

  it("parses $20/day with cents", () => {
    const result = parseBudgetShorthand("$20.50/day");
    expect(result).toEqual({ dailyLimitCents: 2050 });
  });

  it("returns null for invalid format", () => {
    expect(parseBudgetShorthand("twenty bucks")).toBeNull();
    expect(parseBudgetShorthand("")).toBeNull();
  });

  it("parses numeric-only as daily cents", () => {
    const result = parseBudgetShorthand("2000");
    expect(result).toEqual({ dailyLimitCents: 2000 });
  });
});
