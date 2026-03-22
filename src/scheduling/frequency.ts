/**
 * Clawforce — Frequency-based scheduling
 *
 * Parses "N/period" frequency targets and determines optimal run times
 * based on workload, queue state, and time since last run.
 */

export type FrequencyTarget = {
  times: number;
  period: "hour" | "day" | "week";
  /** Computed: period_ms / times */
  intervalMs: number;
};

const PERIOD_MS: Record<FrequencyTarget["period"], number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

const VALID_PERIODS = new Set<string>(["hour", "day", "week"]);

/**
 * Parse a frequency string like "3/day" into a structured target.
 * Returns null if the string is invalid.
 */
export function parseFrequency(freq: string): FrequencyTarget | null {
  const match = freq.match(/^(\d+)\/(hour|day|week)$/);
  if (!match) return null;

  const times = parseInt(match[1]!, 10);
  if (times <= 0 || !Number.isFinite(times)) return null;

  const period = match[2] as FrequencyTarget["period"];
  if (!VALID_PERIODS.has(period)) return null;

  const periodMs = PERIOD_MS[period];
  return {
    times,
    period,
    intervalMs: Math.floor(periodMs / times),
  };
}

export type ShouldRunResult = {
  shouldRun: boolean;
  reason?: string;
};

/**
 * Determine whether a frequency-based job should run now.
 *
 * Decision logic:
 * 1. Never run if minimum interval (80% of target) hasn't elapsed.
 * 2. Always run if max interval (150% of target) exceeded or never run before.
 * 3. Run early if there's pending work (reviews or queue items).
 * 4. Run at the target interval otherwise.
 */
export function shouldRunNow(
  frequency: FrequencyTarget,
  lastRunAt: number | null,
  currentQueueDepth: number,
  pendingReviews: number,
  now?: number,
): ShouldRunResult {
  const currentTime = now ?? Date.now();

  // Never run before — always run
  if (lastRunAt === null) {
    return { shouldRun: true, reason: "never run before" };
  }

  const elapsed = currentTime - lastRunAt;

  // Never run if the minimum interval hasn't elapsed (80% of target)
  if (elapsed < frequency.intervalMs * 0.8) {
    return { shouldRun: false, reason: "minimum interval not elapsed" };
  }

  // Always run if max interval exceeded (150% of target)
  if (elapsed > frequency.intervalMs * 1.5) {
    return { shouldRun: true, reason: "max interval exceeded" };
  }

  // Run early if there's work waiting
  if (pendingReviews > 0) {
    return { shouldRun: true, reason: `${pendingReviews} pending reviews` };
  }

  if (currentQueueDepth > 0) {
    return { shouldRun: true, reason: `${currentQueueDepth} items in queue` };
  }

  // Within the window — run at the target interval
  if (elapsed >= frequency.intervalMs) {
    return { shouldRun: true, reason: "target interval reached" };
  }

  return { shouldRun: false, reason: "waiting for optimal time" };
}
