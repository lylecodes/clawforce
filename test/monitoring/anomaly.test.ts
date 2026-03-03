import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { recordMetric } = await import("../../src/metrics.js");
const { detectAnomalies } = await import("../../src/monitoring/anomaly.js");

let db: ReturnType<typeof getMemoryDb>;

beforeEach(() => {
  vi.useFakeTimers();
  db = getMemoryDb();
});

afterEach(() => {
  vi.useRealTimers();
  try { db.close(); } catch {}
});

describe("detectAnomalies", () => {
  const WINDOW_MS = 60_000; // 1 minute windows
  const NOW = 1_700_000_600_000; // "now" when we call detectAnomalies

  /**
   * The anomaly detector defines windows as:
   *   current window: [now - windowMs, now]
   *   historical window i (1..N): [now - i*windowMs, now - (i-1)*windowMs]
   *
   * Note: historical window i=1 is [now - windowMs, now] which overlaps with
   * the current window completely. To get clean non-overlapping historical data,
   * we seed into windows i >= 2.
   *
   * To get 3 historical window values (needed to not return null),
   * we set lookbackWindows high enough to cover our seeded windows.
   */

  function seedAtTime(time: number, value: number): void {
    vi.setSystemTime(time);
    recordMetric({
      projectId: "p1",
      type: "cost",
      key: "cost_cents",
      value,
    }, db);
  }

  it("returns null (empty results) when insufficient history (<3 windows)", () => {
    // Seed only 2 historical windows (i=2 and i=3)
    // Window i=2: [NOW - 2*W, NOW - W]
    seedAtTime(NOW - 2 * WINDOW_MS + 1000, 100);
    // Window i=3: [NOW - 3*W, NOW - 2*W]
    seedAtTime(NOW - 3 * WINDOW_MS + 1000, 100);

    // Current window
    seedAtTime(NOW - WINDOW_MS + 1000, 200);

    vi.setSystemTime(NOW);
    const results = detectAnomalies("p1", {
      costAnomaly: {
        name: "costAnomaly",
        metricType: "cost",
        metricKey: "cost_cents",
        lookbackWindows: 3,
        windowMs: WINDOW_MS,
        stddevThreshold: 2,
      },
    }, db);

    // lookbackWindows=3 creates windows i=1,2,3.
    // Window i=1 overlaps with current, so it has data (value in current window).
    // Window i=2 and i=3 have data.
    // That gives 3 historical window values, which is exactly 3.
    // To truly get <3, we need to seed fewer windows with lookbackWindows
    // that doesn't cover them. Use lookbackWindows=2 to only get windows i=1,2.
    // Window i=1 has current data, window i=2 has data => 2 values => returns null.
    const results2 = detectAnomalies("p1", {
      costAnomaly: {
        name: "costAnomaly",
        metricType: "cost",
        metricKey: "cost_cents",
        lookbackWindows: 2,
        windowMs: WINDOW_MS,
        stddevThreshold: 2,
      },
    }, db);

    expect(results2).toHaveLength(0);
  });

  it("returns isAnomaly=true when current value deviates > threshold", () => {
    // Seed 5 historical windows with stable values of 100 each
    // Windows i=2..6 (non-overlapping with current)
    for (let i = 2; i <= 6; i++) {
      seedAtTime(NOW - i * WINDOW_MS + 1000, 100);
    }

    // Current window: massive spike
    seedAtTime(NOW - 500, 10000);

    vi.setSystemTime(NOW);
    const results = detectAnomalies("p1", {
      costAnomaly: {
        name: "costAnomaly",
        metricType: "cost",
        metricKey: "cost_cents",
        lookbackWindows: 6,
        windowMs: WINDOW_MS,
        stddevThreshold: 2,
      },
    }, db);

    expect(results).toHaveLength(1);
    expect(results[0]!.isAnomaly).toBe(true);
    expect(results[0]!.name).toBe("costAnomaly");
    expect(results[0]!.deviations).toBeGreaterThan(2);
  });

  it("returns isAnomaly=false when current value is within threshold", () => {
    // Seed historical windows with varied values so stddev is meaningful.
    // Windows i=2..6 have values: 80, 100, 120, 90, 110 (mean~100, stddev~14.1)
    const historicalValues = [80, 100, 120, 90, 110];
    for (let i = 2; i <= 6; i++) {
      seedAtTime(NOW - i * WINDOW_MS + 1000, historicalValues[i - 2]!);
    }

    // Current window (also window i=1): value close to mean
    // Mean of historical = 100, stddev ~14.1, threshold=2 => need |current-mean|/stddev < 2
    // So current must be within 100 +/- 28.2 => seed value 100
    seedAtTime(NOW - 500, 100);

    vi.setSystemTime(NOW);
    const results = detectAnomalies("p1", {
      costAnomaly: {
        name: "costAnomaly",
        metricType: "cost",
        metricKey: "cost_cents",
        lookbackWindows: 6,
        windowMs: WINDOW_MS,
        stddevThreshold: 2,
      },
    }, db);

    expect(results).toHaveLength(1);
    expect(results[0]!.isAnomaly).toBe(false);
  });

  it("when stddev=0 and value equals mean, deviations is 0 and finite (not Infinity)", () => {
    // Historical window i=1 overlaps with the current window in this implementation,
    // so stddev=0 can only occur when ALL windows (including current) have the
    // same value. This tests the stddev=0 code path, verifying deviations=0
    // and that no Infinity is produced.

    // Seed ALL windows (including i=1/current) with identical value 100
    // Window i=1/current: [NOW-W, NOW]
    seedAtTime(NOW - 500, 100);
    // Windows i=2..5
    for (let i = 2; i <= 5; i++) {
      seedAtTime(NOW - i * WINDOW_MS + 1000, 100);
    }

    vi.setSystemTime(NOW);
    const results = detectAnomalies("p1", {
      costAnomaly: {
        name: "costAnomaly",
        metricType: "cost",
        metricKey: "cost_cents",
        lookbackWindows: 5,
        windowMs: WINDOW_MS,
        stddevThreshold: 2,
      },
    }, db);

    expect(results).toHaveLength(1);
    // All historical windows = 100, current = 100
    // stddev = 0, currentValue = mean => deviations = 0
    expect(results[0]!.stddev).toBe(0);
    expect(results[0]!.deviations).toBe(0);
    expect(results[0]!.isAnomaly).toBe(false);
    expect(Number.isFinite(results[0]!.deviations)).toBe(true);
  });

  it("when stddev=0 and value equals mean, deviations is 0", () => {
    // All windows (including current) have the same value
    seedAtTime(NOW - 500, 50);
    for (let i = 2; i <= 5; i++) {
      seedAtTime(NOW - i * WINDOW_MS + 1000, 50);
    }

    vi.setSystemTime(NOW);
    const results = detectAnomalies("p1", {
      costAnomaly: {
        name: "costAnomaly",
        metricType: "cost",
        metricKey: "cost_cents",
        lookbackWindows: 5,
        windowMs: WINDOW_MS,
        stddevThreshold: 2,
      },
    }, db);

    expect(results).toHaveLength(1);
    expect(results[0]!.stddev).toBe(0);
    expect(results[0]!.deviations).toBe(0);
    expect(results[0]!.isAnomaly).toBe(false);
  });
});
