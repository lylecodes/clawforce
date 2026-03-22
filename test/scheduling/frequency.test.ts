import { describe, expect, it } from "vitest";
import { parseFrequency, shouldRunNow } from "../../src/scheduling/frequency.js";
import type { FrequencyTarget } from "../../src/scheduling/frequency.js";

describe("parseFrequency", () => {
  it("parses '3/day' correctly", () => {
    const result = parseFrequency("3/day");
    expect(result).not.toBeNull();
    expect(result!.times).toBe(3);
    expect(result!.period).toBe("day");
    expect(result!.intervalMs).toBe(Math.floor(86_400_000 / 3));
  });

  it("parses '1/hour' correctly", () => {
    const result = parseFrequency("1/hour");
    expect(result).not.toBeNull();
    expect(result!.times).toBe(1);
    expect(result!.period).toBe("hour");
    expect(result!.intervalMs).toBe(3_600_000);
  });

  it("parses '7/week' correctly", () => {
    const result = parseFrequency("7/week");
    expect(result).not.toBeNull();
    expect(result!.times).toBe(7);
    expect(result!.period).toBe("week");
    expect(result!.intervalMs).toBe(Math.floor(604_800_000 / 7));
  });

  it("parses '12/day' correctly", () => {
    const result = parseFrequency("12/day");
    expect(result).not.toBeNull();
    expect(result!.times).toBe(12);
    expect(result!.period).toBe("day");
    expect(result!.intervalMs).toBe(Math.floor(86_400_000 / 12));
  });

  it("returns null for invalid format — missing number", () => {
    expect(parseFrequency("/day")).toBeNull();
  });

  it("returns null for invalid format — missing period", () => {
    expect(parseFrequency("3/")).toBeNull();
  });

  it("returns null for invalid period", () => {
    expect(parseFrequency("3/month")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseFrequency("")).toBeNull();
  });

  it("returns null for non-numeric count", () => {
    expect(parseFrequency("abc/day")).toBeNull();
  });

  it("returns null for zero count", () => {
    expect(parseFrequency("0/day")).toBeNull();
  });

  it("returns null for cron expression", () => {
    expect(parseFrequency("*/30 * * * *")).toBeNull();
  });

  it("returns null for decimal count", () => {
    expect(parseFrequency("1.5/day")).toBeNull();
  });
});

describe("shouldRunNow", () => {
  const threePerDay: FrequencyTarget = {
    times: 3,
    period: "day",
    intervalMs: Math.floor(86_400_000 / 3), // 28_800_000 ms = 8 hours
  };

  const baseTime = 1_700_000_000_000;

  it("should run when never run before (lastRunAt is null)", () => {
    const result = shouldRunNow(threePerDay, null, 0, 0, baseTime);
    expect(result.shouldRun).toBe(true);
    expect(result.reason).toBe("never run before");
  });

  it("should NOT run when minimum interval not elapsed (< 80%)", () => {
    // 80% of 8h = 6.4h. Set last run to 4h ago — well under the minimum.
    const lastRun = baseTime - 4 * 3_600_000;
    const result = shouldRunNow(threePerDay, lastRun, 0, 0, baseTime);
    expect(result.shouldRun).toBe(false);
    expect(result.reason).toBe("minimum interval not elapsed");
  });

  it("should NOT run even with pending work when minimum interval not elapsed", () => {
    const lastRun = baseTime - 4 * 3_600_000;
    const result = shouldRunNow(threePerDay, lastRun, 5, 3, baseTime);
    expect(result.shouldRun).toBe(false);
    expect(result.reason).toBe("minimum interval not elapsed");
  });

  it("should run when max interval exceeded (> 150%)", () => {
    // 150% of 8h = 12h. Set last run to 13h ago.
    const lastRun = baseTime - 13 * 3_600_000;
    const result = shouldRunNow(threePerDay, lastRun, 0, 0, baseTime);
    expect(result.shouldRun).toBe(true);
    expect(result.reason).toBe("max interval exceeded");
  });

  it("should run early when pending reviews exist and past minimum interval", () => {
    // 80% of 8h = 6.4h. Set last run to 7h ago (past minimum, but before target).
    const lastRun = baseTime - 7 * 3_600_000;
    const result = shouldRunNow(threePerDay, lastRun, 0, 2, baseTime);
    expect(result.shouldRun).toBe(true);
    expect(result.reason).toBe("2 pending reviews");
  });

  it("should run early when queue has items and past minimum interval", () => {
    const lastRun = baseTime - 7 * 3_600_000;
    const result = shouldRunNow(threePerDay, lastRun, 3, 0, baseTime);
    expect(result.shouldRun).toBe(true);
    expect(result.reason).toBe("3 items in queue");
  });

  it("should prefer pending reviews over queue depth", () => {
    const lastRun = baseTime - 7 * 3_600_000;
    const result = shouldRunNow(threePerDay, lastRun, 3, 2, baseTime);
    expect(result.shouldRun).toBe(true);
    expect(result.reason).toBe("2 pending reviews");
  });

  it("should run at target interval with no work pressure", () => {
    // Set last run to exactly 8h ago (target interval).
    const lastRun = baseTime - threePerDay.intervalMs;
    const result = shouldRunNow(threePerDay, lastRun, 0, 0, baseTime);
    expect(result.shouldRun).toBe(true);
    expect(result.reason).toBe("target interval reached");
  });

  it("should wait when between minimum and target interval with no work", () => {
    // 80% of 8h = 6.4h. 7h is past minimum but before target.
    const lastRun = baseTime - 7 * 3_600_000;
    const result = shouldRunNow(threePerDay, lastRun, 0, 0, baseTime);
    expect(result.shouldRun).toBe(false);
    expect(result.reason).toBe("waiting for optimal time");
  });

  it("works with 1/hour frequency", () => {
    const hourly: FrequencyTarget = {
      times: 1,
      period: "hour",
      intervalMs: 3_600_000,
    };

    // Last run 30 min ago — under 80% of 1h
    const recentRun = baseTime - 30 * 60_000;
    expect(shouldRunNow(hourly, recentRun, 0, 0, baseTime).shouldRun).toBe(false);

    // Last run 50 min ago — between 80% (48min) and 100%
    const midRun = baseTime - 50 * 60_000;
    expect(shouldRunNow(hourly, midRun, 0, 0, baseTime).shouldRun).toBe(false);

    // Last run 50 min ago with pending reviews — should trigger
    expect(shouldRunNow(hourly, midRun, 0, 1, baseTime).shouldRun).toBe(true);

    // Last run 60 min ago — at target
    const targetRun = baseTime - 60 * 60_000;
    expect(shouldRunNow(hourly, targetRun, 0, 0, baseTime).shouldRun).toBe(true);
  });
});
