/**
 * Clawforce — Dispatch loop
 *
 * Claims items from the dispatch queue, acquires task leases,
 * spawns agents, and completes/fails queue items.
 * Per-project and per-agent concurrency + rate limiting.
 */

import type { DatabaseSync } from "node:sqlite";
import { checkBudget } from "../budget.js";
import { checkBudgetV2 } from "../budget/check-v2.js";
import { isProviderThrottled } from "../rate-limits.js";
import { checkSpawnDepth, checkCostCircuitBreaker, checkLoopDetection, isEmergencyStopActive, getSafetyConfig } from "../safety.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { getExtendedProjectConfig } from "../project.js";
import { classifyRisk } from "../risk/classifier.js";
import { getRiskConfig } from "../risk/config.js";
import { applyRiskGate } from "../risk/gate.js";
import { findRootInitiative, getInitiativeSpend } from "../goals/ops.js";
import { getTask, getTaskEvidence } from "../tasks/ops.js";
import { acquireTaskLease, releaseTaskLease } from "../tasks/ops.js";
import { ingestEvent } from "../events/store.js";
import { processEvents } from "../events/router.js";
import { claimNext, failItem, markDispatched, reclaimExpiredLeases } from "./queue.js";
import { dispatchViaCron } from "./cron-dispatch.js";
import { buildTaskPrompt } from "./spawn.js";
import { getApprovedIntentsForTask } from "../approval/intent-store.js";
import { recordMetric } from "../metrics.js";
import { writeAuditEntry } from "../audit.js";
import { isTaskInFuturePhase } from "../workflow.js";
import type { DispatchConfig, DispatchQueueItem } from "../types.js";

/** Task lease duration in milliseconds — long enough for async dispatch + execution + 5min buffer. */
const TASK_LEASE_MS = 2 * 60 * 60 * 1000 + 5 * 60 * 1000; // 2h + 5min buffer

// --- Concurrency tracking ---

/** Global hard ceiling across all projects. */
const DEFAULT_MAX_CONCURRENCY = 3;
let globalMaxConcurrency = DEFAULT_MAX_CONCURRENCY;
let globalActiveDispatches = 0;

/** Per-project active dispatch counts. */
const projectDispatches = new Map<string, number>();

/** Per-project dispatch timestamps for rate limiting (sliding window). */
const projectDispatchTimestamps = new Map<string, number[]>();

/** Per-agent active dispatch counts. */
const agentDispatches = new Map<string, number>();

/** Per-agent dispatch timestamps for rate limiting (sliding window). */
const agentDispatchTimestamps = new Map<string, number[]>();

const ONE_HOUR_MS = 60 * 60 * 1000;

/** Set the global maximum number of concurrent dispatches. */
export function setMaxConcurrency(max: number): void {
  globalMaxConcurrency = max;
}

/** Get current dispatch concurrency info. */
export function getConcurrencyInfo(): { active: number; max: number } {
  return { active: globalActiveDispatches, max: globalMaxConcurrency };
}

/** Get per-project dispatch rate info for ops visibility. */
export function getDispatchRateInfo(projectId: string): {
  active: number;
  recentHour: number;
  config: DispatchConfig | null;
} {
  pruneTimestamps(projectDispatchTimestamps, projectId);
  const extConfig = getExtendedProjectConfig(projectId);
  return {
    active: projectDispatches.get(projectId) ?? 0,
    recentHour: (projectDispatchTimestamps.get(projectId) ?? []).length,
    config: extConfig?.dispatch ?? null,
  };
}

/** Prune timestamps older than 1 hour from the sliding window. */
function pruneTimestamps(map: Map<string, number[]>, key: string): void {
  const timestamps = map.get(key);
  if (!timestamps) return;
  const cutoff = Date.now() - ONE_HOUR_MS;
  const pruned = timestamps.filter((t) => t > cutoff);
  if (pruned.length === 0) {
    map.delete(key);
  } else {
    map.set(key, pruned);
  }
}

/** Check if a project is at its concurrency or rate limit. Returns null if OK, or a reason string. */
function checkProjectLimits(projectId: string, config: DispatchConfig | undefined, db: DatabaseSync): string | null {
  if (config?.maxConcurrentDispatches != null) {
    // Use DB state for concurrency — counts items actively being processed (leased or dispatched)
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? AND status IN ('leased', 'dispatched')",
    ).get(projectId) as Record<string, unknown>;
    const active = (row.cnt as number) ?? 0;
    if (active >= config.maxConcurrentDispatches) {
      return `Project concurrency limit reached (${active}/${config.maxConcurrentDispatches})`;
    }
  }
  if (config?.maxDispatchesPerHour != null) {
    pruneTimestamps(projectDispatchTimestamps, projectId);
    const recentCount = (projectDispatchTimestamps.get(projectId) ?? []).length;
    if (recentCount >= config.maxDispatchesPerHour) {
      return `Project rate limit reached (${recentCount}/${config.maxDispatchesPerHour} per hour)`;
    }
  }
  return null;
}

/** Check if an agent is at its concurrency or rate limit. Returns null if OK, or a reason string. */
function checkAgentLimits(agentId: string, config: DispatchConfig | undefined): string | null {
  const agentLimits = config?.agentLimits?.[agentId];
  if (!agentLimits) return null;

  if (agentLimits.maxConcurrent != null) {
    const active = agentDispatches.get(agentId) ?? 0;
    if (active >= agentLimits.maxConcurrent) {
      return `Agent "${agentId}" concurrency limit reached (${active}/${agentLimits.maxConcurrent})`;
    }
  }
  if (agentLimits.maxPerHour != null) {
    pruneTimestamps(agentDispatchTimestamps, agentId);
    const recentCount = (agentDispatchTimestamps.get(agentId) ?? []).length;
    if (recentCount >= agentLimits.maxPerHour) {
      return `Agent "${agentId}" rate limit reached (${recentCount}/${agentLimits.maxPerHour} per hour)`;
    }
  }
  return null;
}

/** Record a successful dispatch in tracking maps. */
function recordDispatch(projectId: string, agentId: string): void {
  globalActiveDispatches++;
  projectDispatches.set(projectId, (projectDispatches.get(projectId) ?? 0) + 1);
  agentDispatches.set(agentId, (agentDispatches.get(agentId) ?? 0) + 1);

  const now = Date.now();
  const projTs = projectDispatchTimestamps.get(projectId) ?? [];
  projTs.push(now);
  projectDispatchTimestamps.set(projectId, projTs);

  const agentTs = agentDispatchTimestamps.get(agentId) ?? [];
  agentTs.push(now);
  agentDispatchTimestamps.set(agentId, agentTs);
}

/** Release a dispatch slot from tracking maps. */
function releaseDispatch(projectId: string, agentId: string): void {
  globalActiveDispatches--;
  const projCount = projectDispatches.get(projectId) ?? 0;
  if (projCount <= 1) projectDispatches.delete(projectId);
  else projectDispatches.set(projectId, projCount - 1);

  const agentCount = agentDispatches.get(agentId) ?? 0;
  if (agentCount <= 1) agentDispatches.delete(agentId);
  else agentDispatches.set(agentId, agentCount - 1);
}

/**
 * Run a single pass of the dispatch loop:
 * 1. Reclaim expired leases
 * 2. Check project-level concurrency/rate limits
 * 3. Claim next queued item
 * 4. Check agent-level limits
 * 5. Acquire task lease
 * 6. Dispatch agent
 * 7. Complete/fail queue item
 *
 * Returns the number of items dispatched in this pass.
 */
export async function dispatchLoop(
  projectId: string,
  dbOverride?: DatabaseSync,
): Promise<number> {
  const db = dbOverride ?? getDb(projectId);
  let dispatched = 0;

  // Reclaim expired leases first
  reclaimExpiredLeases(projectId, db);

  const extConfig = getExtendedProjectConfig(projectId);
  const dispatchConfig = extConfig?.dispatch;

  // Use DB-based active count for global ceiling (resilient to process restarts)
  const getGlobalActiveCount = () => {
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM dispatch_queue WHERE status IN ('leased', 'dispatched')",
    ).get() as Record<string, unknown>;
    return (row.cnt as number) ?? 0;
  };

  while (getGlobalActiveCount() < globalMaxConcurrency) {
    // Check project-level limits before claiming
    const projectLimitReason = checkProjectLimits(projectId, dispatchConfig, db);
    if (projectLimitReason) {
      // Project rate-limited — items stay queued for next pass
      break;
    }

    const item = claimNext(projectId, undefined, undefined, db);
    if (!item) break;

    // Resolve agentId early for per-agent limit check
    const task = getTask(projectId, item.taskId, db);
    const payload = item.payload ?? {};
    const agentId = task?.assignedTo ?? (payload.profile ? `claude-code:${payload.profile as string}` : "claude-code:worker");

    // Check per-agent limits
    const agentLimitReason = checkAgentLimits(agentId, dispatchConfig);
    if (agentLimitReason) {
      failItem(item.id, agentLimitReason, db, projectId);
      emitDispatchEvent(projectId, "dispatch_failed", item, { error: agentLimitReason, rateLimited: true }, db);
      try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "agent_rate_limited" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
      dispatched++;
      continue;
    }

    recordDispatch(projectId, agentId);
    try {
      await dispatchItem(projectId, item, db, agentId);
      dispatched++;
    } finally {
      releaseDispatch(projectId, agentId);
    }
  }

  if (dispatched > 0) {
    try {
      recordMetric({ projectId, type: "dispatch", subject: projectId, key: "dispatch_loop_pass", value: dispatched, unit: "count" }, db);
    } catch (err) { safeLog("dispatcher.loopMetric", err); }
  }

  return dispatched;
}

async function dispatchItem(
  projectId: string,
  item: DispatchQueueItem,
  db: DatabaseSync,
  resolvedAgentId: string,
): Promise<void> {
  // Emergency stop — blocks everything
  if (isEmergencyStopActive(projectId, db)) {
    failItem(item.id, "Emergency stop active — all dispatches blocked", db, projectId);
    emitDispatchEvent(projectId, "dispatch_failed", item, { error: "Emergency stop active", safetyLimit: "emergency_stop" }, db);
    try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "emergency_stop" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
    return;
  }

  // Pre-dispatch budget check: single v2 call covers all windows + dimensions + reservations
  try {
    const budgetResult = checkBudgetV2({ projectId, agentId: resolvedAgentId }, db);
    if (!budgetResult.ok) {
      failItem(item.id, `Budget exceeded: ${budgetResult.reason}`, db, projectId);
      emitDispatchEvent(projectId, "dispatch_failed", item, { error: budgetResult.reason, budgetExceeded: true }, db);
      try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "budget_exceeded" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
      return;
    }
  } catch (err) {
    safeLog("dispatcher.budgetCheck", err);
    // Budget check failure is non-fatal — proceed with dispatch
  }

  // Session/task per-record budget checks (bounded O(n) scope)
  try {
    const profileVal = item.payload?.profile as string | undefined;
    const agentId = profileVal ? `claude-code:${profileVal}` : undefined;
    const sessionKey = item.payload?.sessionKey as string | undefined;
    if (sessionKey || item.taskId) {
      const perRecordResult = checkBudget({ projectId, agentId, taskId: item.taskId, sessionKey }, db);
      if (!perRecordResult.ok) {
        failItem(item.id, `Budget exceeded: ${perRecordResult.reason}`, db, projectId);
        emitDispatchEvent(projectId, "dispatch_failed", item, { error: perRecordResult.reason, budgetExceeded: true }, db);
        try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "budget_exceeded" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
        return;
      }
    }
  } catch (err) {
    safeLog("dispatcher.perRecordBudgetCheck", err);
  }

  // Provider rate limit gate
  try {
    const provider = (item.payload?.provider as string) ?? "anthropic";
    if (isProviderThrottled(provider, 95)) {
      failItem(item.id, `Provider ${provider} rate limit exceeded (>95% used)`, db, projectId);
      emitDispatchEvent(projectId, "dispatch_failed", item, { error: `rate_limit_${provider}`, rateLimited: true }, db);
      try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "rate_limited" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
      return;
    }
  } catch (err) {
    safeLog("dispatcher.rateLimitCheck", err);
  }

  // Safety checks: spawn depth, cost circuit breaker, loop detection
  try {
    const spawnCheck = checkSpawnDepth(projectId, item.taskId, db);
    if (!spawnCheck.ok) {
      failItem(item.id, spawnCheck.reason, db, projectId);
      emitDispatchEvent(projectId, "dispatch_failed", item, { error: spawnCheck.reason, safetyLimit: "spawn_depth" }, db);
      try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "spawn_depth" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
      return;
    }

    const circuitBreaker = checkCostCircuitBreaker(projectId, resolvedAgentId, db);
    if (!circuitBreaker.ok) {
      failItem(item.id, circuitBreaker.reason, db, projectId);
      emitDispatchEvent(projectId, "dispatch_failed", item, { error: circuitBreaker.reason, safetyLimit: "cost_circuit_breaker" }, db);
      try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "cost_circuit_breaker" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
      return;
    }

    const task = getTask(projectId, item.taskId, db);
    if (task) {
      const loopCheck = checkLoopDetection(projectId, task.title, db);
      if (!loopCheck.ok) {
        failItem(item.id, loopCheck.reason, db, projectId);
        emitDispatchEvent(projectId, "dispatch_failed", item, { error: loopCheck.reason, safetyLimit: "loop_detection" }, db);
        try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "loop_detection" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
        return;
      }
    }
  } catch (err) {
    safeLog("dispatcher.safetyCheck", err);
    // Safety check failure is non-fatal — proceed with dispatch
  }

  // Risk-aware dispatch check
  try {
    const extConfig = getExtendedProjectConfig(projectId);
    const riskConfig = getRiskConfig(extConfig?.riskTiers);
    if (riskConfig.enabled) {
      const classification = classifyRisk({
        actionType: "dispatch",
        actor: `dispatcher:${item.id}`,
      }, riskConfig);

      if (classification.tier !== "low") {
        const gateResult = applyRiskGate({
          projectId,
          actionType: "dispatch",
          actionDetail: `dispatch task ${item.taskId}`,
          actor: `dispatcher:${item.id}`,
          classification,
          config: riskConfig,
          dbOverride: db,
        });

        if (gateResult.action === "block" || gateResult.action === "require_approval") {
          const reason = gateResult.action === "block"
            ? gateResult.reason
            : `Dispatch requires approval (risk tier: ${classification.tier})`;
          failItem(item.id, reason, db, projectId);
          emitDispatchEvent(projectId, "dispatch_failed", item, { error: reason, riskGated: true }, db);
          try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "risk_gate" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
          return;
        }
      }
    }
  } catch (err) {
    safeLog("dispatcher.riskCheck", err);
    // Risk check failure is non-fatal
  }

  const task = getTask(projectId, item.taskId, db);
  if (!task) {
    failItem(item.id, `Task not found: ${item.taskId}`, db, projectId);
    emitDispatchEvent(projectId, "dispatch_failed", item, { error: `Task not found: ${item.taskId}` }, db);
    try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts, reason: "task_not_found" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
    return;
  }

  // Only dispatch tasks in dispatchable states
  if (task.state !== "ASSIGNED" && task.state !== "IN_PROGRESS") {
    failItem(item.id, `Task in non-dispatchable state: ${task.state}`, db, projectId);
    emitDispatchEvent(projectId, "dispatch_failed", item, { error: `Task in non-dispatchable state: ${task.state}` }, db);
    try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts, reason: "non_dispatchable_state" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
    return;
  }

  // Workflow phase gate (defense-in-depth)
  const phaseGate = isTaskInFuturePhase(task, db);
  if (phaseGate.blocked) {
    failItem(item.id, `Workflow phase gate: ${phaseGate.reason}`, db, projectId);
    emitDispatchEvent(projectId, "dispatch_failed", item, { error: phaseGate.reason, phaseGated: true }, db);
    try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "phase_gate" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
    return;
  }

  // Acquire task lease (long lease — released in agent_end hook)
  const holder = `dispatch:${item.id}`;
  const leaseOk = acquireTaskLease(projectId, item.taskId, holder, TASK_LEASE_MS, db);
  if (!leaseOk) {
    failItem(item.id, "Could not acquire task lease — another agent holds it", db, projectId);
    emitDispatchEvent(projectId, "dispatch_failed", item, { error: "Could not acquire task lease" }, db);
    try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts, reason: "lease_conflict" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
    return;
  }

  // Git isolation: create branch for this task
  try {
    const { getEffectiveVerificationConfig } = require("../verification/lifecycle.js") as typeof import("../verification/lifecycle.js");
    const verConfig = getEffectiveVerificationConfig(projectId);
    if (verConfig.git?.enabled) {
      const { getAgentConfig: getAgentCfg } = require("../project.js") as typeof import("../project.js");
      const cfEntry = getAgentCfg(resolvedAgentId);
      const projectDir = cfEntry?.projectDir;
      if (projectDir) {
        const { createTaskBranch } = require("../verification/git.js") as typeof import("../verification/git.js");
        const branchResult = createTaskBranch(
          projectDir,
          item.taskId,
          verConfig.git.base_branch,
          verConfig.git.branch_pattern,
        );
        if (branchResult.ok && branchResult.branchName) {
          // Store branch name in task metadata for later merge
          try {
            db.prepare(
              "UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.branchName', ?) WHERE id = ? AND project_id = ?",
            ).run(branchResult.branchName, item.taskId, projectId);
          } catch { /* non-fatal */ }
        }
      }
    }
  } catch (err) {
    safeLog("dispatcher.gitBranch", err);
  }

  try {
    // Extract dispatch params from queue item payload
    const payload = item.payload ?? {};
    const userPrompt = (payload.prompt as string) ?? `Execute task: ${task.title}`;
    const model = payload.model as string | undefined;
    const timeoutMs = payload.timeoutMs as number | undefined;

    // Build full prompt (task context + retry context + pre-approvals)
    const prompt = buildTaskPrompt(task, userPrompt);
    const retryContext = buildRetryContext(projectId, item.taskId, db);
    const preApprovalContext = buildPreApprovalContext(projectId, item.taskId, db);
    const extras = [retryContext, preApprovalContext].filter(Boolean).join("\n\n");
    const fullPrompt = extras ? `${prompt}\n\n${extras}` : prompt;

    // Apply maxSessionDurationMs as default timeout if none specified
    let effectiveTimeoutSeconds = timeoutMs ? Math.ceil(timeoutMs / 1000) : undefined;
    if (!effectiveTimeoutSeconds) {
      try {
        const safetyConfig = getSafetyConfig(projectId);
        if (safetyConfig.maxSessionDurationMs) {
          effectiveTimeoutSeconds = Math.ceil(safetyConfig.maxSessionDurationMs / 1000);
        }
      } catch { /* non-fatal */ }
    }

    const result = await dispatchViaCron({
      queueItemId: item.id,
      taskId: item.taskId,
      projectId,
      prompt: fullPrompt,
      agentId: resolvedAgentId,
      model,
      timeoutSeconds: effectiveTimeoutSeconds,
    });

    if (result.ok) {
      // Cron job created — mark as dispatched (completion handled in agent_end hook)
      markDispatched(item.id, db, projectId);
      emitDispatchEvent(projectId, "dispatch_succeeded", item, { cronJobName: result.cronJobName }, db);
      try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_cron_created", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
    } else {
      const error = result.error ?? "Unknown dispatch error";
      failItem(item.id, error, db, projectId);
      emitDispatchEvent(projectId, "dispatch_failed", item, { error }, db);
      maybeEmitDeadLetter(projectId, item, error, db);
      try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts, reason: "cron_error" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
      // Release lease on failure — no session will run
      try { releaseTaskLease(projectId, item.taskId, holder, db); } catch (err) { safeLog("dispatcher.releaseLease", err); }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failItem(item.id, message, db, projectId);
    emitDispatchEvent(projectId, "dispatch_failed", item, { error: message }, db);
    maybeEmitDeadLetter(projectId, item, message, db);
    try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts, reason: "exception" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
    // Release lease on failure
    try { releaseTaskLease(projectId, item.taskId, holder, db); } catch (releaseErr) { safeLog("dispatcher.releaseLease", releaseErr); }
  }
}

function emitDispatchEvent(
  projectId: string,
  type: "dispatch_succeeded" | "dispatch_failed",
  item: DispatchQueueItem,
  extra: Record<string, unknown>,
  db: DatabaseSync,
): void {
  try {
    ingestEvent(projectId, type, "internal", {
      taskId: item.taskId,
      queueItemId: item.id,
      attempt: item.dispatchAttempts,
      maxAttempts: item.maxDispatchAttempts,
      ...extra,
    }, `${type}:${item.id}:${item.dispatchAttempts}`, db);
  } catch (err) {
    safeLog("dispatcher.emitEvent", err);
  }
}

/**
 * Emit a dispatch_dead_letter event if the item has exhausted its max dispatch attempts.
 * The item's dispatchAttempts reflects the count at claim time, so it equals maxDispatchAttempts
 * on the final attempt.
 */
function maybeEmitDeadLetter(
  projectId: string,
  item: DispatchQueueItem,
  lastError: string,
  db: DatabaseSync,
): void {
  if (item.dispatchAttempts >= item.maxDispatchAttempts) {
    try {
      ingestEvent(projectId, "dispatch_dead_letter", "internal", {
        taskId: item.taskId,
        queueItemId: item.id,
        attempts: item.dispatchAttempts,
        lastError,
      }, `dead-letter:${item.id}`, db);
    } catch (err) {
      safeLog("dispatcher.deadLetter", err);
    }

    try {
      recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_dead_letter", value: 1, tags: { queueItemId: item.id, attempts: item.dispatchAttempts } }, db);
    } catch (err) { safeLog("dispatcher.deadLetter.metric", err); }

    try {
      writeAuditEntry({ projectId, actor: "system:dispatch", action: "dispatch.dead_letter", targetType: "task", targetId: item.taskId, detail: JSON.stringify({ queueItemId: item.id, attempts: item.dispatchAttempts, lastError: lastError.slice(0, 500) }) }, db);
    } catch (err) { safeLog("dispatcher.deadLetter.audit", err); }
  }
}

/**
 * Build context from previous failed attempts to help retried dispatches
 * avoid repeating the same mistakes.
 */
export function buildRetryContext(
  projectId: string,
  taskId: string,
  db: DatabaseSync,
): string | null {
  const failedTransition = db.prepare(
    `SELECT reason, created_at FROM transitions
     WHERE task_id = ? AND to_state = 'FAILED'
     ORDER BY created_at DESC LIMIT 1`,
  ).get(taskId) as Record<string, unknown> | undefined;

  if (!failedTransition) return null;

  const evidence = getTaskEvidence(projectId, taskId, db);
  const lastEvidence = evidence[evidence.length - 1];

  const parts = ["## Previous Attempt Context"];
  parts.push(`**Failure reason:** ${(failedTransition.reason as string) ?? "Unknown"}`);
  if (lastEvidence) {
    const preview = lastEvidence.content.slice(0, 1000);
    parts.push(`**Last output (truncated):**\n\`\`\`\n${preview}\n\`\`\``);
  }
  parts.push("Use this context to avoid repeating the same mistakes.");
  return parts.join("\n");
}

/**
 * Build pre-approval context for re-dispatched tasks.
 * Tells the agent which tool calls have been pre-approved.
 */
function buildPreApprovalContext(
  projectId: string,
  taskId: string,
  db: DatabaseSync,
): string | null {
  try {
    const intents = getApprovedIntentsForTask(projectId, taskId, db);
    if (intents.length === 0) return null;

    const lines = ["## Pre-Approved Actions", "The following tool calls have been pre-approved. You may proceed with them:"];
    for (const intent of intents) {
      const ageMs = Date.now() - (intent.resolvedAt ?? intent.createdAt);
      const agoMin = Math.round(ageMs / 60_000);
      lines.push(`- \`${intent.toolName}\` (category: ${intent.category}) — approved ${agoMin}m ago`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

/**
 * Convenience entry point: process events then run dispatch loop.
 * Used by sweep as a backstop and by the process_events tool action.
 */
export async function processAndDispatch(
  projectId: string,
  dbOverride?: DatabaseSync,
): Promise<{ eventsProcessed: number; dispatched: number }> {
  const db = dbOverride ?? getDb(projectId);
  const eventsProcessed = processEvents(projectId, db);
  const dispatched = await dispatchLoop(projectId, db);
  return { eventsProcessed, dispatched };
}

/** Reset concurrency counters (for testing). */
export function resetDispatcherForTest(): void {
  globalActiveDispatches = 0;
  globalMaxConcurrency = DEFAULT_MAX_CONCURRENCY;
  projectDispatches.clear();
  projectDispatchTimestamps.clear();
  agentDispatches.clear();
  agentDispatchTimestamps.clear();
}

/**
 * Pre-dispatch gate: checks multi-window budget and provider rate limits.
 * Call this before dispatching an agent session to ensure resource availability.
 */
export function shouldDispatch(
  projectId: string,
  agentId: string,
  provider: string = "anthropic",
  options?: { taskId?: string },
): { ok: true } | { ok: false; reason: string } {
  // Emergency stop — blocks everything
  if (isEmergencyStopActive(projectId)) {
    return { ok: false, reason: "Emergency stop active — all dispatches blocked" };
  }

  // Check multi-window budget via v2 (hourly / daily / monthly + all dimensions)
  const budgetDb = getDb(projectId);
  const budgetResult = checkBudgetV2({ projectId, agentId }, budgetDb);
  if (!budgetResult.ok) {
    return { ok: false, reason: budgetResult.reason! };
  }

  // Check provider rate limits
  if (isProviderThrottled(provider, 95)) {
    return { ok: false, reason: `Provider ${provider} rate limit exceeded (>95% used)` };
  }

  // Check initiative budget if task is specified
  if (options?.taskId) {
    try {
      const initiativeResult = checkInitiativeBudget(projectId, options.taskId);
      if (!initiativeResult.ok) {
        return initiativeResult;
      }
    } catch (err) {
      safeLog("dispatcher.initiativeBudgetCheck", err);
    }
  }

  return { ok: true };
}

function checkInitiativeBudget(
  projectId: string,
  taskId: string,
): { ok: true } | { ok: false; reason: string } {
  const db = getDb(projectId);

  // Look up task's goal_id
  const task = db.prepare(
    "SELECT goal_id FROM tasks WHERE id = ? AND project_id = ?",
  ).get(taskId, projectId) as { goal_id: string | null } | undefined;

  if (!task?.goal_id) return { ok: true }; // No goal = no initiative gate

  // Walk up to root initiative
  const initiative = findRootInitiative(projectId, task.goal_id);
  if (!initiative?.allocation) return { ok: true }; // No allocation = no gate

  // Get project daily budget
  const budget = db.prepare(
    "SELECT daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(projectId) as { daily_limit_cents: number } | undefined;

  if (!budget) return { ok: true }; // No project budget = no gate

  const allocationCents = Math.floor((initiative.allocation / 100) * budget.daily_limit_cents);
  const spentCents = getInitiativeSpend(projectId, initiative.id);

  if (spentCents >= allocationCents) {
    return {
      ok: false,
      reason: `Initiative "${initiative.title}" budget exceeded: spent ${spentCents}c of ${allocationCents}c allocation (${initiative.allocation}% of ${budget.daily_limit_cents}c daily budget)`,
    };
  }

  return { ok: true };
}
