/**
 * Clawforce — Safety limits
 *
 * Configurable guardrails with conservative defaults.
 * Each check returns { ok, reason? } and is called at the relevant enforcement point.
 */

import type { DatabaseSync } from "./sqlite-driver.js";
import { getDb } from "./db.js";
import { getExtendedProjectConfig } from "./project.js";
import { getDefaultRuntimeState } from "./runtime/default-runtime.js";
import type {
  LifecycleConfig,
  SafetyConfig,
} from "./types.js";

// --- Defaults ---

const DEFAULTS: Required<SafetyConfig> = {
  maxSpawnDepth: 3,
  costCircuitBreaker: 1.5,
  loopDetectionThreshold: 3,
  maxConcurrentMeetings: 2,
  maxMessageRate: 60,
  maxTasksPerSession: 10,
  maxSessionDurationMs: 600_000,
  spendRateWarningThreshold: 0.8,
  maxConsecutiveFailures: 5,
  emergencyStop: false,
  maxQueueDepth: 50,
  maxCallsPerSession: 100,
  maxCallsPerMinute: 200,
  maxCallsPerMinutePerAgent: 60,
  retryBackoffBaseMs: 30_000,
  retryBackoffMaxMs: 600_000,
};

export type SafetyCheckResult = { ok: true } | { ok: false; reason: string };

type SafetyRuntimeState = {
  channelMessageTimestamps: Map<string, number[]>;
};

const runtime = getDefaultRuntimeState();

function getSafetyRuntimeState(): SafetyRuntimeState {
  return runtime.safety as SafetyRuntimeState;
}

/**
 * Get the effective safety config for a project, merging with defaults.
 */
export function getSafetyConfig(projectId: string): Required<SafetyConfig> {
  const extConfig = getExtendedProjectConfig(projectId);
  const userConfig = extConfig?.safety;
  if (!userConfig) return { ...DEFAULTS };

  return {
    maxSpawnDepth: userConfig.maxSpawnDepth ?? DEFAULTS.maxSpawnDepth,
    costCircuitBreaker: userConfig.costCircuitBreaker ?? DEFAULTS.costCircuitBreaker,
    loopDetectionThreshold: userConfig.loopDetectionThreshold ?? DEFAULTS.loopDetectionThreshold,
    maxConcurrentMeetings: userConfig.maxConcurrentMeetings ?? DEFAULTS.maxConcurrentMeetings,
    maxMessageRate: userConfig.maxMessageRate ?? DEFAULTS.maxMessageRate,
    maxTasksPerSession: userConfig.maxTasksPerSession ?? DEFAULTS.maxTasksPerSession,
    maxSessionDurationMs: userConfig.maxSessionDurationMs ?? DEFAULTS.maxSessionDurationMs,
    spendRateWarningThreshold: userConfig.spendRateWarningThreshold ?? DEFAULTS.spendRateWarningThreshold,
    maxConsecutiveFailures: userConfig.maxConsecutiveFailures ?? DEFAULTS.maxConsecutiveFailures,
    emergencyStop: userConfig.emergencyStop ?? DEFAULTS.emergencyStop,
    maxQueueDepth: userConfig.maxQueueDepth ?? DEFAULTS.maxQueueDepth,
    maxCallsPerSession: userConfig.maxCallsPerSession ?? DEFAULTS.maxCallsPerSession,
    maxCallsPerMinute: userConfig.maxCallsPerMinute ?? DEFAULTS.maxCallsPerMinute,
    maxCallsPerMinutePerAgent: userConfig.maxCallsPerMinutePerAgent ?? DEFAULTS.maxCallsPerMinutePerAgent,
    retryBackoffBaseMs: userConfig.retryBackoffBaseMs ?? DEFAULTS.retryBackoffBaseMs,
    retryBackoffMaxMs: userConfig.retryBackoffMaxMs ?? DEFAULTS.retryBackoffMaxMs,
  };
}

/**
 * Get raw defaults for testing/visibility.
 */
export function getSafetyDefaults(): Required<SafetyConfig> {
  return { ...DEFAULTS };
}

// --- Spawn depth ---

/**
 * Check if a dispatch would exceed the max spawn depth.
 * Spawn depth is tracked via the task's goal/parent chain in the DB.
 */
export function checkSpawnDepth(
  projectId: string,
  taskId: string | undefined,
  dbOverride?: DatabaseSync,
): SafetyCheckResult {
  if (!taskId) return { ok: true };

  const config = getSafetyConfig(projectId);
  const db = dbOverride ?? getDb(projectId);

  // Walk the goal chain: task → goal → parent_goal → ... counting depth
  try {
    const task = db.prepare(
      "SELECT goal_id FROM tasks WHERE id = ? AND project_id = ?",
    ).get(taskId, projectId) as Record<string, unknown> | undefined;

    if (!task?.goal_id) return { ok: true };

    let depth = 0;
    let currentGoalId = task.goal_id as string;

    while (currentGoalId && depth <= config.maxSpawnDepth) {
      depth++;
      const goal = db.prepare(
        "SELECT parent_goal_id FROM goals WHERE id = ? AND project_id = ?",
      ).get(currentGoalId, projectId) as Record<string, unknown> | undefined;

      if (!goal?.parent_goal_id) break;
      currentGoalId = goal.parent_goal_id as string;
    }

    if (depth > config.maxSpawnDepth) {
      return {
        ok: false,
        reason: `Spawn depth ${depth} exceeds limit of ${config.maxSpawnDepth}`,
      };
    }
  } catch {
    // Non-fatal — allow if check fails
  }

  return { ok: true };
}

// --- Cost circuit breaker ---

/**
 * Check if daily spending has exceeded the circuit breaker threshold.
 * Triggers at `costCircuitBreaker * dailyLimitCents`.
 */
export function checkCostCircuitBreaker(
  projectId: string,
  agentId?: string,
  dbOverride?: DatabaseSync,
): SafetyCheckResult {
  const config = getSafetyConfig(projectId);
  const db = dbOverride ?? getDb(projectId);

  try {
    // Check budget across all dimensions (cents, tokens, requests)
    const query = agentId
      ? `SELECT daily_limit_cents, daily_spent_cents,
                daily_limit_tokens, daily_spent_tokens,
                daily_limit_requests, daily_spent_requests
         FROM budgets WHERE project_id = ? AND agent_id = ?`
      : `SELECT daily_limit_cents, daily_spent_cents,
                daily_limit_tokens, daily_spent_tokens,
                daily_limit_requests, daily_spent_requests
         FROM budgets WHERE project_id = ? AND agent_id IS NULL`;
    const args = agentId ? [projectId, agentId] : [projectId];
    const budget = db.prepare(query).get(...args) as Record<string, unknown> | undefined;

    if (!budget) return { ok: true };

    const scope = agentId ? `agent "${agentId}"` : "project";

    // Check all three dimensions with the same multiplier
    const dimensions: Array<{ name: string; limitCol: string; spentCol: string; unit: string }> = [
      { name: "cents", limitCol: "daily_limit_cents", spentCol: "daily_spent_cents", unit: "cents" },
      { name: "tokens", limitCol: "daily_limit_tokens", spentCol: "daily_spent_tokens", unit: "tokens" },
      { name: "requests", limitCol: "daily_limit_requests", spentCol: "daily_spent_requests", unit: "requests" },
    ];

    for (const dim of dimensions) {
      const limit = budget[dim.limitCol] as number | null;
      const spent = budget[dim.spentCol] as number;

      if (limit === null || limit === undefined || limit <= 0) continue;

      const threshold = Math.floor(limit * config.costCircuitBreaker);
      if (spent >= threshold) {
        return {
          ok: false,
          reason: `Cost circuit breaker: ${scope} spent ${spent} ${dim.unit}, exceeds ${config.costCircuitBreaker}x budget threshold of ${threshold} ${dim.unit} (limit: ${limit})`,
        };
      }
    }
  } catch {
    // Non-fatal
  }

  return { ok: true };
}

// --- Loop detection ---

/**
 * Check if a task title has been repeatedly failing across tasks.
 * Detects when the same work keeps being created and failing.
 */
export function checkLoopDetection(
  projectId: string,
  taskTitle: string,
  dbOverride?: DatabaseSync,
): SafetyCheckResult {
  const config = getSafetyConfig(projectId);
  const db = dbOverride ?? getDb(projectId);

  try {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM tasks
      WHERE project_id = ? AND title = ? AND state = 'FAILED'
        AND retry_count >= max_retries
    `).get(projectId, taskTitle) as Record<string, unknown>;

    const failCount = (row.cnt as number) ?? 0;
    if (failCount >= config.loopDetectionThreshold) {
      return {
        ok: false,
        reason: `Loop detected: task "${taskTitle}" has failed ${failCount} time(s), threshold is ${config.loopDetectionThreshold}. Requires human intervention.`,
      };
    }
  } catch {
    // Non-fatal
  }

  return { ok: true };
}

// --- Meeting concurrency ---

/**
 * Check if the project is at its concurrent meeting limit.
 */
export function checkMeetingConcurrency(
  projectId: string,
  dbOverride?: DatabaseSync,
): SafetyCheckResult {
  const config = getSafetyConfig(projectId);
  const db = dbOverride ?? getDb(projectId);

  try {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM channels
      WHERE project_id = ? AND type = 'meeting' AND status = 'active'
    `).get(projectId) as Record<string, unknown>;

    const active = (row.cnt as number) ?? 0;
    if (active >= config.maxConcurrentMeetings) {
      return {
        ok: false,
        reason: `Meeting limit: ${active} active meeting(s), max is ${config.maxConcurrentMeetings}`,
      };
    }
  } catch {
    // Non-fatal
  }

  return { ok: true };
}

// --- Message rate limiting ---

// In-memory sliding window: channelId → timestamps[]
/**
 * Check if a channel is within its message rate limit.
 * Also records the message timestamp for future checks.
 */
export function checkMessageRate(
  projectId: string,
  channelId: string,
): SafetyCheckResult {
  const config = getSafetyConfig(projectId);
  const key = `${projectId}:${channelId}`;
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;

  // Prune and count
  const timestamps = getSafetyRuntimeState().channelMessageTimestamps.get(key) ?? [];
  const recent = timestamps.filter((t) => t > oneMinuteAgo);

  if (recent.length >= config.maxMessageRate) {
    getSafetyRuntimeState().channelMessageTimestamps.set(key, recent);
    return {
      ok: false,
      reason: `Message rate limit: ${recent.length} messages in last minute, max is ${config.maxMessageRate}/min`,
    };
  }

  // Record this message
  recent.push(now);
  getSafetyRuntimeState().channelMessageTimestamps.set(key, recent);

  return { ok: true };
}

/** Reset message rate tracking (for tests). */
export function resetMessageRateTracking(): void {
  getSafetyRuntimeState().channelMessageTimestamps.clear();
}

// --- Emergency stop ---

/**
 * Check if emergency stop is active for a project.
 * When active, ALL dispatches are blocked immediately.
 */
export function checkEmergencyStop(
  projectId: string,
  dbOverride?: DatabaseSync,
): SafetyCheckResult {
  if (isEmergencyStopActive(projectId, dbOverride)) {
    return { ok: false, reason: "Emergency stop active — all dispatches blocked" };
  }
  return { ok: true };
}

/**
 * Activate emergency stop for a project.
 * Persists to the project_metadata table.
 */
export function activateEmergencyStop(projectId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare(
    "INSERT OR REPLACE INTO project_metadata (project_id, key, value) VALUES (?, 'emergency_stop', 'true')",
  ).run(projectId);
}

/**
 * Deactivate emergency stop for a project.
 */
export function deactivateEmergencyStop(projectId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare(
    "DELETE FROM project_metadata WHERE project_id = ? AND key = 'emergency_stop'",
  ).run(projectId);
}

/**
 * Check if emergency stop is currently active for a project.
 */
export function isEmergencyStopActive(projectId: string, dbOverride?: DatabaseSync): boolean {
  try {
    const db = dbOverride ?? getDb(projectId);
    const row = db.prepare(
      "SELECT value FROM project_metadata WHERE project_id = ? AND key = 'emergency_stop'",
    ).get(projectId) as { value: string } | undefined;
    return row?.value === "true";
  } catch {
    return false;
  }
}

// --- Spend rate warning ---

export type SpendRateWarningResult = { warning: boolean; pct: number; reason?: string };

/**
 * Check if daily spend has exceeded the warning threshold.
 * Returns a warning (but does not block) when spend crosses the threshold.
 */
export function checkSpendRateWarning(
  projectId: string,
  agentId?: string,
  dbOverride?: DatabaseSync,
): SpendRateWarningResult {
  const config = getSafetyConfig(projectId);
  const db = dbOverride ?? getDb(projectId);

  try {
    const query = agentId
      ? `SELECT daily_limit_cents, daily_spent_cents FROM budgets WHERE project_id = ? AND agent_id = ?`
      : `SELECT daily_limit_cents, daily_spent_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL`;
    const args = agentId ? [projectId, agentId] : [projectId];
    const budget = db.prepare(query).get(...args) as Record<string, unknown> | undefined;

    if (!budget) return { warning: false, pct: 0 };

    const limit = budget.daily_limit_cents as number | null;
    const spent = budget.daily_spent_cents as number;

    if (!limit || limit <= 0) return { warning: false, pct: 0 };

    const pct = spent / limit;
    const threshold = config.spendRateWarningThreshold;

    if (pct >= threshold) {
      const scope = agentId ? `agent "${agentId}"` : "project";
      return {
        warning: true,
        pct: Math.round(pct * 100),
        reason: `Spend rate warning: ${scope} at ${Math.round(pct * 100)}% of daily budget (${spent}/${limit} cents, threshold ${Math.round(threshold * 100)}%)`,
      };
    }

    return { warning: false, pct: Math.round(pct * 100) };
  } catch {
    return { warning: false, pct: 0 };
  }
}

// --- Consecutive failure tracking ---

/**
 * Count consecutive non-compliant audit runs for an agent.
 * Looks at the most recent audit_runs and counts how many consecutive
 * ones have a non-success status.
 */
export function getConsecutiveFailures(
  projectId: string,
  agentId: string,
  dbOverride?: DatabaseSync,
): number {
  try {
    const db = dbOverride ?? getDb(projectId);
    const rows = db.prepare(
      `SELECT status FROM audit_runs
       WHERE project_id = ? AND agent_id = ?
       ORDER BY ended_at DESC LIMIT 20`,
    ).all(projectId, agentId) as Array<{ status: string }>;

    let count = 0;
    for (const row of rows) {
      if (row.status === "success" || row.status === "compliant") break;
      count++;
    }
    return count;
  } catch {
    return 0;
  }
}

// --- Queue depth check ---

/**
 * Check if the dispatch queue depth has exceeded the limit for a project.
 */
export function checkQueueDepth(
  projectId: string,
  dbOverride?: DatabaseSync,
): SafetyCheckResult {
  const config = getSafetyConfig(projectId);
  const db = dbOverride ?? getDb(projectId);

  try {
    const row = db.prepare(
      "SELECT COUNT(*) as c FROM dispatch_queue WHERE project_id = ? AND status IN ('queued', 'leased')",
    ).get(projectId) as { c: number };

    const maxDepth = config.maxQueueDepth;
    if (row.c >= maxDepth) {
      return {
        ok: false,
        reason: `Queue depth limit reached (${row.c}/${maxDepth})`,
      };
    }
  } catch {
    // Non-fatal
  }

  return { ok: true };
}

// --- Lifecycle config defaults ---

const LIFECYCLE_DEFAULTS: Required<LifecycleConfig> = {
  autoTransitionOnDispatch: true,
  autoTransitionOnComplete: true,
  autoCaptureEvidence: true,
  significantTools: ["Bash", "Write", "Edit", "Read"],
  evidenceTruncationLimit: 2000,
  immediateReviewDispatch: true,
  workerNonComplianceAction: "BLOCKED",
};

/**
 * Get the effective lifecycle config for a project, merging with defaults.
 */
export function getEffectiveLifecycleConfig(projectId: string): Required<LifecycleConfig> {
  const ext = getExtendedProjectConfig(projectId);
  const lc = ext?.lifecycle;
  if (!lc) return { ...LIFECYCLE_DEFAULTS };
  return {
    autoTransitionOnDispatch: lc.autoTransitionOnDispatch ?? LIFECYCLE_DEFAULTS.autoTransitionOnDispatch,
    autoTransitionOnComplete: lc.autoTransitionOnComplete ?? LIFECYCLE_DEFAULTS.autoTransitionOnComplete,
    autoCaptureEvidence: lc.autoCaptureEvidence ?? LIFECYCLE_DEFAULTS.autoCaptureEvidence,
    significantTools: lc.significantTools ?? LIFECYCLE_DEFAULTS.significantTools,
    evidenceTruncationLimit: lc.evidenceTruncationLimit ?? LIFECYCLE_DEFAULTS.evidenceTruncationLimit,
    immediateReviewDispatch: lc.immediateReviewDispatch ?? LIFECYCLE_DEFAULTS.immediateReviewDispatch,
    workerNonComplianceAction: lc.workerNonComplianceAction ?? LIFECYCLE_DEFAULTS.workerNonComplianceAction,
  };
}
