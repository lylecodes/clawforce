/**
 * Clawforce — Wake Bounds Enforcement
 *
 * Ensures coordination agents can only set their cron frequency
 * within configured bounds [fastest, slowest].
 */

/**
 * Extract minute interval from a simple "star/N * * * *" cron expression.
 * Returns null for complex expressions that can't be compared as intervals.
 */
function extractMinuteInterval(cron: string): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, ...rest] = parts;
  if (!rest.every((p) => p === "*")) return null;
  const match = minute.match(/^\*\/(\d+)$/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/**
 * Clamp a cron expression to wake bounds [fastest, slowest].
 * Only enforces for simple star-slash-N minute-interval patterns.
 * Complex expressions pass through unclamped.
 */
export function clampCronToWakeBounds(
  cron: string,
  wakeBounds?: [string, string],
): string {
  if (!wakeBounds) return cron;

  const interval = extractMinuteInterval(cron);
  if (interval === null) return cron;

  const [fastest, slowest] = wakeBounds;
  const fastestInterval = extractMinuteInterval(fastest);
  const slowestInterval = extractMinuteInterval(slowest);

  if (fastestInterval === null || slowestInterval === null) return cron;

  // Lower interval = more frequent (faster)
  if (interval < fastestInterval) return fastest;
  if (interval > slowestInterval) return slowest;

  return cron;
}
