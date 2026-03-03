import { describe, expect, it } from "vitest";
import { validateEvidence } from "../../src/tasks/evidence-schema.js";

describe("validateEvidence", () => {
  it("valid output evidence with all metadata", () => {
    const result = validateEvidence("output", "some output content", {
      exitCode: 0,
      durationMs: 1500,
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("valid test_result evidence with all metadata", () => {
    const result = validateEvidence("test_result", "test output", {
      passed: 10,
      failed: 0,
      total: 10,
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("valid diff evidence with all metadata", () => {
    const result = validateEvidence("diff", "--- a/file\n+++ b/file", {
      files: 3,
      linesAdded: 20,
      linesRemoved: 5,
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns on empty content", () => {
    const result = validateEvidence("output", "", { exitCode: 0 });
    expect(result.valid).toBe(false);
    expect(result.warnings).toContain("Evidence content is empty");
  });

  it("warns on whitespace-only content", () => {
    const result = validateEvidence("output", "   \n  ");
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes("empty"))).toBe(true);
  });

  it("warns on content exceeding 1MB", () => {
    const largeContent = "x".repeat(1_100_000);
    const result = validateEvidence("output", largeContent, { exitCode: 0, durationMs: 100 });
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes("1MB"))).toBe(true);
  });

  it("warns on missing recommended metadata for test_result", () => {
    const result = validateEvidence("test_result", "test output", {
      passed: 10,
      // missing: failed, total
    });
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes("failed") && w.includes("total"))).toBe(true);
  });

  it("warns on no metadata for test_result", () => {
    const result = validateEvidence("test_result", "test output");
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes("no metadata"))).toBe(true);
  });

  it("warns on missing recommended metadata for diff", () => {
    const result = validateEvidence("diff", "diff content", { files: 1 });
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes("linesAdded"))).toBe(true);
  });

  it("warns on missing recommended metadata for output", () => {
    const result = validateEvidence("output", "stdout content", {});
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes("exitCode"))).toBe(true);
  });

  it("no type-specific warnings for unknown evidence types", () => {
    const result = validateEvidence("log" as any, "log content");
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("multiple warnings can be returned", () => {
    const result = validateEvidence("test_result", "");
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });
});
