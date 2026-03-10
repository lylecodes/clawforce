/**
 * Clawforce — Rate limit tracker
 *
 * In-memory store for provider rate limit status.
 * Updated from OpenClaw's ProviderUsageSnapshot data.
 * Queried by capacity planner and dispatch gate.
 */

export type UsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

export type ProviderUsage = {
  provider: string;
  windows: UsageWindow[];
  plan?: string;
  error?: string;
  updatedAt: number;
};

const store = new Map<string, ProviderUsage>();

/** Data older than this is considered stale and ignored. */
const STALENESS_MS = 10 * 60 * 1000; // 10 minutes

export function updateProviderUsage(
  provider: string,
  data: { windows: UsageWindow[]; plan?: string; error?: string },
): void {
  store.set(provider, {
    provider,
    windows: data.windows,
    plan: data.plan,
    error: data.error,
    updatedAt: Date.now(),
  });
}

export function getProviderUsage(provider: string): ProviderUsage | undefined {
  return store.get(provider);
}

export function getAllProviderUsage(): ProviderUsage[] {
  return [...store.values()];
}

function isStale(usage: ProviderUsage): boolean {
  return Date.now() - usage.updatedAt > STALENESS_MS;
}

/**
 * Check if any rate limit window for a provider exceeds the threshold.
 * Ignores stale data (older than 10 minutes).
 */
export function isProviderThrottled(provider: string, thresholdPercent: number = 90): boolean {
  const usage = store.get(provider);
  if (!usage || isStale(usage)) return false;
  return usage.windows.some(w => w.usedPercent >= thresholdPercent);
}

/** Get the highest used percent across all windows for a provider. Ignores stale data. */
export function getMaxUsagePercent(provider: string): number {
  const usage = store.get(provider);
  if (!usage || usage.windows.length === 0 || isStale(usage)) return 0;
  return Math.max(...usage.windows.map(w => w.usedPercent));
}

export function clearAllUsage(): void {
  store.clear();
}
