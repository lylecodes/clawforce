/**
 * Clawforce — Dispatch loop
 *
 * Claims items from the dispatch queue, acquires task leases,
 * spawns agents, and completes/fails queue items.
 * Module-level concurrency counter prevents overloading.
 */

import type { DatabaseSync } from "node:sqlite";
import { checkBudget } from "../budget.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { getExtendedProjectConfig } from "../project.js";
import { classifyRisk } from "../risk/classifier.js";
import { getRiskConfig } from "../risk/config.js";
import { applyRiskGate } from "../risk/gate.js";
import { getTask, getTaskEvidence } from "../tasks/ops.js";
import { acquireTaskLease, releaseTaskLease, renewTaskLease } from "../tasks/ops.js";
import { ingestEvent } from "../events/store.js";
import { processEvents } from "../events/router.js";
import { claimNext, completeItem, failItem, reclaimExpiredLeases } from "./queue.js";
import { dispatchAndTransition } from "./spawn.js";
import { recordMetric } from "../metrics.js";
import { writeAuditEntry } from "../audit.js";
import { isTaskInFuturePhase } from "../workflow.js";
import type { DispatchQueueItem } from "../types.js";

let activeDispatches = 0;
let maxConcurrency = 3;

/** Set the maximum number of concurrent dispatches. */
export function setMaxConcurrency(max: number): void {
  maxConcurrency = max;
}

/** Get current dispatch concurrency info. */
export function getConcurrencyInfo(): { active: number; max: number } {
  return { active: activeDispatches, max: maxConcurrency };
}

/**
 * Run a single pass of the dispatch loop:
 * 1. Reclaim expired leases
 * 2. Claim next queued item
 * 3. Acquire task lease
 * 4. Dispatch agent
 * 5. Complete/fail queue item
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

  // Process items while under concurrency limit
  while (activeDispatches < maxConcurrency) {
    const item = claimNext(projectId, undefined, undefined, db);
    if (!item) break;

    activeDispatches++;
    try {
      await dispatchItem(projectId, item, db);
      dispatched++;
    } finally {
      activeDispatches--;
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
): Promise<void> {
  // Pre-dispatch budget check (includes agent-level and session-level budgets)
  try {
    const profileVal = item.payload?.profile as string | undefined;
    const agentId = profileVal ? `claude-code:${profileVal}` : undefined;
    const sessionKey = item.payload?.sessionKey as string | undefined;
    const budgetResult = checkBudget({ projectId, agentId, taskId: item.taskId, sessionKey }, db);
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

  // Acquire task lease
  const holder = `dispatcher:${item.id}`;
  const leaseOk = acquireTaskLease(projectId, item.taskId, holder, 15 * 60 * 1000, db);
  if (!leaseOk) {
    failItem(item.id, "Could not acquire task lease — another agent holds it", db, projectId);
    emitDispatchEvent(projectId, "dispatch_failed", item, { error: "Could not acquire task lease" }, db);
    try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts, reason: "lease_conflict" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
    return;
  }

  const RENEWAL_MS = 5 * 60 * 1000;
  const LEASE_MS = 15 * 60 * 1000;
  const renewalTimer = setInterval(() => {
    try { renewTaskLease(projectId, item.taskId, holder, LEASE_MS, db); }
    catch (err) { safeLog("dispatcher.renewLease", err); }
  }, RENEWAL_MS);

  try {
    // Extract dispatch params from queue item payload
    const payload = item.payload ?? {};
    const prompt = (payload.prompt as string) ?? `Execute task: ${task.title}`;
    const projectDir = (payload.projectDir as string) ?? process.cwd();
    const profile = payload.profile as string | undefined;
    const model = payload.model as string | undefined;
    const timeoutMs = payload.timeoutMs as number | undefined;

    // Build retry context if task has been attempted before
    const retryContext = buildRetryContext(projectId, item.taskId, db);
    const fullPrompt = retryContext ? `${prompt}\n\n${retryContext}` : prompt;

    const preState = task.state;
    const result = await dispatchAndTransition({
      task,
      projectDir,
      prompt: fullPrompt,
      profile,
      model,
      timeoutMs,
    });

    if (result.ok) {
      // Verify task actually advanced
      const postTask = getTask(projectId, item.taskId, db);
      if (postTask && postTask.state === preState) {
        // Subprocess succeeded but task didn't transition — treat as failure
        const error = `Dispatch succeeded (exit 0) but task remained in ${preState}`;
        failItem(item.id, error, db, projectId);
        emitDispatchEvent(projectId, "dispatch_failed", item, { error, stateStuck: true }, db);
        maybeEmitDeadLetter(projectId, item, error, db);
        try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_state_stuck", value: 1, tags: { queueItemId: item.id, stuckState: preState } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
        try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts, reason: "state_stuck" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
      } else {
        completeItem(item.id, db, projectId);
        emitDispatchEvent(projectId, "dispatch_succeeded", item, {}, db);
        try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_success", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
      }
    } else {
      const error = result.stderr.slice(0, 500);
      failItem(item.id, error, db, projectId);
      emitDispatchEvent(projectId, "dispatch_failed", item, { error }, db);
      maybeEmitDeadLetter(projectId, item, error, db);
      try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts, reason: "agent_error" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failItem(item.id, message, db, projectId);
    emitDispatchEvent(projectId, "dispatch_failed", item, { error: message }, db);
    maybeEmitDeadLetter(projectId, item, message, db);
    try { recordMetric({ projectId, type: "dispatch", subject: item.taskId, key: "dispatch_failure", value: 1, tags: { queueItemId: item.id, attempt: item.dispatchAttempts, reason: "exception" } }, db); } catch (e) { safeLog("dispatcher.metric", e); }
  } finally {
    clearInterval(renewalTimer);
    try {
      releaseTaskLease(projectId, item.taskId, holder, db);
    } catch (err) {
      safeLog("dispatcher.releaseLease", err);
    }
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

/** Reset concurrency counter (for testing). */
export function resetDispatcherForTest(): void {
  activeDispatches = 0;
  maxConcurrency = 3;
}
