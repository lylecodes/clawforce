/**
 * Clawforce — Background sweep service
 *
 * Runs periodically to:
 * - Detect stale tasks → emits sweep_finding events (advisory)
 * - Enforce deadlines → directly fails tasks (safety-critical)
 * - Advance workflow phases when gates are satisfied
 * - Escalate max-retries-exhausted tasks → emits sweep_finding events
 * - Expire stale proposals
 * - Enforce worker compliance
 * - Detect and kill stuck agents
 * - Reclaim expired dispatch queue leases
 * - Process events + drain dispatch queue (backstop)
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import { killAllStuckAgents } from "../audit/auto-kill.js";
import { detectPersistedStuckAgents, detectStuckAgents } from "../audit/stuck-detector.js";
import { getActiveSessions } from "../enforcement/tracker.js";
import { resetDailyBudgets } from "../budget.js";
import { getDb } from "../db.js";
import { releaseTaskLease, transitionTask } from "../tasks/ops.js";
import { getUnresolvedBlockers } from "../tasks/deps.js";
import type { Task, TaskState } from "../types.js";
import { getExtendedProjectConfig } from "../project.js";
import { enforceWorkerCompliance, getIncompliantWorkers } from "../tasks/compliance.js";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";
import { advanceWorkflow, getPhaseStatus, listWorkflows } from "../workflow.js";
import { ingestEvent, reclaimStaleEvents, requeueEvents } from "../events/store.js";
import {
  enqueue,
  failItem as failQueueItem,
  reclaimExpiredLeases,
  releaseToQueued,
} from "../dispatch/queue.js";
import { parseDispatchCronJobName } from "../dispatch/cron-job-name.js";
import { releaseStaleReservations } from "../budget/reservation-cleanup.js";
import { createMessage } from "../messaging/store.js";
import { findManagerAgent } from "../events/actions.js";
import { processAndDispatch } from "../dispatch/dispatcher.js";
import { processEvents } from "../events/router.js";
import { checkSpendRateWarning } from "../safety.js";
import { getCronService } from "../manager-cron.js";
import { getTask } from "../tasks/ops.js";
import { getResolvedLinkedIssueForTask } from "../entities/remediation.js";
import {
  acquireControllerLease,
  getCurrentControllerGeneration,
  requestControllerGeneration,
  releaseControllerLease,
} from "../runtime/controller-leases.js";
import {
  markProposalExecutionApplied,
  markProposalExecutionPending,
} from "../approval/resolve.js";
import { replayRecurringJobTask, scheduleDueRecurringJobs } from "../scheduling/recurring-jobs.js";

export type SweepResult = {
  stale: number;
  autoBlocked: number;
  deadlineExpired: number;
  workflowsAdvanced: number;
  escalated: number;
  complianceBlocked: number;
  stuckKilled: number;
  proposalsExpired: number;
  proposalExecutionsRecovered: number;
  protocolsExpired: number;
  goalsNeedingPlan: number;
  goalsCascadeAchieved: number;
  leasesReclaimed: number;
  eventsProcessed: number;
  dispatched: number;
  budgetsReset: number;
  autoAssigned: number;
  sloChecked: number;
  sloBreach: number;
  alertsFired: number;
  anomaliesDetected: number;
  reviewEscalated: number;
  meetingsStale: number;
  frequencyDispatched: number;
  staleDispatchRecovered: number;
  orphanedDispatchRecovered: number;
  reservationsReleased: number;
  orphanedCronRecovered: number;
  agentsRecovered: number;
  agentsEscalated: number;
  controller?: {
    skipped: boolean;
    ownerId: string;
    ownerLabel: string;
    purpose: string;
    expiresAt: number;
  };
};

export type SweepOptions = {
  projectId: string;
  staleThresholdMs?: number;
  stuckTimeoutMs?: number;
  proposalTtlMs?: number;
  /** How long a dispatch queue item can sit in 'dispatched' status with no active session before recovery. Default 10 minutes. */
  staleDispatchTimeoutMs?: number;
  backstopDispatchMode?: "full" | "events_only";
  dbOverride?: DatabaseSync;
};

const DEFAULT_STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
const DEFAULT_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_STALE_DISPATCH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_WORKFLOW_DRAIN_PASSES = 10;
const MISSING_ACCEPTANCE_CRITERIA_PREFIX = "Task description missing acceptance criteria";

/** Generate a stable dedup key from finding type + entity ID.
 * No timestamp component — the same condition produces the same event ID
 * across sweep passes, letting the event store's own dedup handle recurrence. */
function sweepDedupKey(prefix: string, id: string): string {
  return `${prefix}:${id}`;
}

function collectActiveSessionDispatchIds(projectId: string, db: DatabaseSync): Set<string> {
  const activeSessionDispatchIds = new Set<string>();

  for (const session of getActiveSessions()) {
    if (session.dispatchContext?.queueItemId) {
      activeSessionDispatchIds.add(session.dispatchContext.queueItemId);
    }
  }

  try {
    const trackedRows = db.prepare(
      "SELECT dispatch_context FROM tracked_sessions WHERE project_id = ? AND dispatch_context IS NOT NULL",
    ).all(projectId) as { dispatch_context?: string | null }[];

    for (const row of trackedRows) {
      if (!row.dispatch_context) continue;
      try {
        const parsed = JSON.parse(row.dispatch_context) as { queueItemId?: string };
        if (parsed.queueItemId) activeSessionDispatchIds.add(parsed.queueItemId);
      } catch {
        // Ignore malformed persisted session state during recovery.
      }
    }
  } catch (err) {
    safeLog("sweep.collectActiveSessionDispatchIds", err);
  }

  return activeSessionDispatchIds;
}

function recoverStrandedRecurringDispatches(projectId: string, db: DatabaseSync): number {
  let recovered = 0;
  const strandedRecurringTasks = db.prepare(
    `SELECT t.id
     FROM tasks t
     WHERE t.project_id = ?
       AND t.state IN ('OPEN', 'ASSIGNED', 'BLOCKED')
       AND json_extract(COALESCE(t.metadata, '{}'), '$.recurringJob.agentId') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM dispatch_queue q
         WHERE q.project_id = t.project_id
           AND q.task_id = t.id
           AND q.status IN ('queued', 'leased', 'dispatched')
       )
       AND EXISTS (
         SELECT 1
         FROM dispatch_queue q
         WHERE q.project_id = t.project_id
           AND q.task_id = t.id
           AND q.status = 'failed'
           AND q.last_error LIKE ?
       )`,
  ).all(projectId, `${MISSING_ACCEPTANCE_CRITERIA_PREFIX}%`) as Array<{ id: string }>;

  for (const row of strandedRecurringTasks) {
    const failedItem = db.prepare(
      `SELECT id, priority, payload
       FROM dispatch_queue
       WHERE project_id = ?
         AND task_id = ?
         AND status = 'failed'
       ORDER BY completed_at DESC, created_at DESC
       LIMIT 1`,
    ).get(projectId, row.id) as {
      id?: string;
      priority?: number;
      payload?: string | null;
    } | undefined;
    if (!failedItem?.id) continue;

    const replay = replayRecurringJobTask(projectId, row.id, "system:sweep", db);
    if (!replay.ok) {
      safeLog("sweep.recurringDispatchRecovery", replay.reason);
      continue;
    }

    const payload = failedItem.payload ? JSON.parse(failedItem.payload) as Record<string, unknown> : undefined;
    const queueItem = enqueue(
      projectId,
      replay.task.id,
      payload,
      failedItem.priority,
      db,
      undefined,
      false,
      true,
    );
    if (!queueItem) {
      safeLog("sweep.recurringDispatchRecovery", `Failed to enqueue replayed recurring task ${replay.task.id}`);
      continue;
    }

    emitDiagnosticEvent({
      type: "recurring_dispatch_recovered",
      projectId,
      taskId: row.id,
      previousQueueItemId: failedItem.id,
      replayTaskId: replay.task.id,
      queueItemId: queueItem.id,
    });

    ingestEvent(projectId, "sweep_finding", "cron", {
      finding: "recurring_dispatch_recovered",
      taskId: row.id,
      previousQueueItemId: failedItem.id,
      replayTaskId: replay.task.id,
      queueItemId: queueItem.id,
    }, sweepDedupKey("recurring-dispatch", row.id), db);

    recovered++;
  }

  return recovered;
}

function reconcileApprovedWorkflowMutationExecutions(projectId: string, db: DatabaseSync): number {
  const rows = db.prepare(`
    SELECT
      p.id,
      p.execution_status,
      p.execution_task_id,
      lead.id AS lead_task_id,
      lead.state AS lead_task_state,
      source.id AS source_task_id,
      source.state AS source_task_state,
      evt.id AS event_id,
      evt.status AS event_status
    FROM proposals p
    LEFT JOIN tasks lead
      ON lead.id = (
        SELECT t.id
        FROM tasks t
        WHERE t.project_id = p.project_id
          AND t.origin = 'lead_proposal'
          AND t.origin_id = p.id
        ORDER BY t.created_at DESC
        LIMIT 1
      )
    LEFT JOIN tasks source
      ON source.project_id = p.project_id
     AND source.id = json_extract(p.approval_policy_snapshot, '$.sourceTaskId')
    LEFT JOIN events evt
      ON evt.id = (
        SELECT e.id
        FROM events e
        WHERE e.project_id = p.project_id
          AND e.type = 'proposal_approved'
          AND json_extract(e.payload, '$.proposalId') = p.id
        ORDER BY e.created_at DESC
        LIMIT 1
      )
    WHERE p.project_id = ?
      AND p.status = 'approved'
      AND p.origin = 'workflow_mutation'
      AND (p.execution_status IS NULL OR p.execution_status = 'pending')
    ORDER BY COALESCE(p.execution_updated_at, p.resolved_at, p.created_at) DESC
    LIMIT 25
  `).all(projectId) as Array<Record<string, unknown>>;

  let recovered = 0;
  const currentGeneration = getCurrentControllerGeneration();
  const activeSourceStates = new Set(["OPEN", "ASSIGNED", "IN_PROGRESS", "REVIEW"]);

  for (const row of rows) {
    const proposalId = row.id as string;
    const leadTaskId = typeof row.lead_task_id === "string" ? row.lead_task_id : null;
    const sourceTaskState = typeof row.source_task_state === "string" ? row.source_task_state : null;
    const sourceStillActive = !!sourceTaskState && activeSourceStates.has(sourceTaskState);
    const alreadyApplied = !!leadTaskId && !sourceStillActive;

    if (alreadyApplied) {
      markProposalExecutionApplied(projectId, proposalId, {
        taskId: (typeof row.execution_task_id === "string" ? row.execution_task_id : null) ?? leadTaskId,
      }, db);
      recovered++;
      continue;
    }

    requestControllerGeneration(projectId, {
      generation: currentGeneration,
      requestedBy: "system:sweep",
      reason: `proposal_reconcile:${proposalId}`,
      metadata: { proposalId, origin: "workflow_mutation" },
    }, db, true);
    markProposalExecutionPending(projectId, proposalId, {
      requiredGeneration: currentGeneration,
      taskId: leadTaskId,
    }, db);

    const eventId = typeof row.event_id === "string" ? row.event_id : null;
    const eventStatus = typeof row.event_status === "string" ? row.event_status : null;
    if (eventId && eventStatus && !["pending", "processing"].includes(eventStatus)) {
      requeueEvents(projectId, { ids: [eventId] }, db);
      recovered++;
      continue;
    }

    if (!eventId) {
      ingestEvent(projectId, "proposal_approved", "internal", {
        proposalId,
      }, `proposal-approved:${proposalId}`, db);
      recovered++;
    }
  }

  return recovered;
}

async function drainWorkflowBackstop(
  projectId: string,
  db: DatabaseSync,
  options: {
    maxPasses?: number;
    dispatchMode?: "full" | "events_only";
  } = {},
): Promise<{
  eventsProcessed: number;
  dispatched: number;
}> {
  let eventsProcessed = 0;
  let dispatched = 0;
  const maxPasses = options.maxPasses ?? DEFAULT_WORKFLOW_DRAIN_PASSES;
  const dispatchMode = options.dispatchMode ?? "full";

  for (let pass = 0; pass < maxPasses; pass++) {
    if (dispatchMode === "events_only") {
      const processed = processEvents(projectId, db);
      eventsProcessed += processed;
      if (processed === 0) break;
      continue;
    }

    const result = await processAndDispatch(projectId, db);
    eventsProcessed += result.eventsProcessed;
    dispatched += result.dispatched;

    if (result.controller?.skipped) break;
    if (result.eventsProcessed === 0 && result.dispatched === 0) break;
  }

  return { eventsProcessed, dispatched };
}

export async function sweep(options: SweepOptions): Promise<SweepResult> {
  const { projectId, dbOverride } = options;
  const db = dbOverride ?? getDb(projectId);
  const controllerLease = acquireControllerLease(projectId, {
    purpose: "sweep",
  }, db);

  if (!controllerLease.ok) {
    return {
      stale: 0,
      autoBlocked: 0,
      deadlineExpired: 0,
      workflowsAdvanced: 0,
      escalated: 0,
      complianceBlocked: 0,
      stuckKilled: 0,
      proposalsExpired: 0,
      proposalExecutionsRecovered: 0,
      protocolsExpired: 0,
      goalsNeedingPlan: 0,
      goalsCascadeAchieved: 0,
      leasesReclaimed: 0,
      eventsProcessed: 0,
      dispatched: 0,
      budgetsReset: 0,
      autoAssigned: 0,
      sloChecked: 0,
      sloBreach: 0,
      alertsFired: 0,
      anomaliesDetected: 0,
      reviewEscalated: 0,
      meetingsStale: 0,
      frequencyDispatched: 0,
      staleDispatchRecovered: 0,
      orphanedDispatchRecovered: 0,
      reservationsReleased: 0,
      orphanedCronRecovered: 0,
      agentsRecovered: 0,
      agentsEscalated: 0,
      controller: {
        skipped: true,
        ownerId: controllerLease.lease.ownerId,
        ownerLabel: controllerLease.lease.ownerLabel,
        purpose: controllerLease.lease.purpose,
        expiresAt: controllerLease.lease.expiresAt,
      },
    };
  }

  try {
    // Read sweep config from domain yaml, falling back to options, then defaults
    const extConfig = getExtendedProjectConfig(projectId);
    const sweepConfig = extConfig?.sweep;
    const staleThreshold = options.staleThresholdMs ?? sweepConfig?.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
    const proposalTtl = options.proposalTtlMs ?? sweepConfig?.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS;
    const staleDispatchTimeout = options.staleDispatchTimeoutMs ?? sweepConfig?.staleDispatchTimeoutMs ?? DEFAULT_STALE_DISPATCH_TIMEOUT_MS;
    const now = Date.now();

    let stale = 0;
    let autoBlocked = 0;
    let deadlineExpired = 0;
    let workflowsAdvanced = 0;
    let escalated = 0;
    let complianceBlocked = 0;
    let proposalsExpired = 0;
    let proposalExecutionsRecovered = 0;
    let protocolsExpired = 0;
    let goalsNeedingPlan = 0;
    let goalsCascadeAchieved = 0;
    let leasesReclaimed = 0;
    let staleDispatchRecoveredCount = 0;
    let orphanedDispatchRecoveredCount = 0;
    let reservationsReleased = 0;
    let budgetsReset = 0;
    let reviewEscalated = 0;
    let meetingsStale = 0;
    let orphanedCronRecovered = 0;

  // Reclaim events stuck in 'processing' (e.g. from a previous crash)
  try {
    reclaimStaleEvents(projectId, undefined, db);
  } catch (err) {
    safeLog("sweep.reclaimStaleEvents", err);
  }

  // Wrap all DB-mutating operations in a transaction for atomicity.
  // If the process crashes mid-sweep, all changes roll back together.
  try {
    db.exec("BEGIN");

    // 1. Find stale tasks — emit events instead of directly mutating
    const activeStates: TaskState[] = ["ASSIGNED", "IN_PROGRESS"];
    for (const state of activeStates) {
      const rows = db
        .prepare("SELECT * FROM tasks WHERE project_id = ? AND state = ?")
        .all(projectId, state) as Record<string, unknown>[];

      for (const row of rows) {
        const taskId = row.id as string;
        const updatedAt = row.updated_at as number;

        if (now - updatedAt > staleThreshold) {
          // Check if there's a recent transition
          const lastTransition = db
            .prepare("SELECT created_at FROM transitions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
            .get(taskId) as Record<string, unknown> | undefined;

          const lastActivity = lastTransition
            ? (lastTransition.created_at as number)
            : updatedAt;

          if (now - lastActivity > staleThreshold) {
            stale++;
            // Mark as stale via metadata update (don't transition — just flag)
            db.prepare("UPDATE tasks SET updated_at = ?, metadata = json_set(COALESCE(metadata, '{}'), '$.stale', true, '$.stale_since', ?) WHERE id = ?")
              .run(now, lastActivity, taskId);

            emitDiagnosticEvent({ type: "task_stale", taskId, projectId, staleSinceMs: now - lastActivity });

            // Emit event for stale detection (advisory — router decides policy)
            ingestEvent(projectId, "sweep_finding", "cron", {
              finding: "stale",
              taskId,
              staleSinceMs: now - lastActivity,
            }, sweepDedupKey("stale", taskId), db);

            // Auto-block severely stale tasks (2x threshold) — stays direct (safety-critical)
            const meta = row.metadata ? JSON.parse(row.metadata as string) : null;
            const staleSince = meta?.stale_since as number | undefined;
            if (staleSince && now - staleSince > staleThreshold) {
              const blockResult = transitionTask(
                { projectId, taskId, toState: "BLOCKED", actor: "system:sweep", reason: `Auto-blocked: no activity for ${Math.round((now - lastActivity) / 3_600_000)}h`, verificationRequired: false, withinTransaction: true },
                db,
              );
              if (blockResult.ok) autoBlocked++;
            }
          }
        }
      }
    }

    // 1.5. Recover BLOCKED tasks when blocking condition no longer applies
    let staleUnblocked = 0;
    const blockedRows = db
      .prepare("SELECT id FROM tasks WHERE project_id = ? AND state = 'BLOCKED'")
      .all(projectId) as Record<string, unknown>[];

    for (const row of blockedRows) {
      const taskId = row.id as string;
      let unblocked = false;

      // Recover auto-blocked stale tasks after 2x stale threshold in BLOCKED state.
      const lastBlocked = db.prepare(
        "SELECT reason, created_at FROM transitions WHERE task_id = ? AND to_state = 'BLOCKED' ORDER BY created_at DESC LIMIT 1",
      ).get(taskId) as Record<string, unknown> | undefined;

      if (lastBlocked) {
        const blockReason = (lastBlocked.reason as string | null) ?? "";
        const blockedAt = lastBlocked.created_at as number;
        if (blockReason.startsWith("Auto-blocked: no activity") && (now - blockedAt > staleThreshold * 2)) {
          const reopen = transitionTask(
            {
              projectId,
              taskId,
              toState: "OPEN",
              actor: "system:sweep",
              reason: "Auto-recovered: stale block window expired",
              verificationRequired: false,
              withinTransaction: true,
            },
            db,
          );
          if (reopen.ok) {
            staleUnblocked++;
            unblocked = true;
          }
        }
      }

      if (unblocked) continue;

      // Recover dependency-blocked tasks when all hard blockers are DONE.
      const hardDepCount = db.prepare(
        "SELECT COUNT(*) as count FROM task_dependencies WHERE project_id = ? AND task_id = ? AND type = 'blocks'",
      ).get(projectId, taskId) as Record<string, unknown>;

      if ((hardDepCount.count as number) > 0) {
        const unresolved = getUnresolvedBlockers(projectId, taskId, db);
        if (unresolved.length === 0) {
          const depResult = transitionTask(
            {
              projectId,
              taskId,
              toState: "OPEN",
              actor: "system:sweep",
              reason: "Auto-unblocked: all dependencies are DONE",
              verificationRequired: false,
              withinTransaction: true,
            },
            db,
          );
          if (depResult.ok) {
            staleUnblocked++;
            continue;
          }
        }
      }

      // Recover parent-task-blocked children when the parent is DONE.
      // This is a backstop for the auto-unblock in transitionTask that fires
      // when a parent completes — catches cases where that event was missed.
      const taskRow = db.prepare(
        "SELECT parent_task_id, assigned_to FROM tasks WHERE id = ? AND project_id = ?",
      ).get(taskId, projectId) as Record<string, unknown> | undefined;

      if (taskRow?.parent_task_id) {
        const parentState = db.prepare(
          "SELECT state FROM tasks WHERE id = ? AND project_id = ?",
        ).get(taskRow.parent_task_id as string, projectId) as Record<string, unknown> | undefined;

        if (parentState && (parentState.state as string) === "DONE") {
          const toState = taskRow.assigned_to ? "ASSIGNED" : "OPEN";
          const parentResult = transitionTask(
            {
              projectId,
              taskId,
              toState: toState as TaskState,
              actor: "system:sweep",
              reason: "Auto-unblocked: parent task is DONE",
              verificationRequired: false,
              withinTransaction: true,
            },
            db,
          );
          if (parentResult.ok) staleUnblocked++;
        }
      }
    }

    // 1.6. Recover orphaned tasks assigned to dead cron session agent IDs.
    // Tasks get assigned to session-specific IDs like "agent:cf-worker:cron:uuid".
    // When that cron session dies, the task is orphaned. Reassign to the base agent ID.
    try {
      const cronAssignedTasks = db.prepare(
        "SELECT id, assigned_to FROM tasks WHERE project_id = ? AND assigned_to LIKE '%:cron:%' AND state NOT IN ('DONE', 'FAILED', 'CANCELLED')",
      ).all(projectId) as Record<string, unknown>[];

      if (cronAssignedTasks.length > 0) {
        // Build a set of active session keys
        const activeSessionKeys = new Set(
          getActiveSessions().map((s) => s.sessionKey),
        );

        // Also check the tracked_sessions table (persisted sessions survive process restarts)
        const persistedSessionRows = db.prepare(
          "SELECT session_key FROM tracked_sessions WHERE project_id = ?",
        ).all(projectId) as Record<string, unknown>[];
        for (const row of persistedSessionRows) {
          activeSessionKeys.add(row.session_key as string);
        }

        for (const row of cronAssignedTasks) {
          const taskId = row.id as string;
          const assignedTo = row.assigned_to as string;

          // Check if a session exists for this cron agent ID
          const hasActiveSession = [...activeSessionKeys].some(
            (key) => key.includes(assignedTo) || assignedTo.includes(key),
          );
          if (hasActiveSession) continue;

          // Extract base agent ID: "agent:cf-worker:cron:uuid" → "cf-worker"
          // Pattern: everything before ":cron:" and after the optional "agent:" prefix
          const cronIdx = assignedTo.indexOf(":cron:");
          if (cronIdx === -1) continue;
          let baseAgentId = assignedTo.slice(0, cronIdx);
          if (baseAgentId.startsWith("agent:")) {
            baseAgentId = baseAgentId.slice("agent:".length);
          }

          // Reassign to the base agent ID
          db.prepare(
            "UPDATE tasks SET assigned_to = ?, updated_at = ? WHERE id = ? AND project_id = ?",
          ).run(baseAgentId, now, taskId, projectId);

          orphanedCronRecovered++;
          emitDiagnosticEvent({
            type: "sweep_orphaned_cron_recovered",
            projectId,
            taskId,
            oldAssignedTo: assignedTo,
            newAssignedTo: baseAgentId,
          });
        }
      }
    } catch (err) {
      safeLog("sweep.orphanedCronRecovery", err);
    }

    // 2. Enforce deadlines — stays direct (safety-critical, no delay acceptable)
    const overdue = db
      .prepare("SELECT id, project_id FROM tasks WHERE project_id = ? AND deadline IS NOT NULL AND deadline < ? AND state NOT IN ('DONE', 'FAILED', 'CANCELLED')")
      .all(projectId, now) as Record<string, unknown>[];

    for (const row of overdue) {
      const taskId = row.id as string;
      const result = transitionTask(
        {
          projectId,
          taskId,
          toState: "FAILED",
          actor: "system:sweep",
          reason: "Deadline exceeded",
          verificationRequired: false,
          withinTransaction: true,
        },
        db,
      );
      if (result.ok) deadlineExpired++;
    }

    // 3. Advance workflows
    const workflows = listWorkflows(projectId, db);
    for (const workflow of workflows) {
      if (workflow.state !== "active") continue;
      const advanced = advanceWorkflow(projectId, workflow.id, db);
      if (advanced !== null) {
        workflowsAdvanced++;
      } else {
        // Stall detection for all gate types
        const phaseStatus = getPhaseStatus(projectId, workflow.id, workflow.currentPhase, db);
        if (phaseStatus) {
          let stalled = false;
          let hint = "";

          // Empty phases stall forever
          if (phaseStatus.total === 0) {
            stalled = true;
            hint = "Phase has 0 tasks — add tasks or skip this phase";
          } else {
            switch (phaseStatus.gateCondition) {
              case "all_done":
                if (phaseStatus.failed > 0) {
                  stalled = true;
                  hint = "Consider using gate_condition: 'all_resolved'";
                }
                break;
              case "any_done":
                // Stalled if all tasks resolved but none completed
                if (phaseStatus.resolved === phaseStatus.total && phaseStatus.completed === 0) {
                  stalled = true;
                  hint = "All tasks failed/resolved but none completed — gate requires at least one DONE";
                }
                break;
              case "all_resolved":
                // Stalled if some tasks are stuck in non-terminal states and won't resolve
                if (phaseStatus.resolved === phaseStatus.total && phaseStatus.completed === 0) {
                  stalled = true;
                  hint = "All tasks resolved but none completed — gate requires at least one DONE";
                }
                break;
              case "any_resolved":
                // Stalled if all tasks resolved but none completed
                if (phaseStatus.resolved === phaseStatus.total && phaseStatus.completed === 0) {
                  stalled = true;
                  hint = "All tasks resolved but none completed — gate requires at least one DONE";
                }
                break;
            }
          }

          if (stalled) {
            emitDiagnosticEvent({
              type: "workflow_phase_stalled",
              workflowId: workflow.id,
              phase: workflow.currentPhase,
              gateCondition: phaseStatus.gateCondition,
              failedTasks: phaseStatus.failed,
              totalTasks: phaseStatus.total,
              hint,
            });
          }
        }
      }
    }

    // 4. Escalate exhausted FAILED tasks — emit events instead of direct mutation
    const exhausted = db
      .prepare("SELECT id FROM tasks WHERE project_id = ? AND state = 'FAILED' AND retry_count >= max_retries AND COALESCE(json_extract(metadata, '$.escalated'), false) = false")
      .all(projectId) as Record<string, unknown>[];

    for (const row of exhausted) {
      const taskId = row.id as string;
      // Mark as escalated
      db.prepare("UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.escalated', true, '$.escalated_at', ?) WHERE id = ?")
        .run(now, taskId);
      escalated++;
      emitDiagnosticEvent({ type: "task_escalated", taskId, projectId });

      // Emit event for escalation
      ingestEvent(projectId, "sweep_finding", "cron", {
        finding: "retry_exhausted",
        taskId,
      }, sweepDedupKey("escalated", taskId), db);
    }

    // 5. Expire stale proposals past TTL or explicit timeout — stays direct (low-risk, no dispatch)
    const ttlCutoff = now - proposalTtl;
    const staleProposals = db
      .prepare(
        "SELECT id FROM proposals WHERE project_id = ? AND status = 'pending' AND (created_at < ? OR (timeout_at IS NOT NULL AND timeout_at < ?))",
      )
      .all(projectId, ttlCutoff, now) as Record<string, unknown>[];

    for (const row of staleProposals) {
      const proposalId = row.id as string;
      db.prepare(
        "UPDATE proposals SET status = 'rejected', user_feedback = ?, resolved_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'",
      ).run("Auto-expired: exceeded TTL", now, proposalId, projectId);
      proposalsExpired++;
      emitDiagnosticEvent({ type: "proposal_expired", proposalId, projectId });
      try {
        ingestEvent(projectId, "proposal_rejected", "internal", {
          proposalId, feedback: "Auto-expired: exceeded TTL",
        }, `proposal-rejected:${proposalId}`, db);
      } catch { /* non-fatal */ }
    }

    try {
      proposalExecutionsRecovered = reconcileApprovedWorkflowMutationExecutions(projectId, db);
    } catch (err) {
      safeLog("sweep.proposalExecutionRecovery", err);
    }

    // 5.5. Expire timed-out protocols
    try {
      const { getExpiredProtocols, expireProtocol, escalateProtocol } = await import("../messaging/protocols.js");
      const { createMessage: createMsg } = await import("../messaging/store.js");

      const expired = getExpiredProtocols(projectId, now, db);
      for (const msg of expired) {
        expireProtocol(msg.id, db);

        const escalationMsg = createMsg({
          fromAgent: "system:sweep",
          toAgent: msg.fromAgent,
          projectId,
          type: "escalation",
          priority: "high",
          content: `Protocol expired: your ${msg.type} to ${msg.toAgent} received no response within the deadline. Message ID: ${msg.id.slice(0, 8)}`,
          parentMessageId: msg.id,
        }, db);

        escalateProtocol(msg.id, escalationMsg.id, db);
        protocolsExpired++;

        ingestEvent(projectId, "protocol_expired", "cron", {
          messageId: msg.id, protocolType: msg.type,
          fromAgent: msg.fromAgent, toAgent: msg.toAgent,
        }, sweepDedupKey("proto-expired", msg.id), db);
      }
    } catch (err) {
      safeLog("sweep.protocolTimeout", err);
    }

    // 5.7. Detect active goals with no decomposition plan
    try {
      const activeGoals = db.prepare(
        "SELECT id, title FROM goals WHERE project_id = ? AND status = 'active'",
      ).all(projectId) as Record<string, unknown>[];

      for (const goal of activeGoals) {
        const goalId = goal.id as string;
        const hasChildren = db.prepare("SELECT 1 FROM goals WHERE parent_goal_id = ? LIMIT 1").get(goalId);
        const hasTasks = db.prepare("SELECT 1 FROM tasks WHERE goal_id = ? LIMIT 1").get(goalId);
        if (!hasChildren && !hasTasks) {
          goalsNeedingPlan++;
          ingestEvent(projectId, "sweep_finding", "cron", {
            finding: "goal_no_plan", goalId, goalTitle: goal.title as string,
          }, sweepDedupKey("goal-no-plan", goalId), db);
        }
      }
    } catch (err) {
      safeLog("sweep.goalsNoPlan", err);
    }

    // 5.8. Escalate stale REVIEW tasks past configured timeout
    try {
      const extConfig = getExtendedProjectConfig(projectId);
      const reviewConfig = extConfig?.review;
      if (reviewConfig?.autoEscalateAfterHours && reviewConfig.autoEscalateAfterHours > 0) {
        const escalateThresholdMs = reviewConfig.autoEscalateAfterHours * 3_600_000;
        const reviewTasks = db.prepare(
          "SELECT id, title, assigned_to FROM tasks WHERE project_id = ? AND state = 'REVIEW' AND (metadata IS NULL OR json_extract(metadata, '$.review_escalated') IS NULL)",
        ).all(projectId) as Record<string, unknown>[];

        for (const row of reviewTasks) {
          const taskId = row.id as string;

          // Find when task entered REVIEW from last transition
          const lastTransition = db.prepare(
            "SELECT created_at FROM transitions WHERE task_id = ? AND to_state = 'REVIEW' ORDER BY created_at DESC LIMIT 1",
          ).get(taskId) as Record<string, unknown> | undefined;
          const reviewEnteredAt = lastTransition?.created_at as number | undefined;
          if (!reviewEnteredAt) continue;

          if (now - reviewEnteredAt > escalateThresholdMs) {
            // Mark as review-escalated to prevent re-escalation
            db.prepare(
              "UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.review_escalated', true, '$.review_escalated_at', ?) WHERE id = ?",
            ).run(now, taskId);

            // Send escalation message to manager
            const managerAgent = findManagerAgent(projectId);
            if (managerAgent) {
              createMessage({
                fromAgent: "system:sweep",
                toAgent: managerAgent,
                projectId,
                type: "escalation",
                priority: "high",
                content: `Review timeout: Task "${row.title}" (${taskId.slice(0, 8)}) has been in REVIEW for ${Math.round((now - reviewEnteredAt) / 3_600_000)}h with no verifier action. Assigned to: ${row.assigned_to ?? "unassigned"}.`,
              }, db);
            }

            // Emit event for user-defined handlers
            ingestEvent(projectId, "sweep_finding", "cron", {
              finding: "review_stale",
              taskId,
              reviewDurationHours: Math.round((now - reviewEnteredAt) / 3_600_000),
              assignedTo: row.assigned_to,
            }, sweepDedupKey("review-stale", taskId), db);

            reviewEscalated++;
          }
        }
      }
    } catch (err) {
      safeLog("sweep.reviewEscalation", err);
    }

    // 6. Enforce worker compliance — stays direct (enforcement, not dispatch)
    const incompliant = getIncompliantWorkers().filter((w) => w.projectId === projectId);
    const staleComplianceThreshold = 30 * 60_000; // 30 min — give workers time to finish
    for (const worker of incompliant) {
      if (now - worker.trackedAt > staleComplianceThreshold) {
        if (enforceWorkerCompliance(worker.sessionKey, db, { withinTransaction: true })) {
          complianceBlocked++;
        }
      }
    }

    // 7. Reclaim expired dispatch queue leases
    leasesReclaimed = reclaimExpiredLeases(projectId, db, { withinTransaction: true });

    // 7.0.1 Release stale budget reservations from leased items that never completed
    try {
      reservationsReleased = releaseStaleReservations(db, projectId, undefined, { withinTransaction: true });
      if (reservationsReleased > 0) {
        safeLog("sweep.reservationCleanup", `Released ${reservationsReleased} stale reservations`);
      }
    } catch (err) {
      safeLog("sweep.reservationCleanup", err);
    }

    // 7.0.2 Recover orphaned one-shot dispatch cron jobs before queue recovery.
    //
    // In the hosted OpenClaw path, dispatch currently works by creating delete-after-run
    // cron jobs named `dispatch:<projectId>:<queueItemId>`. Legacy jobs used
    // `dispatch:<queueItemId>`. If those jobs never start, or get stuck in
    // `runningAtMs` with no tracked session, they block later isolated dispatches for the
    // same agent. Recover them here instead of waiting for the generic stale-dispatch timeout.
    try {
      const cronService = getCronService();
      if (cronService?.list && cronService.remove) {
        const cronMisfireGraceMs = 60_000;
        const activeSessionDispatchIds = collectActiveSessionDispatchIds(projectId, db);
        const jobs = await cronService.list({ includeDisabled: true });

        for (const job of jobs) {
          if (!job.deleteAfterRun) continue;
          const parsedJob = parseDispatchCronJobName(job.name);
          if (!parsedJob) continue;
          if (parsedJob.projectId && parsedJob.projectId !== projectId) continue;

          const queueItemId = parsedJob.queueItemId;
          if (activeSessionDispatchIds.has(queueItemId)) continue;

          const queueRow = db.prepare(
            "SELECT task_id, status, dispatch_attempts, max_dispatch_attempts FROM dispatch_queue WHERE id = ? AND project_id = ? LIMIT 1",
          ).get(queueItemId, projectId) as {
            task_id?: string;
            status?: string;
            dispatch_attempts?: number;
            max_dispatch_attempts?: number;
          } | undefined;

          const taskId = queueRow?.task_id ?? null;
          const queueStatus = queueRow?.status ?? null;
          const dispatchAttempts = queueRow?.dispatch_attempts ?? 0;
          const maxDispatchAttempts = queueRow?.max_dispatch_attempts ?? 0;
          const isTerminal = queueStatus != null && ["completed", "failed", "cancelled"].includes(queueStatus);
          const isMissingForCurrentProject = queueStatus == null;
          const runningAtMs = job.state?.runningAtMs;
          const nextRunAtMs = job.state?.nextRunAtMs;
          const staleRunning = typeof runningAtMs === "number" && now - runningAtMs > staleDispatchTimeout;
          const missedStart = typeof nextRunAtMs === "number" && now - nextRunAtMs > cronMisfireGraceMs;

          if (isMissingForCurrentProject && parsedJob.legacy) continue;
          if (!isTerminal && !isMissingForCurrentProject && !staleRunning && !missedStart) continue;

          await cronService.remove(job.id);

          if (taskId && queueStatus && ["leased", "dispatched"].includes(queueStatus)) {
            const reason = staleRunning
              ? `Recovered stale dispatch cron job after ${Math.round((now - runningAtMs!) / 60_000)}m with no active session`
              : `Recovered missed dispatch cron job after ${Math.round((now - nextRunAtMs!) / 1000)}s with no active session`;
            const exhausted = maxDispatchAttempts > 0 && dispatchAttempts >= maxDispatchAttempts;

            if (exhausted) {
              failQueueItem(
                queueItemId,
                `${reason}; exhausted dispatch retries`,
                db,
                projectId,
                { withinTransaction: true },
              );
              ingestEvent(projectId, "dispatch_dead_letter", "internal", {
                taskId,
                queueItemId,
                attempts: dispatchAttempts,
                lastError: `${reason}; exhausted dispatch retries`,
              }, `dead-letter:${queueItemId}`, db);
            } else {
              releaseToQueued(queueItemId, reason, db, projectId, {
                withinTransaction: true,
                undoDispatchAttempt: false,
              });
            }

            try {
              const taskRow = db.prepare(
                "SELECT lease_holder FROM tasks WHERE project_id = ? AND id = ?",
              ).get(projectId, taskId) as { lease_holder?: string | null } | undefined;
              const expectedHolder = `dispatch:${queueItemId}`;
              if (taskRow?.lease_holder === expectedHolder) {
                releaseTaskLease(projectId, taskId, expectedHolder, db);
              }
            } catch (err) {
              safeLog("sweep.dispatchCronReleaseLease", err);
            }

            emitDiagnosticEvent({
              type: exhausted ? "dispatch_cron_dead_lettered" : "dispatch_cron_recovered",
              projectId,
              taskId,
              queueItemId,
              queueStatus,
              recovery: staleRunning ? "stale_running" : "missed_start",
              attempts: dispatchAttempts,
              maxAttempts: maxDispatchAttempts,
            });

            ingestEvent(projectId, "sweep_finding", "cron", {
              finding: exhausted ? "dispatch_cron_dead_lettered" : "dispatch_cron_recovered",
              taskId,
              queueItemId,
              queueStatus,
              recovery: staleRunning ? "stale_running" : "missed_start",
              attempts: dispatchAttempts,
              maxAttempts: maxDispatchAttempts,
            }, sweepDedupKey("dispatch-cron", queueItemId), db);
          } else {
            emitDiagnosticEvent({
              type: "dispatch_cron_removed",
              projectId,
              queueItemId,
              queueStatus: queueStatus ?? "missing",
            });
          }

          orphanedCronRecovered++;
        }
      }
    } catch (err) {
      safeLog("sweep.dispatchCronRecovery", err);
    }

    // 7.1. Recover dispatch queue items stuck in 'dispatched' state with no active session
    try {
      const dispatchedItems = db.prepare(
        `SELECT id, task_id, created_at, dispatched_at, dispatch_attempts, max_dispatch_attempts FROM dispatch_queue
         WHERE project_id = ? AND status = 'dispatched'`,
      ).all(projectId) as Record<string, unknown>[];

      if (dispatchedItems.length > 0) {
        const activeSessionDispatchIds = collectActiveSessionDispatchIds(projectId, db);

        for (const row of dispatchedItems) {
          const itemId = row.id as string;
          const taskId = row.task_id as string;
          // Use dispatched_at if available (new column), fall back to created_at for pre-migration items
          const dispatchedAt = (row.dispatched_at as number | null) ?? (row.created_at as number);

          // Skip items that haven't been dispatched long enough
          if (now - dispatchedAt < staleDispatchTimeout) continue;

          // Skip items that have an active session backing them
          if (activeSessionDispatchIds.has(itemId)) continue;

          // No active session and past the timeout — fail the queue item and re-enqueue
          const staleDurationMs = now - dispatchedAt;
          failQueueItem(
            itemId,
            `Stale dispatched item: no active session after ${Math.round(staleDurationMs / 60_000)}m`,
            db,
            projectId,
            { withinTransaction: true },
          );

          try {
            const taskRow = db.prepare(
              "SELECT lease_holder FROM tasks WHERE project_id = ? AND id = ?",
            ).get(projectId, taskId) as { lease_holder?: string | null } | undefined;
            const expectedHolder = `dispatch:${itemId}`;
            if (taskRow?.lease_holder === expectedHolder) {
              releaseTaskLease(projectId, taskId, expectedHolder, db);
            }
          } catch (err) {
            safeLog("sweep.staleDispatchReleaseLease", err);
          }

          // Re-enqueue the task for retry (skip failed dedup — this IS the recovery)
          enqueue(projectId, taskId, undefined, undefined, db, undefined, undefined, true, true);

          emitDiagnosticEvent({
            type: "dispatch_stale_recovered",
            projectId,
            taskId,
            queueItemId: itemId,
            staleDurationMs,
          });

          ingestEvent(projectId, "sweep_finding", "cron", {
            finding: "stale_dispatch_recovered",
            taskId,
            queueItemId: itemId,
            staleDurationMs,
          }, sweepDedupKey("stale-dispatch", itemId), db);

          staleDispatchRecoveredCount++;
        }
      }
    } catch (err) {
      safeLog("sweep.staleDispatchRecovery", err);
    }

    // 7.1.1 Recover ASSIGNED tasks still holding a dispatch lease after the
    // owning queue item has already reached a terminal state or disappeared.
    try {
      const activeSessionDispatchIds = collectActiveSessionDispatchIds(projectId, db);

      const leasedAssignedTasks = db.prepare(
        `SELECT id, lease_holder FROM tasks
         WHERE project_id = ? AND state = 'ASSIGNED' AND lease_holder LIKE 'dispatch:%'`,
      ).all(projectId) as { id: string; lease_holder: string }[];

      for (const row of leasedAssignedTasks) {
        const taskId = row.id;
        const leaseHolder = row.lease_holder;
        const queueItemId = leaseHolder.slice("dispatch:".length);

        if (!queueItemId) continue;
        if (activeSessionDispatchIds.has(queueItemId)) continue;

        const queueRow = db.prepare(
          "SELECT status FROM dispatch_queue WHERE id = ? AND project_id = ? LIMIT 1",
        ).get(queueItemId, projectId) as { status?: string } | undefined;

        const queueStatus = queueRow?.status ?? null;
        const isTerminalOrMissing = queueStatus == null || ["completed", "failed", "cancelled"].includes(queueStatus);
        if (!isTerminalOrMissing) continue;

        releaseTaskLease(projectId, taskId, leaseHolder, db);
        enqueue(projectId, taskId, undefined, undefined, db, undefined, undefined, true, true);

        emitDiagnosticEvent({
          type: "dispatch_orphaned_lease_recovered",
          projectId,
          taskId,
          queueItemId,
          queueStatus: queueStatus ?? "missing",
        });

        ingestEvent(projectId, "sweep_finding", "cron", {
          finding: "orphaned_dispatch_lease_recovered",
          taskId,
          queueItemId,
          queueStatus: queueStatus ?? "missing",
        }, sweepDedupKey("orphaned-dispatch", `${taskId}:${queueItemId}`), db);

        orphanedDispatchRecoveredCount++;
      }
    } catch (err) {
      safeLog("sweep.orphanedDispatchLeaseRecovery", err);
    }

    // 7.1.2 Backstop dead-lettered active tasks into BLOCKED.
    //
    // The event router handles this immediately for new dispatch_dead_letter
    // events, but sweep also needs to reconcile existing domains so the task
    // lifecycle matches the feed lifecycle even after upgrades or missed
    // events.
    try {
      const deadLetteredActiveTasks = db.prepare(
        `SELECT id FROM tasks
         WHERE project_id = ?
           AND state IN ('ASSIGNED', 'IN_PROGRESS', 'BLOCKED')
           AND (
             json_extract(COALESCE(metadata, '{}'), '$.dispatch_dead_letter') = 1
             OR json_extract(COALESCE(metadata, '{}'), '$.\"$.dispatch_dead_letter\"') = 1
           )`,
      ).all(projectId) as Array<{ id: string }>;

      for (const row of deadLetteredActiveTasks) {
        const task = getTask(projectId, row.id, db);
        if (!task) continue;
        const resolvedIssue = getResolvedLinkedIssueForTask(projectId, task, db);
        if (resolvedIssue) {
          transitionTask({
            projectId,
            taskId: row.id,
            toState: "CANCELLED",
            actor: "system:sweep",
            reason: "Linked entity issue already resolved; clearing dead-letter remediation task",
            verificationRequired: false,
            withinTransaction: true,
          }, db);
          continue;
        }

        if (task.state === "ASSIGNED" || task.state === "IN_PROGRESS") {
          transitionTask({
            projectId,
            taskId: row.id,
            toState: "BLOCKED",
            actor: "system:sweep",
            reason: "Dispatch retries exhausted; operator review required",
            verificationRequired: false,
            withinTransaction: true,
          }, db);
        }
      }
    } catch (err) {
      safeLog("sweep.deadLetterBackstop", err);
    }

    db.exec("COMMIT");

    // 7.5 Reset daily budgets (outside transaction — idempotent)
    try {
      budgetsReset = resetDailyBudgets(projectId, db);
    } catch (err) {
      safeLog("sweep.budgetReset", err);
    }
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back or no transaction */ }
    throw err;
  }

  // 8. Detect and kill stuck agents (external operation — outside transaction)
  const stuck = detectStuckAgents({
    stuckTimeoutMs: options.stuckTimeoutMs,
  });
  // Filter to agents belonging to this project
  const projectStuck = stuck.filter((s) => s.projectId === projectId);
  const persistedStuck = detectPersistedStuckAgents(projectId, db, {
    stuckTimeoutMs: options.stuckTimeoutMs,
  });
  const mergedStuck = [...new Map(
    [...projectStuck, ...persistedStuck].map((session) => [session.sessionKey, session]),
  ).values()];
  const stuckKilled = await killAllStuckAgents(mergedStuck);

  try {
    orphanedDispatchRecoveredCount += recoverStrandedRecurringDispatches(projectId, db);
  } catch (err) {
    safeLog("sweep.recurringDispatchRecovery", err);
  }

  // 9. Backstop: process pending events + drain dispatch queue
  let eventsProcessed = 0;
  let dispatched = 0;
  try {
    const result = await drainWorkflowBackstop(projectId, db, {
      dispatchMode: options.backstopDispatchMode ?? "full",
    });
    eventsProcessed = result.eventsProcessed;
    dispatched = result.dispatched;
  } catch (err) {
    safeLog("sweep.processAndDispatch", err);
  }

  // 10. Monitoring feedback loops (SLOs, anomaly detection, alert rules)
  let sloChecked = 0;
  let sloBreach = 0;
  let alertsFired = 0;
  let anomaliesDetected = 0;
  try {
    // Lazy import to avoid circular deps
    const { runMonitoringSweep } = await import("../monitoring/sweep-step.js");
    const extConfig = getExtendedProjectConfig(projectId);
    const monResult = runMonitoringSweep(projectId, extConfig, db);
    sloChecked = monResult.sloChecked;
    sloBreach = monResult.sloBreach;
    alertsFired = monResult.alertsFired;
    anomaliesDetected = monResult.anomaliesDetected;
  } catch (err) {
    safeLog("sweep.monitoring", err);
  }

  // 11. Goal completion cascade
  try {
    const { checkGoalCascade } = await import("../goals/cascade.js");
    const cascadeResult = checkGoalCascade(projectId, db);
    goalsCascadeAchieved = cascadeResult.achieved;
  } catch (err) {
    safeLog("sweep.goalCascade", err);
  }

  // 12. Auto-assign orphaned OPEN tasks (BACKSTOP — not the primary assignment path).
  //
  // The primary assignment path is:
  //   createTask() → task_created event → handleTaskCreated() → autoAssign()
  //
  // This backstop catches tasks that slipped through event processing (e.g. event
  // router was down, event was lost, race condition). Only considers tasks older
  // than 60s to avoid racing with handleTaskCreated() which handles freshly created tasks.
  let autoAssigned = 0;
  try {
    const extConfig = getExtendedProjectConfig(projectId);
    if (extConfig?.assignment?.enabled) {
      const { autoAssign } = await import("../assignment/engine.js");
      const BACKSTOP_AGE_MS = 60_000; // 60s — give event processing time to handle it
      const openTasks = db.prepare(
        "SELECT id FROM tasks WHERE project_id = ? AND state = 'OPEN' AND assigned_to IS NULL AND created_at < ?",
      ).all(projectId, now - BACKSTOP_AGE_MS) as Record<string, unknown>[];

      for (const row of openTasks) {
        const taskId = row.id as string;
        const result = autoAssign(projectId, taskId, extConfig.assignment, db);
        if (result.assigned) autoAssigned++;
      }
    }
  } catch (err) {
    safeLog("sweep.autoAssign", err);
  }

  // 5b. Spend rate warning check
  try {
    const spendWarning = checkSpendRateWarning(projectId, undefined, db);
    if (spendWarning.warning && spendWarning.reason) {
      ingestEvent(projectId, "sweep_finding", "cron", {
        finding: "spend_rate_warning",
        pct: spendWarning.pct,
        reason: spendWarning.reason,
      }, sweepDedupKey("spend-warning", projectId), db);
    }
  } catch (err) {
    safeLog("sweep.spendRateWarning", err);
  }

  // 6. Detect stale meetings (no activity for >2h)
  try {
    const activeMeetings = db.prepare(
      "SELECT id, name, created_at FROM channels WHERE project_id = ? AND type = 'meeting' AND status = 'active'",
    ).all(projectId) as Record<string, unknown>[];

    for (const row of activeMeetings) {
      const channelId = row.id as string;
      const lastMsg = db.prepare(
        "SELECT created_at FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1",
      ).get(channelId) as Record<string, unknown> | undefined;

      const lastActivity = (lastMsg?.created_at as number) ?? (row.created_at as number);
      if (now - lastActivity > 2 * 60 * 60 * 1000) {
        ingestEvent(projectId, "sweep_finding", "cron", {
          finding: "meeting_stale",
          channelId,
          channelName: row.name,
          staleSinceMs: now - lastActivity,
        }, sweepDedupKey("meeting-stale", channelId), db);
        meetingsStale++;
      }
    }
  } catch (err) {
    safeLog("sweep.staleMeetings", err);
  }

  // 13. Schedule due recurring jobs (cron + frequency) through the normal task workflow
  let frequencyDispatched = 0;
  try {
    const recurringJobs = scheduleDueRecurringJobs(projectId, db, now);
    for (const job of recurringJobs) {
      ingestEvent(projectId, "sweep_finding", "cron", {
        finding: "recurring_job_scheduled",
        agentId: job.agentId,
        jobName: job.jobName,
        reason: job.reason,
        taskId: job.task.id,
      }, sweepDedupKey("recurring-job", `${job.agentId}:${job.jobName}:${job.task.id}`), db);
      frequencyDispatched++;
    }
  } catch (err) {
    safeLog("sweep.recurringJobs", err);
  }

  // 14. Auto-recovery for disabled agents
  let agentsRecovered = 0;
  let agentsEscalated = 0;
  try {
    const { checkAutoRecovery } = await import("../enforcement/auto-recovery.js");
    const recovery = checkAutoRecovery(projectId, db);
    agentsRecovered = recovery.recovered;
    agentsEscalated = recovery.escalated;
  } catch (err) {
    safeLog("sweep.autoRecovery", err);
  }

    return {
      stale, autoBlocked, deadlineExpired, workflowsAdvanced, escalated,
      complianceBlocked, stuckKilled, proposalsExpired, protocolsExpired,
      proposalExecutionsRecovered,
      goalsNeedingPlan, goalsCascadeAchieved,
      leasesReclaimed, staleDispatchRecovered: staleDispatchRecoveredCount, orphanedDispatchRecovered: orphanedDispatchRecoveredCount, reservationsReleased,
      eventsProcessed, dispatched, budgetsReset, autoAssigned,
      sloChecked, sloBreach, alertsFired, anomaliesDetected,
      reviewEscalated, meetingsStale, frequencyDispatched,
      orphanedCronRecovered, agentsRecovered, agentsEscalated,
      controller: {
        skipped: false,
        ownerId: controllerLease.lease.ownerId,
        ownerLabel: controllerLease.lease.ownerLabel,
        purpose: controllerLease.lease.purpose,
        expiresAt: controllerLease.lease.expiresAt,
      },
    };
  } finally {
    if (controllerLease.acquiredNew) {
      try {
        releaseControllerLease(projectId, controllerLease.lease.ownerId, db);
      } catch (err) {
        safeLog("sweep.releaseControllerLease", err);
      }
    }
  }
}
