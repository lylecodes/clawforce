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

/**
 * Check if any rate limit window for a provider exceeds the threshold.
 */
export function isProviderThrottled(provider: string, thresholdPercent: number = 90): boolean {
  const usage = store.get(provider);
  if (!usage) return false;
  return usage.windows.some(w => w.usedPercent >= thresholdPercent);
}

/** Get the highest used percent across all windows for a provider. */
export function getMaxUsagePercent(provider: string): number {
  const usage = store.get(provider);
  if (!usage || usage.windows.length === 0) return 0;
  return Math.max(...usage.windows.map(w => w.usedPercent));
}

export function clearAllUsage(): void {
  store.clear();
}
