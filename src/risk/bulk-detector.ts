/**
 * Clawforce — Bulk action sliding-window detector
 *
 * Detects when an agent is executing many actions of the same category
 * within a time window and escalates the risk tier accordingly.
 *
 * Uses in-memory sliding window (same pattern as dispatch rate limiter).
 * Resets on process restart — intentional: bulk detection is about
 * real-time bursts, not historical patterns.
 */

import type { RiskTier } from "../types.js";
import { getDefaultRuntimeState } from "../runtime/default-runtime.js";

// --- Types ---

export type BulkThreshold = {
  /** Time window in milliseconds. */
  windowMs: number;
  /** Maximum calls allowed in window before escalation. */
  maxCount: number;
  /** Tier to escalate to when threshold exceeded. */
  escalateTo: RiskTier;
};

export type BulkThresholdsConfig = Record<string, BulkThreshold>;

export type BulkCheckResult = {
  /** Whether the threshold was exceeded. */
  exceeded: boolean;
  /** Current count in window. */
  count: number;
  /** The threshold that was exceeded, if any. */
  threshold?: BulkThreshold;
  /** The escalated tier, if threshold exceeded. */
  escalatedTier?: RiskTier;
};

// --- In-memory sliding windows ---

type BulkDetectorRuntimeState = {
  bulkActionTimestamps: Map<string, number[]>;
};

const runtime = getDefaultRuntimeState();

function getBulkActionTimestamps(): BulkDetectorRuntimeState["bulkActionTimestamps"] {
  return (runtime.risk as BulkDetectorRuntimeState).bulkActionTimestamps;
}

function makeKey(
  projectId: string,
  agentId: string,
  category: string,
): string {
  return `${projectId}:${agentId}:${category}`;
}

/**
 * Record a tool gate hit for bulk detection.
 * Call this every time a tool gate is evaluated (regardless of approval outcome).
 */
export function recordToolGateHit(
  projectId: string,
  agentId: string,
  category: string,
): void {
  const key = makeKey(projectId, agentId, category);
  const timestamps = getBulkActionTimestamps().get(key) ?? [];
  timestamps.push(Date.now());
  getBulkActionTimestamps().set(key, timestamps);
}

/**
 * Check if the bulk threshold is exceeded for a category.
 * Returns the escalated tier if threshold is exceeded.
 */
export function checkBulkThreshold(
  projectId: string,
  agentId: string,
  category: string,
  thresholds: BulkThresholdsConfig,
): BulkCheckResult {
  const threshold = thresholds[category];
  if (!threshold) {
    return { exceeded: false, count: 0 };
  }

  const key = makeKey(projectId, agentId, category);
  const now = Date.now();
  const cutoff = now - threshold.windowMs;

  // Prune old timestamps
  const timestamps = getBulkActionTimestamps().get(key) ?? [];
  const recent = timestamps.filter((t) => t > cutoff);

  // Update stored timestamps (pruned)
  if (recent.length === 0) {
    getBulkActionTimestamps().delete(key);
  } else {
    getBulkActionTimestamps().set(key, recent);
  }

  if (recent.length >= threshold.maxCount) {
    return {
      exceeded: true,
      count: recent.length,
      threshold,
      escalatedTier: threshold.escalateTo,
    };
  }

  return { exceeded: false, count: recent.length };
}

/**
 * Get the effective tier after bulk escalation.
 * If threshold is exceeded, returns the escalated tier (if higher).
 * Otherwise returns the original tier.
 */
export function getEffectiveTier(
  projectId: string,
  agentId: string,
  category: string,
  originalTier: RiskTier,
  thresholds: BulkThresholdsConfig | undefined,
): { tier: RiskTier; bulkEscalated: boolean; count: number } {
  if (!thresholds) {
    return { tier: originalTier, bulkEscalated: false, count: 0 };
  }

  const result = checkBulkThreshold(projectId, agentId, category, thresholds);

  if (!result.exceeded || !result.escalatedTier) {
    return { tier: originalTier, bulkEscalated: false, count: result.count };
  }

  // Only escalate if the escalated tier is higher than original
  if (tierOrdinal(result.escalatedTier) > tierOrdinal(originalTier)) {
    return {
      tier: result.escalatedTier,
      bulkEscalated: true,
      count: result.count,
    };
  }

  return { tier: originalTier, bulkEscalated: false, count: result.count };
}

/** Reset all tracking state (for tests). */
export function resetBulkDetector(): void {
  getBulkActionTimestamps().clear();
}

/** Get current count for a key (for tests/visibility). */
export function getActionCount(
  projectId: string,
  agentId: string,
  category: string,
  windowMs: number,
): number {
  const key = makeKey(projectId, agentId, category);
  const now = Date.now();
  const cutoff = now - windowMs;
  const timestamps = getBulkActionTimestamps().get(key) ?? [];
  return timestamps.filter((t) => t > cutoff).length;
}

function tierOrdinal(tier: RiskTier): number {
  switch (tier) {
    case "low":
      return 0;
    case "medium":
      return 1;
    case "high":
      return 2;
    case "critical":
      return 3;
    default:
      return 0;
  }
}
