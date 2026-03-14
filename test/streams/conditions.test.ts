import { describe, expect, it } from "vitest";
import { evaluateCondition } from "../../src/streams/conditions.js";

describe("condition evaluation", () => {
  it("evaluates simple comparison", () => {
    expect(evaluateCondition("value < 10", { value: 5 })).toBe(true);
    expect(evaluateCondition("value < 10", { value: 15 })).toBe(false);
  });

  it("evaluates equality", () => {
    expect(evaluateCondition('status == "OPEN"', { status: "OPEN" })).toBe(true);
    expect(evaluateCondition('status == "DONE"', { status: "OPEN" })).toBe(false);
  });

  it("evaluates boolean operators", () => {
    expect(evaluateCondition("a > 0 and b > 0", { a: 1, b: 2 })).toBe(true);
    expect(evaluateCondition("a > 0 and b > 0", { a: 1, b: -1 })).toBe(false);
    expect(evaluateCondition("a > 0 or b > 0", { a: -1, b: 2 })).toBe(true);
  });

  it("evaluates arithmetic", () => {
    expect(evaluateCondition("a + b > 10", { a: 5, b: 7 })).toBe(true);
  });

  it("returns false for invalid expressions", () => {
    expect(evaluateCondition("", { a: 1 })).toBe(false);
  });

  it("handles missing variables gracefully", () => {
    // filtrex returns 0 for missing vars by default
    expect(evaluateCondition("missing > 5", {})).toBe(false);
  });
});
