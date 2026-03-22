import { describe, expect, it } from "vitest";
import {
  getTaskCreationStandards,
  getExecutionStandards,
  getReviewStandards,
  getRejectionStandards,
} from "../../src/context/standards.js";

describe("paradigm standards", () => {
  it("getTaskCreationStandards returns non-empty string", () => {
    const result = getTaskCreationStandards();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("Task Creation Standards");
  });

  it("getExecutionStandards returns non-empty string", () => {
    const result = getExecutionStandards();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("Execution Standards");
  });

  it("getReviewStandards returns non-empty string", () => {
    const result = getReviewStandards();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("Review Standards");
  });

  it("getRejectionStandards returns non-empty string", () => {
    const result = getRejectionStandards();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("Rejection Standards");
  });

  it("execution standards mention no lifecycle management", () => {
    const result = getExecutionStandards();
    expect(result).toContain("No lifecycle management");
  });

  it("review standards mention evidence checking", () => {
    const result = getReviewStandards();
    expect(result).toContain("evidence");
  });

  it("rejection standards mention actionable feedback", () => {
    const result = getRejectionStandards();
    expect(result).toContain("Actionable");
  });
});
