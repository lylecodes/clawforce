/**
 * Clawforce — Dispatch loop
 *
 * Claims items from the dispatch queue, acquires task leases,
 * spawns agents, and completes/fails queue items.
 * Per-project and per-agent concurrency + rate limiting.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import { checkBudget } from "../budget.js";
import { checkBudgetV2 } from "../budget/check-v2.js";
import { isProviderThrottled } from "../rate-limits.js";
import { checkSpawnDepth, checkCostCircuitBreaker, checkLoopDetection, isEmergencyStopActive, getSafetyConfig } from "../safety.js";
import { isAgentEffectivelyDisabled, isDomainDisabled } from "../enforcement/disabled-store.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { getExtendedProjectConfig } from "../project.js";
import { classifyRisk } from "../risk/classifier.js";
import { getRiskConfig } from "../risk/config.js";
import { applyRiskGate } from "../risk/gate.js";
import { findRootInitiative, getInitiativeSpend } from "../goals/ops.js";
import { attachEvidence, getTask, getTaskEvidence, transitionTask } from "../tasks/ops.js";
import { acquireTaskLease, releaseTaskLease } from "../tasks/ops.js";
import { getAgentConfig } from "../project.js";
import { getEffectiveVerificationConfig } from "../verification/lifecycle.js";
import { createTaskBranch } from "../verification/git.js";
import { ingestEvent } from "../events/store.js";
import { processEvents } from "../events/router.js";
import { claimNext, completeItem, failItem, getQueueItem, markDispatched, reclaimExpiredLeases, releaseToQueued } from "./queue.js";
import { executeDispatch } from "./executors.js";
import { buildTaskPrompt } from "./spawn.js";
import { getApprovedIntentsForTask } from "../approval/intent-store.js";
import { recordMetric } from "../metrics.js";
import { writeAuditEntry } from "../audit.js";
import { isTaskInFuturePhase } from "../workflow.js";
import type { DispatchConfig, DispatchQueueItem } from "../types.js";
import { computeBudgetPacing } from "../budget/pacer.js";
import { getDefaultRuntimeState } from "../runtime/default-runtime.js";
import { resolveDispatchExecutorName } from "./executors.js";
import { withControllerLease } from "../runtime/controller-leases.js";
import { getSessionArchive } from "../telemetry/session-archive.js";
import { maybeNormalizeWorkflowMutationImplementationTask } from "../workflow-mutation/implementation.js";
import { resolveEffectiveConfig } from "../jobs.js";
import { maybeNormalizeRecurringJobTask } from "../scheduling/recurring-jobs.js";

/** Task lease duration in milliseconds — long enough for async dispatch + execution + 5min buffer. */
const TASK_LEASE_MS = 2 * 60 * 60 * 1000 + 5 * 60 * 1000; // 2h + 5min buffer

/** Default per-agent dispatch rate limit when no explicit limit is configured. */
const DEFAULT_AGENT_DISPATCH_LIMIT = 15; // per hour

/**
 * Sentinel error thrown when the cron service is unavailable.
 * Caught by dispatchLoop to abort the current pass gracefully
 * (items already released back to queued).
 */
class CronUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronUnavailableError";
  }
}

// --- Concurrency tracking ---

/** Global hard ceiling across all projects. */
const DEFAULT_MAX_CONCURRENCY = 3;
const ONE_HOUR_MS = 60 * 60 * 1000;

type DispatcherRuntimeState = {
  globalMaxConcurrency: number;
  globalActiveDispatches: number;
  projectDispatches: Map<string, number>;
  projectDispatchTimestamps: Map<string, number[]>;
  agentDispatches: Map<string, number>;
  agentDispatchTimestamps: Map<string, number[]>;
};

const runtime = getDefaultRuntimeState();

function getDispatcherState(): DispatcherRuntimeState {
  return runtime.dispatch as DispatcherRuntimeState;
}

/** Set the global maximum number of concurrent dispatches. */
export function setMaxConcurrency(max: number): void {
  getDispatcherState().globalMaxConcurrency = max;
}

/** Get current dispatch concurrency info. */
export function getConcurrencyInfo(): { active: number; max: number } {
  const state = getDispatcherState();
  return { active: state.globalActiveDispatches, max: state.globalMaxConcurrency };
}

/** Get per-project dispatch rate info for ops visibility. */
export function getDispatchRateInfo(projectId: string): {
  active: number;
  recentHour: number;
  config: DispatchConfig | null;
} {
  const state = getDispatcherState();
  pruneTimestamps(state.projectDispatchTimestamps, projectId);
  const extConfig = getExtendedProjectConfig(projectId);
  return {
    active: state.projectDispatches.get(projectId) ?? 0,
    recentHour: (state.projectDispatchTimestamps.get(projectId) ?? []).length,
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
  const state = getDispatcherState();
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
    pruneTimestamps(state.projectDispatchTimestamps, projectId);
    const recentCount = (state.projectDispatchTimestamps.get(projectId) ?? []).length;
    if (recentCount >= config.maxDispatchesPerHour) {
      return `Project rate limit reached (${recentCount}/${config.maxDispatchesPerHour} per hour)`;
    }
  }
  return null;
}

/** Check if an agent is at its concurrency or rate limit. Returns null if OK, or a reason string. */
function checkAgentLimits(agentId: string, config: DispatchConfig | undefined): string | null {
  const state = getDispatcherState();
  const agentLimits = config?.agentLimits?.[agentId];

  if (agentLimits?.maxConcurrent != null) {
    const active = state.agentDispatches.get(agentId) ?? 0;
    if (active >= agentLimits.maxConcurrent) {
      return `Agent "${agentId}" concurrency limit reached (${active}/${agentLimits.maxConcurrent})`;
    }
  }

  // Rate limit: use explicit per-agent limit if configured, otherwise apply default
  const effectiveMaxPerHour = agentLimits?.maxPerHour ?? DEFAULT_AGENT_DISPATCH_LIMIT;
  pruneTimestamps(state.agentDispatchTimestamps, agentId);
  const recentCount = (state.agentDispatchTimestamps.get(agentId) ?? []).length;
  if (recentCount >= effectiveMaxPerHour) {
    return `Agent "${agentId}" rate limit reached (${recentCount}/${effectiveMaxPerHour} per hour)`;
  }
  return null;
}

/** Record a successful dispatch in tracking maps. */
function recordDispatch(projectId: string, agentId: string): void {
  const state = getDispatcherState();
  state.globalActiveDispatches++;
  state.projectDispatches.set(projectId, (state.projectDispatches.get(projectId) ?? 0) + 1);
  state.agentDispatches.set(agentId, (state.agentDispatches.get(agentId) ?? 0) + 1);

  const now = Date.now();
  const projTs = state.projectDispatchTimestamps.get(projectId) ?? [];
  projTs.push(now);
  state.projectDispatchTimestamps.set(projectId, projTs);

  const agentTs = state.agentDispatchTimestamps.get(agentId) ?? [];
  agentTs.push(now);
  state.agentDispatchTimestamps.set(agentId, agentTs);
}

/** Release a dispatch slot from tracking maps. */
function releaseDispatch(projectId: string, agentId: string): void {
  const state = getDispatcherState();
  state.globalActiveDispatches--;
  const projCount = state.projectDispatches.get(projectId) ?? 0;
  if (projCount <= 1) state.projectDispatches.delete(projectId);
  else state.projectDispatches.set(projectId, projCount - 1);

  const agentCount = state.agentDispatches.get(agentId) ?? 0;
  if (agentCount <= 1) state.agentDispatches.delete(agentId);
  else state.agentDispatches.set(agentId, agentCount - 1);
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

  // Apply global max concurrency from config if set
  const effectiveMaxConcurrency = dispatchConfig?.globalMaxConcurrency ?? getDispatcherState().globalMaxConcurrency;

  // Use DB-based active count for global ceiling (resilient to process restarts)
  const getGlobalActiveCount = () => {
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM dispatch_queue WHERE status IN ('leased', 'dispatched')",
    ).get() as Record<string, unknown>;
    return (row.cnt as number) ?? 0;
  };

  while (getGlobalActiveCount() < effectiveMaxConcurrency) {
    // Check project-level limits before claiming
    const projectLimitReason = checkProjectLimits(projectId, dispatchConfig, db);
    if (projectLimitReason) {
      // Project rate-limited — items stay queued for next pass
      break;
    }

    const item = claimNext(projectId, undefined, undefined, db);
    if (!item) break;

    // Resolve agentId early for per-agent limit check
    // Payload can override agent (e.g. verifier dispatch targets a different agent than the task assignee)
    const agentId = resolveDispatchAgentId(projectId, item, db);

    // Check per-agent limits
    const agentLimitReason = checkAgentLimits(agentId, dispatchConfig);
    if (agentLimitReason) {
      failItem(item.id, agentLimitReason, db, projectId);
      emitDispatchEvent(projectId, "dispatch_failed", item, { error: agentLimitReason, rateLimited: true }, db);
      try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "agent_rate_limited" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
      dispatched++;
      continue;
    }

    // Check if domain is disabled — blocks all dispatches for this project
    if (isDomainDisabled(projectId, db)) {
      failItem(item.id, "Domain is disabled — all dispatches blocked", db, projectId);
      emitDispatchEvent(projectId, "dispatch_failed", item, { error: "Domain is disabled", safetyLimit: "domain_disabled" }, db);
      try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "domain_disabled" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
      dispatched++;
      continue;
    }

    // Check if the target agent is disabled (individually, by team, or by department)
    if (isAgentEffectivelyDisabled(projectId, agentId, db)) {
      failItem(item.id, `Agent "${agentId}" is disabled — dispatch blocked`, db, projectId);
      emitDispatchEvent(projectId, "dispatch_failed", item, { error: `Agent "${agentId}" is disabled`, safetyLimit: "agent_disabled" }, db);
      try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "agent_disabled" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
      dispatched++;
      continue;
    }

    recordDispatch(projectId, agentId);
    try {
      await dispatchItem(projectId, item, db, agentId);
      dispatched++;
    } catch (err) {
      if (err instanceof CronUnavailableError) {
        // Cron service unavailable — item already released to queued.
        // Abort the dispatch loop; items will be retried on next sweep pass.
        safeLog("dispatcher.cronUnavailable", "Cron service unavailable — aborting dispatch loop for this pass");
        break;
      }
      throw err;
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

function resolveDispatchAgentId(
  projectId: string,
  item: DispatchQueueItem,
  db: DatabaseSync,
): string {
  const task = getTask(projectId, item.taskId, db);
  const payload = item.payload ?? {};
  const candidateAgentId = typeof payload.agentId === "string"
    ? payload.agentId
    : task?.assignedTo;
  const executor = resolveDispatchExecutorName(projectId, candidateAgentId);
  const syntheticPrefix = executor === "openclaw" ? "dispatch" : executor;
  return (payload.agentId as string | undefined)
    ?? task?.assignedTo
    ?? (payload.profile ? `${syntheticPrefix}:${payload.profile as string}` : `${syntheticPrefix}:worker`);
}

function maybeFinalizeInlineTask(
  projectId: string,
  taskId: string,
  leaseHolder: string,
  actor: string,
  executor: string,
  summary: string | undefined,
  db: DatabaseSync,
): { ok: boolean; reason?: string } {
  const task = getTask(projectId, taskId, db);
  if (!task) return { ok: false, reason: "Task missing during inline finalization" };
  if (task.state !== "ASSIGNED" && task.state !== "IN_PROGRESS") return { ok: true };
  if (!summary?.trim()) return { ok: false, reason: "Inline dispatch returned no summary" };

  const releaseLease = (holder: string | null | undefined): boolean => {
    if (!holder) return false;
    try {
      return releaseTaskLease(projectId, taskId, holder, db);
    } catch (err) {
      safeLog("dispatcher.inlineReleaseLease", err);
      return false;
    }
  };

  const readLeaseHolder = (): string | null => {
    const row = db.prepare(
      "SELECT lease_holder FROM tasks WHERE id = ? AND project_id = ?",
    ).get(taskId, projectId) as { lease_holder?: string | null } | undefined;
    return row?.lease_holder ?? null;
  };

  const transitionIntoProgress = (transitionActor: string) => transitionTask({
    projectId,
    taskId,
    toState: "IN_PROGRESS",
    actor: transitionActor,
    verificationRequired: false,
  }, db);

  let activeLeaseHolder: string | null = readLeaseHolder();
  releaseLease(leaseHolder);
  activeLeaseHolder = readLeaseHolder();

  let transitionActor = actor;
  try {
    if (task.state === "ASSIGNED") {
      let started = transitionIntoProgress(transitionActor);
      if (!started.ok && activeLeaseHolder) {
        releaseLease(activeLeaseHolder);
        activeLeaseHolder = readLeaseHolder();
        started = transitionIntoProgress(transitionActor);
      }
      if (!started.ok && activeLeaseHolder) {
        transitionActor = activeLeaseHolder;
        started = transitionIntoProgress(transitionActor);
      }
      if (!started.ok) {
        safeLog("dispatcher.inlineStart", started.reason);
        return { ok: false, reason: started.reason ?? "Inline dispatch could not start task progress" };
      }
    }
  } finally {
    const currentLeaseHolder = readLeaseHolder();
    if (currentLeaseHolder) {
      releaseLease(currentLeaseHolder);
    }
  }

  let evidenceId: string | undefined;
  try {
    const evidence = attachEvidence({
      projectId,
      taskId,
      type: "output",
      content: summary.trim(),
      attachedBy: `system:inline-dispatch:${executor}`,
    }, db);
    evidenceId = evidence.id;
  } catch (err) {
    safeLog("dispatcher.inlineEvidence", err);
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const recurringJob = task.metadata
    && typeof task.metadata === "object"
    && !Array.isArray(task.metadata)
    && typeof (task.metadata as Record<string, unknown>).recurringJob === "object"
    ? (task.metadata as Record<string, unknown>).recurringJob
    : null;

  if (recurringJob) {
    const review = transitionTask({
      projectId,
      taskId,
      toState: "REVIEW",
      actor: transitionActor,
      evidenceId,
      verificationRequired: false,
    }, db);
    if (!review.ok) {
      safeLog("dispatcher.inlineRecurringReview", review.reason);
      return { ok: false, reason: review.reason ?? "Inline dispatch could not move recurring workflow task to review" };
    }

    const done = transitionTask({
      projectId,
      taskId,
      toState: "DONE",
      actor: transitionActor,
      verificationRequired: false,
      reason: "Recurring workflow run completed",
    }, db);
    if (!done.ok) {
      safeLog("dispatcher.inlineRecurringDone", done.reason);
      return { ok: false, reason: done.reason ?? "Inline dispatch could not complete recurring workflow task" };
    }
    return { ok: true };
  }

  const review = transitionTask({
    projectId,
    taskId,
    toState: "REVIEW",
    actor: transitionActor,
    evidenceId,
    verificationRequired: false,
  }, db);
  if (!review.ok) {
    safeLog("dispatcher.inlineReview", review.reason);
    return { ok: false, reason: review.reason ?? "Inline dispatch could not move task to review" };
  }

  return { ok: true };
}

function recoverInlineSummary(
  projectId: string,
  sessionKey: string | undefined,
  summary: string | undefined,
  db: DatabaseSync,
): string | undefined {
  if (summary?.trim()) return summary.trim();
  if (!sessionKey) return undefined;
  const archived = getSessionArchive(projectId, sessionKey, db);
  const transcript = archived?.transcript?.trim() || undefined;
  if (!transcript) return buildFallbackInlineSummary(sessionKey);
  if (looksLikeCodexLaunchTranscript(transcript)) return buildFallbackInlineSummary(sessionKey);
  return transcript;
}

function buildFallbackInlineSummary(sessionKey: string): string {
  return [
    "**Completed**",
    "",
    `Executor session ${sessionKey} exited successfully but returned no final summary.`,
    "Review any changed files and archived session detail before approving this task.",
  ].join("\n");
}

function lacksSubstantiveInlineResult(result: {
  summarySynthetic?: boolean;
  observedWork?: boolean;
}): boolean {
  return result.summarySynthetic === true && result.observedWork === false;
}

function shouldAutoRequeueInlineNoop(
  item: DispatchQueueItem,
  reason: string | undefined,
): boolean {
  return reason === "Inline dispatch exited successfully without a final summary or observed work"
    && item.dispatchAttempts === 1;
}

function markInlineNoopRetryPayload(
  item: DispatchQueueItem,
  executor: string,
  db: DatabaseSync,
): void {
  if (executor !== "codex") return;
  const payload = { ...(item.payload ?? {}) };
  if (payload.disableMcpBridge === true) return;
  payload.disableMcpBridge = true;
  db.prepare(
    "UPDATE dispatch_queue SET payload = ? WHERE id = ?",
  ).run(JSON.stringify(payload), item.id);
}

function looksLikeCodexLaunchTranscript(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trimmed.startsWith("Reading additional input from stdin...\nOpenAI Codex v")
    || (
      trimmed.startsWith("OpenAI Codex v")
      && trimmed.includes("<task-metadata")
      && !trimmed.includes("**Completed**")
      && !trimmed.includes("**Done**")
    );
}

export async function dispatchLeasedItem(
  projectId: string,
  queueItemId: string,
  dbOverride?: DatabaseSync,
): Promise<{ ok: boolean; queueStatus?: string; error?: string }> {
  const db = dbOverride ?? getDb(projectId);
  const item = getQueueItem(projectId, queueItemId, db);
  if (!item) {
    return { ok: false, error: `Queue item not found: ${queueItemId}` };
  }
  if (item.status !== "leased") {
    return { ok: false, queueStatus: item.status, error: `Queue item ${queueItemId} is not leased` };
  }

  const agentId = resolveDispatchAgentId(projectId, item, db);
  recordDispatch(projectId, agentId);
  try {
    await dispatchItem(projectId, item, db, agentId);
  } catch (err) {
    if (err instanceof CronUnavailableError) {
      return { ok: false, queueStatus: "queued", error: err.message };
    }
    throw err;
  } finally {
    releaseDispatch(projectId, agentId);
  }

  const updated = getQueueItem(projectId, queueItemId, db);
  if (!updated) {
    return { ok: false, error: `Queue item disappeared: ${queueItemId}` };
  }
  if (updated.status === "dispatched" || updated.status === "completed") {
    return { ok: true, queueStatus: updated.status };
  }
  return {
    ok: false,
    queueStatus: updated.status,
    error: updated.lastError ?? `Queue item ${queueItemId} did not dispatch`,
  };
}

/**
 * Check whether a task description contains acceptance criteria.
 *
 * Recognises common formats:
 *   - Section headers: ## Acceptance Criteria, ## Acceptance, # AC, etc.
 *   - Inline label:    "Acceptance: …" or "Acceptance Criteria: …" anywhere in text
 *   - Structured keywords: success criteria, done when, output format,
 *     expected output, verify that, must include, required output
 *
 * Does NOT accept empty descriptions or descriptions without any of these
 * signals — those still fail as missing_acceptance_criteria.
 */
export function hasAcceptanceCriteria(description: string): boolean {
  const desc = description.toLowerCase();
  return (
    // Section header formats (markdown or plain)
    /##?\s*acceptance(\s+criteria)?/.test(desc) ||
    // Inline label format: "acceptance:" or "acceptance criteria:" anywhere
    /acceptance(\s+criteria)?\s*:/.test(desc) ||
    // Additional well-known phrases
    desc.includes("output format") ||
    desc.includes("expected output") ||
    desc.includes("done when") ||
    desc.includes("success criteria") ||
    desc.includes("verify that") ||
    desc.includes("must include") ||
    desc.includes("required output")
  );
}

async function dispatchItem(
  projectId: string,
  item: DispatchQueueItem,
  db: DatabaseSync,
  resolvedAgentId: string,
): Promise<void> {
  // Pre-dispatch deadline check — catch expired deadlines before wasting a dispatch slot
  {
    const task = getTask(projectId, item.taskId, db);
    if (task?.deadline && Date.now() > task.deadline) {
      failItem(item.id, "Deadline expired before dispatch", db, projectId);
      emitDispatchEvent(projectId, "dispatch_failed", item, { error: "Deadline expired before dispatch", safetyLimit: "deadline" }, db);
      try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "deadline_expired" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
      // Also transition the task to FAILED so it doesn't sit in a dispatchable state
      try {
        transitionTask({ projectId, taskId: item.taskId, toState: "FAILED", actor: "system:dispatch", reason: "Deadline expired before dispatch", verificationRequired: false }, db);
      } catch (err) { safeLog("dispatcher.deadlineTransition", err); }
      return;
    }
  }

  // Emergency stop — blocks everything
  if (isEmergencyStopActive(projectId, db)) {
    failItem(item.id, "Emergency stop active — all dispatches blocked", db, projectId);
    emitDispatchEvent(projectId, "dispatch_failed", item, { error: "Emergency stop active", safetyLimit: "emergency_stop" }, db);
    try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "emergency_stop" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
    return;
  }

  // Budget pacing gate — spread spend across the day
  try {
    const extConfigForPacing = getExtendedProjectConfig(projectId);
    const dispatchConfigForPacing = extConfigForPacing?.dispatch;
    if (dispatchConfigForPacing?.budget_pacing?.enabled !== false) {
      const budgetRow = db.prepare(
        "SELECT daily_limit_cents, daily_spent_cents, hourly_spent_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
      ).get(projectId) as { daily_limit_cents: number | null; daily_spent_cents: number; hourly_spent_cents: number } | undefined;

      if (budgetRow && budgetRow.daily_limit_cents && budgetRow.daily_limit_cents > 0) {
        const now = new Date();
        const endOfDay = new Date(now);
        endOfDay.setUTCHours(23, 59, 59, 999);
        const hoursRemaining = Math.max(0, (endOfDay.getTime() - now.getTime()) / (60 * 60 * 1000));

        const pacing = computeBudgetPacing({
          dailyBudgetCents: budgetRow.daily_limit_cents,
          spentCents: budgetRow.daily_spent_cents ?? 0,
          hoursRemaining,
          currentHourSpentCents: budgetRow.hourly_spent_cents ?? 0,
          reactiveReservePct: dispatchConfigForPacing?.budget_pacing?.reactive_reserve_pct,
          lowBudgetThreshold: dispatchConfigForPacing?.budget_pacing?.low_budget_threshold,
          criticalThreshold: dispatchConfigForPacing?.budget_pacing?.critical_threshold,
        });

        // Determine session type and agent role
        const sessionType = item.payload?.sessionType as string | undefined;
        const agentEntry = (() => {
          try {
            return getAgentConfig(resolvedAgentId, projectId);
          } catch { return undefined; }
        })();
        const isWorker = agentEntry?.config?.extends === "employee";

        // Resolve effective pacing config: check for team-level override first
        // Domain-level pacing is already confirmed enabled by the outer guard
        let effectivePacingEnabled = true;
        if (agentEntry?.config?.team && dispatchConfigForPacing?.teams) {
          const teamOverride = dispatchConfigForPacing.teams[agentEntry.config.team];
          if (teamOverride?.budget_pacing) {
            effectivePacingEnabled = teamOverride.budget_pacing.enabled !== false;
          }
        }

        // If team-level pacing is disabled, skip pacing for this agent
        if (!effectivePacingEnabled) {
          // Team override: pacing disabled — skip pacing gate
        } else if (sessionType === "reactive") {
          // Reactive sessions bypass pacing — only hard budget limit applies
          if (!pacing.canDispatchReactive) {
            failItem(item.id, `Budget pacing: reactive dispatch blocked — ${pacing.recommendation}`, db, projectId);
            emitDispatchEvent(projectId, "dispatch_failed", item, { error: pacing.recommendation, budgetPacing: true }, db);
            try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "budget_pacing_reactive" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
            return;
          }
        } else if (sessionType === "planning") {
          // Planning sessions use lead pacing
          if (!pacing.canDispatchLead) {
            failItem(item.id, `Budget pacing: planning dispatch blocked — ${pacing.recommendation}`, db, projectId);
            emitDispatchEvent(projectId, "dispatch_failed", item, { error: pacing.recommendation, budgetPacing: true }, db);
            try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "budget_pacing_lead" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
            return;
          }
        } else if (isWorker && !pacing.canDispatchWorker) {
          // Active/default worker sessions use worker pacing
          failItem(item.id, `Budget pacing: worker dispatch blocked — ${pacing.recommendation}`, db, projectId);
          emitDispatchEvent(projectId, "dispatch_failed", item, { error: pacing.recommendation, budgetPacing: true }, db);
          try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "budget_pacing_worker" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
          return;
        } else if (!isWorker && !pacing.canDispatchLead) {
          // Active/default lead sessions use lead pacing
          failItem(item.id, `Budget pacing: lead dispatch blocked — ${pacing.recommendation}`, db, projectId);
          emitDispatchEvent(projectId, "dispatch_failed", item, { error: pacing.recommendation, budgetPacing: true }, db);
          try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "budget_pacing_lead" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
          return;
        }
      }
    }
  } catch (err) {
    safeLog("dispatcher.budgetPacing", err);
    // Budget pacing failure is non-fatal — proceed with dispatch
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
    // Budget check failure is fatal — fail-closed to prevent unmetered dispatch
    failItem(item.id, `Budget check error: ${err instanceof Error ? err.message : String(err)}`, db, projectId);
    emitDispatchEvent(projectId, "dispatch_failed", item, { error: "Budget check failed (fail-closed)", budgetExceeded: true }, db);
    try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "budget_check_error" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
    return;
  }

  // Session/task per-record budget checks (bounded O(n) scope)
  try {
    const profileVal = item.payload?.profile as string | undefined;
    const executor = resolveDispatchExecutorName(projectId);
    const syntheticPrefix = executor === "openclaw" ? "dispatch" : executor;
    const agentId = profileVal ? `${syntheticPrefix}:${profileVal}` : undefined;
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

  let task = getTask(projectId, item.taskId, db);
  if (!task) {
    failItem(item.id, `Task not found: ${item.taskId}`, db, projectId);
    emitDispatchEvent(projectId, "dispatch_failed", item, { error: `Task not found: ${item.taskId}` }, db);
    try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts, reason: "task_not_found" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
    return;
  }
  task = maybeNormalizeWorkflowMutationImplementationTask(projectId, task, db);
  task = maybeNormalizeRecurringJobTask(projectId, task, db);

  // Only dispatch tasks in dispatchable states.
  // REVIEW is dispatchable when a verifier agent is specified in the payload (verification dispatch).
  // Normalize state for robustness with legacy lowercase rows (e.g. "assigned").
  const normalizedState = String(task.state).toUpperCase();
  const isVerifierDispatch = item.payload?.agentId && normalizedState === "REVIEW";
  if (!isVerifierDispatch && normalizedState !== "ASSIGNED" && normalizedState !== "IN_PROGRESS") {
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

  // Task description validation gate — ensure task has acceptance criteria
  if (task.description && !hasAcceptanceCriteria(task.description)) {
    failItem(item.id, "Task description missing acceptance criteria — manager must define what 'done' looks like", db, projectId);
    emitDispatchEvent(projectId, "dispatch_failed", item, { error: "missing_acceptance_criteria", safetyLimit: "task_validation" }, db);
    try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, reason: "missing_acceptance_criteria" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
    return;
  }

  // Acquire task lease (long lease — released in agent_end hook)
  const holder = `dispatch:${item.id}`;
  const itemDispatchConfig = getExtendedProjectConfig(projectId)?.dispatch;
  const effectiveTaskLeaseMs = itemDispatchConfig?.taskLeaseMs ?? TASK_LEASE_MS;
  const leaseOk = acquireTaskLease(projectId, item.taskId, holder, effectiveTaskLeaseMs, db);
  if (!leaseOk) {
    failItem(item.id, "Could not acquire task lease — another agent holds it", db, projectId);
    emitDispatchEvent(projectId, "dispatch_failed", item, { error: "Could not acquire task lease" }, db);
    try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts, reason: "lease_conflict" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
    return;
  }

  // Git isolation: create branch for this task
  try {
    const verConfig = getEffectiveVerificationConfig(projectId);
    if (verConfig.git?.enabled) {
      const cfEntry = getAgentConfig(resolvedAgentId, projectId);
      const projectDir = cfEntry?.projectDir;
      if (projectDir) {
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
    const dispatchAgentEntry = getAgentConfig(resolvedAgentId, projectId);
    // Extract dispatch params from queue item payload
    const payload = item.payload ?? {};
    const userPrompt = (payload.prompt as string) ?? `Execute task: ${task.title}`;
    const model = payload.model as string | undefined;
    const timeoutMs = payload.timeoutMs as number | undefined;
    const disableMcpBridge = payload.disableMcpBridge === true;
    const jobName = typeof payload.jobName === "string" ? payload.jobName : undefined;
    const effectiveAgentConfig = jobName && dispatchAgentEntry?.config
      ? resolveEffectiveConfig(dispatchAgentEntry.config, jobName) ?? dispatchAgentEntry.config
      : dispatchAgentEntry?.config;

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

    const result = await executeDispatch({
      queueItemId: item.id,
      taskId: item.taskId,
      projectId,
      prompt: fullPrompt,
      agentId: resolvedAgentId,
      jobName,
      model,
      timeoutSeconds: effectiveTimeoutSeconds,
      agentConfig: effectiveAgentConfig,
      projectDir: dispatchAgentEntry?.projectDir,
      disableMcpBridge,
    });

    if (result.ok) {
      if (result.completedInline) {
        let taskAfter = getTask(projectId, item.taskId, db);
        let inlineFinalizeResult: { ok: boolean; reason?: string } | undefined;
        if (taskAfter && (taskAfter.state === "ASSIGNED" || taskAfter.state === "IN_PROGRESS")) {
          if (lacksSubstantiveInlineResult(result)) {
            inlineFinalizeResult = {
              ok: false,
              reason: "Inline dispatch exited successfully without a final summary or observed work",
            };
          } else {
            const inlineSummary = recoverInlineSummary(projectId, result.sessionKey, result.summary, db);
            inlineFinalizeResult = maybeFinalizeInlineTask(
              projectId,
              item.taskId,
              holder,
              resolvedAgentId,
              result.executor,
              inlineSummary,
              db,
            );
          }
          taskAfter = getTask(projectId, item.taskId, db);
        }
        if (taskAfter && taskAfter.state !== "ASSIGNED" && taskAfter.state !== "IN_PROGRESS") {
          markDispatched(item.id, db, projectId);
          completeItem(item.id, db, projectId);
          emitDispatchEvent(projectId, "dispatch_succeeded", item, {
            sessionKey: result.sessionKey,
            executor: result.executor,
            completedInline: true,
          }, db);
          try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_success", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts, executor: result.executor, completion: "inline" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
        } else {
          const error = inlineFinalizeResult?.reason
            ? `Task remained in ${taskAfter?.state ?? "unknown"} after inline dispatch: ${inlineFinalizeResult.reason}`
            : `Task remained in ${taskAfter?.state ?? "unknown"} after inline dispatch`;
          if (shouldAutoRequeueInlineNoop(item, inlineFinalizeResult?.reason)) {
            markInlineNoopRetryPayload(item, result.executor, db);
            releaseToQueued(item.id, error, db, projectId, { undoDispatchAttempt: false });
            safeLog("dispatcher.inlineAutoRequeue", `Queue item ${item.id} released for one automatic retry after silent inline success`);
          } else {
            failItem(item.id, error, db, projectId);
            emitDispatchEvent(projectId, "dispatch_failed", item, {
              error,
              executor: result.executor,
              completedInline: true,
            }, db);
            maybeEmitDeadLetter(projectId, item, error, db);
            try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts, reason: "inline_task_state_unchanged", executor: result.executor } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
          }
        }
        try { releaseTaskLease(projectId, item.taskId, holder, db); } catch (err) { safeLog("dispatcher.releaseLease", err); }
      } else if (!result.handledRemotely) {
        // Session started — mark as dispatched (completion handled in agent_end hook)
        markDispatched(item.id, db, projectId);
        emitDispatchEvent(projectId, "dispatch_succeeded", item, {
          sessionKey: result.sessionKey,
          executor: result.executor,
        }, db);
        try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_success", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts, executor: result.executor } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
      }
    } else {
      const error = result.error ?? "Unknown dispatch error";
      const isDeferred = result.deferred || error.includes("Cron service not available");

      if (isDeferred) {
        // Executor not ready yet — release back to queue for retry
        // on the next sweep pass instead of permanently failing the item.
        releaseToQueued(item.id, error, db, projectId);
        safeLog("dispatcher.dispatchDeferred", `Queue item ${item.id} released to queued — executor ${result.executor} not ready`);
        try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_deferred", value: 1, tags: { queueItemId: item.id, reason: "executor_unavailable", executor: result.executor } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
        // Release lease and abort the loop — no point trying more items
        // when the executor is down. They'll be retried next sweep pass.
        try { releaseTaskLease(projectId, item.taskId, holder, db); } catch (err) { safeLog("dispatcher.releaseLease", err); }
        throw new CronUnavailableError(error);
      } else {
        failItem(item.id, error, db, projectId);
        const nonRetryable = isNonRetryableDispatchError(error);
        emitDispatchEvent(projectId, "dispatch_failed", item, { error, executor: result.executor, nonRetryable }, db);
        maybeEmitDeadLetter(projectId, item, error, db, { force: nonRetryable });
        try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts, reason: "executor_error", executor: result.executor } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
      }
      // Release lease on failure — no session will run
      try { releaseTaskLease(projectId, item.taskId, holder, db); } catch (err) { safeLog("dispatcher.releaseLease", err); }
    }
  } catch (err) {
    // Re-throw CronUnavailableError so dispatchLoop can catch it and abort gracefully
    if (err instanceof CronUnavailableError) throw err;

    const message = err instanceof Error ? err.message : String(err);
    failItem(item.id, message, db, projectId);
    const nonRetryable = isNonRetryableDispatchError(message);
    emitDispatchEvent(projectId, "dispatch_failed", item, { error: message, nonRetryable }, db);
    maybeEmitDeadLetter(projectId, item, message, db, { force: nonRetryable });
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
  options?: { force?: boolean },
): void {
  if (options?.force || item.dispatchAttempts >= item.maxDispatchAttempts) {
    try {
      ingestEvent(projectId, "dispatch_dead_letter", "internal", {
        taskId: item.taskId,
        queueItemId: item.id,
        attempts: item.dispatchAttempts,
        lastError,
        forced: options?.force === true,
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

function isNonRetryableDispatchError(error: string): boolean {
  const normalized = error.toLowerCase();
  return normalized.includes("not logged in")
    || normalized.includes("please run /login")
    || normalized.includes("unknown option")
    || normalized.includes("binary not found");
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
) : Promise<{
  eventsProcessed: number;
  dispatched: number;
  controller?: {
    skipped: boolean;
    ownerId: string;
    ownerLabel: string;
    purpose: string;
    expiresAt: number;
  };
}> {
  const db = dbOverride ?? getDb(projectId);
  const gated = await withControllerLease(projectId, async () => {
    const eventsProcessed = processEvents(projectId, db);
    const dispatched = await dispatchLoop(projectId, db);
    return { eventsProcessed, dispatched };
  }, {
    purpose: "process_and_dispatch",
    persistent: false,
  }, db);

  if (gated.skipped) {
    return {
      eventsProcessed: 0,
      dispatched: 0,
      controller: {
        skipped: true,
        ownerId: gated.lease.ownerId,
        ownerLabel: gated.lease.ownerLabel,
        purpose: gated.lease.purpose,
        expiresAt: gated.lease.expiresAt,
      },
    };
  }

  return {
    ...gated.result,
    controller: {
      skipped: false,
      ownerId: gated.lease.ownerId,
      ownerLabel: gated.lease.ownerLabel,
      purpose: gated.lease.purpose,
      expiresAt: gated.lease.expiresAt,
    },
  };
}

/** Reset concurrency counters (for testing). */
export function resetDispatcherForTest(): void {
  const state = getDispatcherState();
  state.globalActiveDispatches = 0;
  state.globalMaxConcurrency = DEFAULT_MAX_CONCURRENCY;
  state.projectDispatches.clear();
  state.projectDispatchTimestamps.clear();
  state.agentDispatches.clear();
  state.agentDispatchTimestamps.clear();
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

  // Domain disabled — blocks all dispatches for this project
  if (isDomainDisabled(projectId)) {
    return { ok: false, reason: "Domain is disabled — all dispatches blocked" };
  }

  // Agent disabled — blocks dispatches for this specific agent
  if (isAgentEffectivelyDisabled(projectId, agentId)) {
    return { ok: false, reason: `Agent "${agentId}" is disabled — dispatch blocked` };
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
