import { afterEach, describe, expect, it } from "vitest";
import {
  getSession,
  recordSignificantResult,
  resetTrackerForTest,
  startTracking,
} from "../../src/enforcement/tracker.js";
import type { AgentConfig } from "../../src/types.js";

const workerConfig: AgentConfig = {
  extends: "employee",
  briefing: [{ source: "instructions" }],
  expectations: [],
  performance_policy: { action: "alert" },
};

describe("significantResults buffer", () => {
  afterEach(() => {
    resetTrackerForTest();
  });

  it("initializes with an empty significantResults array", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);
    const session = getSession("sess1");
    expect(session).not.toBeNull();
    expect(session!.metrics.significantResults).toEqual([]);
  });

  it("records a significant result", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);
    recordSignificantResult("sess1", "Bash", null, "Hello world output from bash");
    const session = getSession("sess1");
    expect(session!.metrics.significantResults).toHaveLength(1);
    expect(session!.metrics.significantResults[0]!.toolName).toBe("Bash");
    expect(session!.metrics.significantResults[0]!.action).toBeNull();
    expect(session!.metrics.significantResults[0]!.resultPreview).toBe("Hello world output from bash");
  });

  it("records result with action", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);
    recordSignificantResult("sess1", "Edit", "replace", "some diff output");
    const session = getSession("sess1");
    expect(session!.metrics.significantResults[0]!.action).toBe("replace");
  });

  it("caps at 5 results (MAX_RESULTS)", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);
    for (let i = 0; i < 10; i++) {
      recordSignificantResult("sess1", "Bash", null, `Result ${i}`);
    }
    const session = getSession("sess1");
    expect(session!.metrics.significantResults).toHaveLength(5);
    // First 5 should be kept
    expect(session!.metrics.significantResults[0]!.resultPreview).toBe("Result 0");
    expect(session!.metrics.significantResults[4]!.resultPreview).toBe("Result 4");
  });

  it("truncates results longer than 2000 chars (MAX_CHARS)", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);
    const longResult = "x".repeat(3000);
    recordSignificantResult("sess1", "Read", null, longResult);
    const session = getSession("sess1");
    const preview = session!.metrics.significantResults[0]!.resultPreview;
    expect(preview.length).toBe(2003); // 2000 + "..."
    expect(preview.endsWith("...")).toBe(true);
  });

  it("does not truncate results at exactly 2000 chars", () => {
    startTracking("sess1", "coder", "proj1", workerConfig);
    const exactResult = "y".repeat(2000);
    recordSignificantResult("sess1", "Read", null, exactResult);
    const session = getSession("sess1");
    const preview = session!.metrics.significantResults[0]!.resultPreview;
    expect(preview.length).toBe(2000);
    expect(preview.endsWith("...")).toBe(false);
  });

  it("ignores calls to untracked sessions", () => {
    recordSignificantResult("unknown", "Bash", null, "should be ignored");
    // No error thrown, just silently ignored
    expect(getSession("unknown")).toBeNull();
  });
});
