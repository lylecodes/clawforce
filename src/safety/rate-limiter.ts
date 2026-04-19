/**
 * Clawforce — LLM call rate limiter
 *
 * Mid-session rate limiting for tool calls (proxy for LLM API calls).
 * Tracks per-session totals, per-minute global, and per-minute per-agent.
 * Uses in-memory sliding windows — no DB required.
 */

import { getDefaultRuntimeState } from "../runtime/default-runtime.js";

// --- Types ---

export type RateLimitCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export type RateLimitConfig = {
  /** Max tool calls per session. Default: 100. */
  maxCallsPerSession: number;
  /** Max tool calls per minute across all sessions (global). Default: 200. */
  maxCallsPerMinute: number;
  /** Max tool calls per minute per agent. Default: 60. */
  maxCallsPerMinutePerAgent: number;
};

export const RATE_LIMIT_DEFAULTS: Readonly<RateLimitConfig> = {
  maxCallsPerSession: 100,
  maxCallsPerMinute: 200,
  maxCallsPerMinutePerAgent: 60,
};

// --- Backoff types ---

export type BackoffConfig = {
  /** Base delay in milliseconds. Default: 30000 (30s). */
  baseDelayMs: number;
  /** Maximum delay in milliseconds. Default: 600000 (10min). */
  maxDelayMs: number;
};

export const BACKOFF_DEFAULTS: Readonly<BackoffConfig> = {
  baseDelayMs: 30_000,
  maxDelayMs: 600_000,
};

// --- In-memory state ---

const ONE_MINUTE_MS = 60_000;

type RateLimiterRuntimeState = {
  sessionCallCounts: Map<string, number>;
  globalCallTimestamps: number[];
  agentCallTimestamps: Map<string, number[]>;
  projectCallTimestamps: Map<string, number[]>;
};

const runtime = getDefaultRuntimeState();

function getRateLimiterState(): RateLimiterRuntimeState {
  return runtime.rateLimiter as RateLimiterRuntimeState;
}

// --- Core functions ---

/**
 * Record a tool call for rate limiting.
 * Call this after each tool call completes.
 */
export function recordCall(
  projectId: string,
  agentId: string,
  sessionKey: string,
): void {
  const state = getRateLimiterState();
  const now = Date.now();

  // Per-session increment
  const current = state.sessionCallCounts.get(sessionKey) ?? 0;
  state.sessionCallCounts.set(sessionKey, current + 1);

  // Global sliding window
  state.globalCallTimestamps.push(now);

  // Per-agent sliding window
  const agentTs = state.agentCallTimestamps.get(agentId) ?? [];
  agentTs.push(now);
  state.agentCallTimestamps.set(agentId, agentTs);

  // Per-project sliding window
  const projectTs = state.projectCallTimestamps.get(projectId) ?? [];
  projectTs.push(now);
  state.projectCallTimestamps.set(projectId, projectTs);
}

/**
 * Check whether the next call is allowed under rate limits.
 * Does NOT record the call — call recordCall() separately after the tool call completes.
 */
export function checkCallLimit(
  projectId: string,
  agentId: string,
  sessionKey: string,
  config: RateLimitConfig = RATE_LIMIT_DEFAULTS,
): RateLimitCheckResult {
  const state = getRateLimiterState();
  const now = Date.now();
  const cutoff = now - ONE_MINUTE_MS;

  // 1. Per-session total
  const sessionCount = state.sessionCallCounts.get(sessionKey) ?? 0;
  if (sessionCount >= config.maxCallsPerSession) {
    return {
      allowed: false,
      reason: `Session call limit exceeded: ${sessionCount}/${config.maxCallsPerSession} calls`,
    };
  }

  // 2. Global per-minute
  const recentGlobal = pruneAndCount(state.globalCallTimestamps, cutoff);
  state.globalCallTimestamps = state.globalCallTimestamps.filter((t) => t > cutoff);
  if (recentGlobal >= config.maxCallsPerMinute) {
    return {
      allowed: false,
      reason: `Global rate limit exceeded: ${recentGlobal}/${config.maxCallsPerMinute} calls/min`,
    };
  }

  // 3. Per-agent per-minute
  const agentTs = state.agentCallTimestamps.get(agentId) ?? [];
  const recentAgent = pruneAndCount(agentTs, cutoff);
  state.agentCallTimestamps.set(agentId, agentTs.filter((t) => t > cutoff));
  if (recentAgent >= config.maxCallsPerMinutePerAgent) {
    return {
      allowed: false,
      reason: `Agent "${agentId}" rate limit exceeded: ${recentAgent}/${config.maxCallsPerMinutePerAgent} calls/min`,
    };
  }

  return { allowed: true };
}

/**
 * Get current rate limit counters for diagnostics/dashboards.
 */
export function getRateLimitInfo(
  projectId: string,
  agentId: string,
  sessionKey: string,
): {
  sessionCalls: number;
  globalCallsPerMinute: number;
  agentCallsPerMinute: number;
} {
  const state = getRateLimiterState();
  const now = Date.now();
  const cutoff = now - ONE_MINUTE_MS;

  return {
    sessionCalls: state.sessionCallCounts.get(sessionKey) ?? 0,
    globalCallsPerMinute: pruneAndCount(state.globalCallTimestamps, cutoff),
    agentCallsPerMinute: pruneAndCount(state.agentCallTimestamps.get(agentId) ?? [], cutoff),
  };
}

/**
 * Remove tracking for a session (call when session ends).
 */
export function clearSession(sessionKey: string): void {
  getRateLimiterState().sessionCallCounts.delete(sessionKey);
}

/**
 * Calculate exponential backoff delay for a retry attempt.
 * Formula: min(baseDelay * 2^retryCount, maxDelay)
 * Adds jitter of +/- 10% to prevent thundering herd.
 */
export function calculateBackoffDelay(
  retryCount: number,
  config: BackoffConfig = BACKOFF_DEFAULTS,
): number {
  const rawDelay = config.baseDelayMs * Math.pow(2, retryCount);
  const clampedDelay = Math.min(rawDelay, config.maxDelayMs);

  // Add +/- 10% jitter
  const jitterRange = clampedDelay * 0.1;
  const jitter = (Math.random() * 2 - 1) * jitterRange;

  return Math.max(0, Math.round(clampedDelay + jitter));
}

/**
 * Calculate backoff delay deterministically (no jitter, for testing).
 */
export function calculateBackoffDelayDeterministic(
  retryCount: number,
  config: BackoffConfig = BACKOFF_DEFAULTS,
): number {
  const rawDelay = config.baseDelayMs * Math.pow(2, retryCount);
  return Math.min(rawDelay, config.maxDelayMs);
}

// --- Reset (for testing) ---

export function resetRateLimiter(): void {
  const state = getRateLimiterState();
  state.sessionCallCounts.clear();
  state.globalCallTimestamps = [];
  state.agentCallTimestamps.clear();
  state.projectCallTimestamps.clear();
}

// --- Helpers ---

function pruneAndCount(timestamps: number[], cutoff: number): number {
  let count = 0;
  for (const t of timestamps) {
    if (t > cutoff) count++;
  }
  return count;
}
