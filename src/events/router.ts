/**
 * Clawforce — Event router
 *
 * Claims pending events and routes each to a type-specific handler.
 * Built-in handlers:
 * - task_completed/task_failed → check workflow phase gates, enqueue next phase
 * - sweep_finding → create/escalate task based on finding
 * - custom → no-op (extensibility point)
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";
import type { ClawforceEvent } from "../types.js";
import { claimPendingEvents, ingestEvent, markFailed, markHandled, markIgnored } from "./store.js";
import { enqueue } from "../dispatch/queue.js";
import { createTask, getTask, getTaskEvidence, transitionTask } from "../tasks/ops.js";
import { cascadeUnblock } from "../tasks/deps.js";
import { gatherFailureAnalysis, recordReplanAttempt } from "../planning/replan.js";
import { getAgentModel } from "../config/openclaw-reader.js";
import { handleWorkflowCompletion, handleGoalAchieved } from "../planning/completion.js";
import { advanceWorkflow, getWorkflow } from "../workflow.js";
import { getRegisteredAgentIds, getAgentConfig, getExtendedProjectConfig } from "../project.js";
import { recordMetric } from "../metrics.js";
import { executeAction, type ActionResult } from "./actions.js";
import { writeAuditEntry } from "../audit.js";
import {
  getProposal,
  markProposalExecutionApplied,
  markProposalExecutionFailed,
} from "../approval/resolve.js";
import { getIntentByProposalForProject, resolveIntentForProject } from "../approval/intent-store.js";
import { addPreApproval } from "../approval/pre-approved.js";
import { getSimulatedActionByProposal, setSimulatedActionStatus } from "../execution/simulated-actions.js";
import { replaySimulatedCommand } from "../execution/replay.js";
import { advanceMeetingTurn, concludeMeeting } from "../channels/meeting.js";
import { autoAssign } from "../assignment/engine.js";
import { recordTrustDecision } from "../trust/tracker.js";
import { getEntityIssue, transitionEntity } from "../entities/ops.js";
import {
  closeIssueRemediationTasks,
  ensureIssueRemediationTask,
  getResolvedLinkedIssueForTask,
  maybeRerunIssueChecksForTask,
} from "../entities/remediation.js";
import { reconcileEntityReadiness } from "../entities/lifecycle.js";
import { reconcileEntityStateSignals } from "../entities/state-signals.js";
import type { WorkflowMutationProposalSnapshot, WorkflowMutationTaskSpec } from "../types.js";
import {
  buildWorkflowMutationImplementationDescription,
  maybeNormalizeWorkflowMutationImplementationTask,
} from "../workflow-mutation/implementation.js";
import { getRecurringJobMetadata, markRecurringJobFinished } from "../scheduling/recurring-jobs.js";

export type EventHandlerResult = {
  action: "handled" | "ignored" | "enqueued";
  taskId?: string;
  queueItemId?: string;
};

export type EventHandler = (
  event: ClawforceEvent,
  db: DatabaseSync,
) => EventHandlerResult;

// ---------------------------------------------------------------------------
// Unified handler registry
// ---------------------------------------------------------------------------

const builtinHandlers = new Map<string, EventHandler>();

/**
 * Register a built-in handler for an event type.
 * Built-in handlers run before user-defined actions and can be overridden
 * by user config setting `override_builtin: true`.
 */
export function registerBuiltinHandler(eventType: string, handler: EventHandler): void {
  builtinHandlers.set(eventType, handler);
}

/** Get the built-in handler for an event type (or undefined). */
export function getBuiltinHandler(eventType: string): EventHandler | undefined {
  return builtinHandlers.get(eventType);
}

/** Reset the registry (for testing). */
export function resetHandlerRegistryForTest(): void {
  builtinHandlers.clear();
  initBuiltinHandlers();
}

/**
 * Populate the built-in handler registry. Called once at module load and
 * can be re-called via resetHandlerRegistryForTest().
 */
function initBuiltinHandlers(): void {
  registerBuiltinHandler("task_completed", handleTaskCompleted);
  registerBuiltinHandler("task_failed", handleTaskFailed);
  registerBuiltinHandler("task_assigned", handleTaskAssigned);
  registerBuiltinHandler("task_created", handleTaskCreated);
  registerBuiltinHandler("sweep_finding", handleSweepFinding);
  registerBuiltinHandler("dispatch_succeeded", handleDispatchSucceeded);
  registerBuiltinHandler("dispatch_failed", handleDispatchFailed);
  registerBuiltinHandler("task_review_ready", handleTaskReviewReady);
  registerBuiltinHandler("dispatch_dead_letter", handleDispatchDeadLetter);
  registerBuiltinHandler("proposal_approved", handleProposalApproved);
  registerBuiltinHandler("proposal_created", handleProposalCreated);
  registerBuiltinHandler("proposal_rejected", handleProposalRejected);
  registerBuiltinHandler("entity_issue_opened", handleEntityIssueChanged);
  registerBuiltinHandler("entity_issue_updated", handleEntityIssueChanged);
  registerBuiltinHandler("entity_issue_resolved", handleEntityIssueResolved);
  registerBuiltinHandler("entity_created", handleEntityChanged);
  registerBuiltinHandler("entity_updated", handleEntityChanged);
  registerBuiltinHandler("meeting_turn_completed", handleMeetingTurnCompleted);
  registerBuiltinHandler("replan_needed", handleReplanNeeded);
  registerBuiltinHandler("workflow_completed", handleWorkflowCompleted);
  registerBuiltinHandler("goal_achieved", handleGoalAchievedEvent);
  registerBuiltinHandler("project_completed", handleCustom);
  registerBuiltinHandler("meeting_started", handleCustom);
  registerBuiltinHandler("meeting_concluded", handleCustom);
  registerBuiltinHandler("channel_created", handleCustom);
  registerBuiltinHandler("custom", handleCustom);
  registerBuiltinHandler("ci_failed", handleCustom);
  registerBuiltinHandler("pr_opened", handleCustom);
  registerBuiltinHandler("deploy_finished", handleCustom);
}

// Initialize at module load
initBuiltinHandlers();

/**
 * Claim and process pending events for a project.
 * Returns the number of events processed.
 */
export function processEvents(
  projectId: string,
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);
  const events = claimPendingEvents(projectId, 50, db);

  // Load user event handlers once per batch
  const extConfig = getExtendedProjectConfig(projectId);
  const userHandlers = extConfig?.eventHandlers ?? null;

  const outcomes = { handled: 0, ignored: 0, enqueued: 0, failed: 0 };

  for (const event of events) {
    try {
      const userHandlerConfig = userHandlers?.[event.type] ?? null;
      const skipBuiltin = userHandlerConfig?.override_builtin === true;

      // 1. Run built-in handler (unless user override)
      let builtinResult: EventHandlerResult | undefined;
      if (!skipBuiltin) {
        const handler = builtinHandlers.get(event.type) ?? handleCustom;
        builtinResult = handler(event, db);
      }

      // 2. Run user-defined actions (if configured)
      let userResults: ActionResult[] | undefined;
      if (userHandlerConfig) {
        userResults = [];
        for (const actionConfig of userHandlerConfig.actions) {
          try {
            userResults.push(executeAction(event, actionConfig, db));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            userResults.push({ action: actionConfig.action, ok: false, error: msg });
            safeLog("event.router.userAction", err);
          }
        }
      }

      // Determine effective result
      const result = builtinResult ?? { action: "ignored" as const };

      // If built-in said "ignored" but user handlers ran, mark as "handled"
      const hasUserActions = userResults && userResults.length > 0;
      if (result.action === "ignored" && !hasUserActions) {
        markIgnored(event.id, db);
        outcomes.ignored++;
      } else {
        const effectiveAction = result.action === "ignored" && hasUserActions
          ? "handled"
          : result.action;
        markHandled(event.id, effectiveAction, db);
        if (effectiveAction === "enqueued") outcomes.enqueued++;
        else outcomes.handled++;
      }

      try {
        recordMetric({ projectId, type: "system", subject: event.type, key: "event_processed", value: 1, tags: { eventId: event.id, outcome: result.action, taskId: result.taskId, userActionsCount: userResults?.length ?? 0 } }, db);
      } catch (e) { safeLog("event.router.metric", e); }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcomes.failed++;
      try {
        markFailed(event.id, message, db);
      } catch (markErr) {
        safeLog("event.router.markFailed", markErr);
      }

      try {
        recordMetric({ projectId, type: "system", subject: event.type, key: "event_handler_error", value: 1, tags: { eventId: event.id, error: message.slice(0, 200) } }, db);
      } catch (e) { safeLog("event.router.errorMetric", e); }
    }
  }

  if (events.length > 0) {
    try {
      emitDiagnosticEvent({ type: "clawforce.events.processed", projectId, count: events.length, outcomes });
    } catch (e) { safeLog("event.router.diagnostic", e); }
  }

  return events.length;
}

function handleTaskCompleted(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const taskId = event.payload.taskId as string | undefined;
  if (!taskId) return { action: "ignored" };

  // Cascade unblock: auto-transition BLOCKED → OPEN for dependents
  try {
    const actor = (event.payload.actor as string) ?? "system:dep-cascade";
    const unblocked = cascadeUnblock(event.projectId, taskId, actor, db);
    if (unblocked.length > 0) {
      safeLog("event.router.depCascade", `Unblocked ${unblocked.length} task(s): ${unblocked.join(", ")}`);
    }
  } catch (err) { safeLog("event.router.depCascade", err); }

  // Record trust signal for the assigned agent (P2 data flow)
  // Only for task_completed events — task_failed has its own signal in handleTaskFailed
  if (event.type === "task_completed") {
    try {
      const completedTask = getTask(event.projectId, taskId, db);
      if (completedTask?.assignedTo) {
        recordTrustDecision({
          projectId: event.projectId,
          category: "task_completion",
          decision: "approved",
          agentId: completedTask.assignedTo,
          toolName: undefined,
          riskTier: "low",
          severity: 0.5,
        }, db);
      }
    } catch (err) { safeLog("event.router.trustSignal", err); }
  }

  try {
    maybeRerunIssueChecksForTask(event.projectId, taskId, "DONE", "system:entity-remediation", db);
  } catch (err) {
    safeLog("event.router.entityIssueRerunDone", err);
  }

  const task = getTask(event.projectId, taskId, db);
  try {
    const recurringJob = getRecurringJobMetadata(task);
    if (recurringJob) {
      markRecurringJobFinished(
        event.projectId,
        recurringJob.agentId,
        recurringJob.jobName,
        "completed",
        Date.now(),
        taskId,
        db,
      );
    }
  } catch (err) {
    safeLog("event.router.recurringJobCompleted", err);
  }
  try {
    const workflowMutationTaskId = maybeHandleWorkflowMutationTaskCompletion(event.projectId, task, db);
    if (workflowMutationTaskId) {
      return { action: "handled", taskId: workflowMutationTaskId };
    }
  } catch (err) {
    safeLog("event.router.workflowMutationTaskCompletion", err);
  }
  if (!task?.workflowId) return { action: "handled", taskId };

  // Try to advance the workflow
  const workflow = getWorkflow(event.projectId, task.workflowId, db);
  if (!workflow || workflow.state !== "active") return { action: "handled", taskId };

  const newPhase = advanceWorkflow(event.projectId, task.workflowId, db);
  if (newPhase !== null && newPhase < workflow.phases.length) {
    // Enqueue tasks from the newly unlocked phase
    const nextPhaseSpec = workflow.phases[newPhase];
    if (nextPhaseSpec) {
      for (const nextTaskId of nextPhaseSpec.taskIds) {
        const nextTask = getTask(event.projectId, nextTaskId, db);
        if (nextTask && (nextTask.state === "OPEN" || nextTask.state === "ASSIGNED")) {
          try {
            enqueue(event.projectId, nextTaskId, undefined, undefined, db);
          } catch (err) {
            safeLog("event.router.enqueue", err);
          }
        }
      }
    }
  }

  return { action: "handled", taskId };
}

function maybeHandleWorkflowMutationTaskCompletion(
  projectId: string,
  task: ReturnType<typeof getTask>,
  db: DatabaseSync,
): string | null {
  if (!task || task.state !== "DONE" || task.origin !== "lead_proposal" || !task.originId) {
    return null;
  }

  const proposal = getProposal(projectId, task.originId, db);
  if (!proposal || proposal.origin !== "workflow_mutation") return null;

  const metadata = asObject(task.metadata);
  const stage = typeof metadata?.workflowMutationStage === "string"
    ? metadata.workflowMutationStage
    : "review";

  if (stage === "implementation") {
    return finalizeWorkflowMutationImplementationTask(projectId, task, metadata ?? {}, db);
  }

  const snapshot = parseWorkflowMutationSnapshot(proposal.approval_policy_snapshot);
  if (!snapshot) return null;

  const followUp = ensureWorkflowMutationImplementationTask(projectId, proposal.id, task, snapshot, db);
  linkSourceTaskToWorkflowMutation(projectId, snapshot.sourceTaskId, {
    status: "implementation_in_progress",
    followUpTaskId: followUp.id,
    reviewTaskId: task.id,
    proposalId: proposal.id,
    reasonCode: snapshot.reasonCode,
    mutationCategory: snapshot.mutationCategory,
  }, db);

  return followUp.id;
}

function finalizeWorkflowMutationImplementationTask(
  projectId: string,
  task: NonNullable<ReturnType<typeof getTask>>,
  metadata: Record<string, unknown>,
  db: DatabaseSync,
): string | null {
  const sourceTaskId = typeof metadata.sourceTaskId === "string" ? metadata.sourceTaskId : undefined;
  if (!sourceTaskId) return task.id;

  const sourceTask = getTask(projectId, sourceTaskId, db);
  if (!sourceTask) return task.id;

  const proposal = task.originId
    ? getProposal(projectId, task.originId, db)
    : null;
  const snapshot = proposal?.origin === "workflow_mutation"
    ? parseWorkflowMutationSnapshot(proposal.approval_policy_snapshot)
    : null;
  if (task.originId) {
    linkWorkflowMutationProposalIssues(
      projectId,
      task.originId,
      getWorkflowMutationAffectedIssueIds(snapshot, metadata),
      db,
    );
  }

  clearSourceTaskWorkflowMutation(projectId, sourceTaskId, db);

  const postCondition = asObject(metadata.workflowMutationPostCondition);
  const postConditionVerified = postCondition?.verifiedAt != null;
  if (postConditionVerified) {
    return sourceTaskId;
  }

  try {
    maybeRerunIssueChecksForTask(projectId, sourceTaskId, "DONE", "system:workflow-mutation", db);
  } catch (err) {
    safeLog("event.router.workflowMutationRerun", err);
  }

  const refreshedSourceTask = getTask(projectId, sourceTaskId, db);
  const linkedIssueId = getSourceIssueId(refreshedSourceTask);
  const issue = linkedIssueId ? getEntityIssue(projectId, linkedIssueId, db) : null;
  if (refreshedSourceTask && refreshedSourceTask.state === "BLOCKED" && issue?.status === "open") {
    const resumed = transitionTask({
      projectId,
      taskId: refreshedSourceTask.id,
      toState: "ASSIGNED",
      actor: "system:workflow-mutation",
      reason: `Workflow mutation task ${task.id} completed; rerunning source remediation with the updated verification path.`,
      verificationRequired: false,
    }, db);
    if (resumed.ok) {
      return refreshedSourceTask.id;
    }
  }

  return sourceTaskId;
}

function ensureWorkflowMutationImplementationTask(
  projectId: string,
  proposalId: string,
  reviewTask: NonNullable<ReturnType<typeof getTask>>,
  snapshot: WorkflowMutationProposalSnapshot,
  db: DatabaseSync,
) {
  const existing = db.prepare(`
    SELECT id
    FROM tasks
    WHERE project_id = ?
      AND origin = 'lead_proposal'
      AND origin_id = ?
      AND json_extract(metadata, '$.workflowMutationStage') = 'implementation'
      AND state NOT IN ('DONE', 'FAILED', 'CANCELLED')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(projectId, proposalId) as { id?: string } | undefined;
  if (existing?.id) {
    const task = getTask(projectId, existing.id, db);
    if (task) return maybeNormalizeWorkflowMutationImplementationTask(projectId, task, db);
  }

  const reviewEvidence = getLatestTaskEvidenceContent(projectId, reviewTask.id, db);
  const subject = snapshot.entityTitle ?? snapshot.sourceTaskTitle;
  return createTask({
    projectId,
    title: `Implement workflow mutation for ${subject}: ${formatWorkflowMutationReason(snapshot.reasonCode)}`,
    description: buildWorkflowMutationImplementationDescription({
      subject,
      sourceTaskId: snapshot.sourceTaskId,
      sourceTaskTitle: snapshot.sourceTaskTitle,
      reviewTaskId: reviewTask.id,
      reviewTaskTitle: reviewTask.title,
      reviewDescription: reviewTask.description,
      reviewEvidence,
      reasonCode: snapshot.reasonCode,
      mutationCategory: snapshot.mutationCategory,
    }),
    priority: "P1",
    assignedTo: snapshot.stewardAgentId,
    createdBy: "system:workflow-mutation",
    tags: [
      "workflow-mutation",
      "workflow-mutation-implementation",
      `review:${snapshot.reasonCode}`,
      `category:${snapshot.mutationCategory}`,
    ],
    kind: "infra",
    origin: "lead_proposal",
    originId: proposalId,
    entityType: snapshot.entityType ?? undefined,
    entityId: snapshot.entityId ?? undefined,
    metadata: {
      workflowMutationStage: "implementation",
      sourceTaskId: snapshot.sourceTaskId,
      sourceTaskTitle: snapshot.sourceTaskTitle,
      sourceIssueId: snapshot.sourceIssueId ?? null,
      reviewTaskId: reviewTask.id,
      reasonCode: snapshot.reasonCode,
      mutationCategory: snapshot.mutationCategory,
      failureCount: snapshot.failureCount,
    },
  }, db);
}

function formatWorkflowMutationReason(reasonCode: string): string {
  return reasonCode
    .split("_")
    .filter(Boolean)
    .join(" ");
}

function parseWorkflowMutationSnapshot(
  raw: string | null | undefined,
): WorkflowMutationProposalSnapshot | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorkflowMutationProposalSnapshot;
  } catch {
    return null;
  }
}

function getLatestTaskEvidenceContent(
  projectId: string,
  taskId: string,
  db: DatabaseSync,
): string | undefined {
  const evidence = getTaskEvidence(projectId, taskId, db);
  return evidence
    .filter((item) => item.type === "output")
    .at(-1)?.content?.trim()
    || evidence.at(-1)?.content?.trim();
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function getWorkflowMutationAffectedIssueIds(
  snapshot: WorkflowMutationProposalSnapshot | null | undefined,
  metadata?: Record<string, unknown> | null,
): string[] {
  const stewardTask = asObject(snapshot?.stewardTask);
  const stewardMetadata = asObject(stewardTask?.metadata);
  return Array.from(new Set([
    typeof snapshot?.sourceIssueId === "string" ? snapshot.sourceIssueId : null,
    typeof metadata?.sourceIssueId === "string" ? metadata.sourceIssueId : null,
    ...asStringArray(snapshot?.affectedIssueIds),
    ...asStringArray(stewardMetadata?.affectedIssueIds),
    ...asStringArray(metadata?.affectedIssueIds),
  ].filter((issueId): issueId is string => Boolean(issueId))));
}

function getSourceIssueId(task: ReturnType<typeof getTask>): string | undefined {
  const metadata = asObject(task?.metadata);
  const issueMeta = asObject(metadata?.entityIssue);
  return typeof issueMeta?.issueId === "string" ? issueMeta.issueId : undefined;
}

function linkSourceTaskToWorkflowMutation(
  projectId: string,
  sourceTaskId: string,
  workflowMutation: Record<string, unknown>,
  db: DatabaseSync,
): void {
  const task = getTask(projectId, sourceTaskId, db);
  if (!task) return;
  const metadata = asObject(task.metadata) ?? {};
  metadata.workflowMutation = workflowMutation;
  db.prepare("UPDATE tasks SET metadata = ?, updated_at = ? WHERE project_id = ? AND id = ?")
    .run(JSON.stringify(metadata), Date.now(), projectId, sourceTaskId);
}

function clearSourceTaskWorkflowMutation(
  projectId: string,
  sourceTaskId: string,
  db: DatabaseSync,
): void {
  const task = getTask(projectId, sourceTaskId, db);
  if (!task) return;
  const metadata = asObject(task.metadata) ?? {};
  if (!("workflowMutation" in metadata)) return;
  delete metadata.workflowMutation;
  db.prepare("UPDATE tasks SET metadata = ?, updated_at = ? WHERE project_id = ? AND id = ?")
    .run(JSON.stringify(metadata), Date.now(), projectId, sourceTaskId);
}

function linkWorkflowMutationProposalIssues(
  projectId: string,
  proposalId: string,
  issueIds: string[],
  db: DatabaseSync,
): void {
  if (issueIds.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare(`
    UPDATE entity_issues
    SET proposal_id = ?,
        last_seen_at = ?
    WHERE project_id = ?
      AND id = ?
  `);
  for (const issueId of issueIds) {
    stmt.run(proposalId, now, projectId, issueId);
  }
}

function handleTaskFailed(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const taskId = event.payload.taskId as string | undefined;

  // Record negative trust signal for the assigned agent (P2 data flow)
  if (taskId) {
    try {
      const failedTask = getTask(event.projectId, taskId, db);
      const recurringJob = getRecurringJobMetadata(failedTask);
      if (recurringJob) {
        markRecurringJobFinished(
          event.projectId,
          recurringJob.agentId,
          recurringJob.jobName,
          "failed",
          Date.now(),
          taskId,
          db,
        );
      }
      if (failedTask?.assignedTo) {
        recordTrustDecision({
          projectId: event.projectId,
          category: "task_completion",
          decision: "rejected",
          agentId: failedTask.assignedTo,
          toolName: undefined,
          riskTier: "low",
          severity: 0.5,
        }, db);
      }
    } catch (err) { safeLog("event.router.trustSignalFailed", err); }
  }

  // Same workflow check as task_completed — a failed task may still
  // satisfy an "all_resolved" or "any_resolved" gate
  return handleTaskCompleted(event, db);
}

function handleSweepFinding(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const finding = event.payload.finding as string | undefined;
  const taskId = event.payload.taskId as string | undefined;

  if (!finding || !taskId) return { action: "ignored" };

  switch (finding) {
    case "stale": {
      // Stale task detected — enqueue for re-dispatch
      try {
        const result = enqueue(event.projectId, taskId, undefined, 3, db);
        return { action: "enqueued", taskId, queueItemId: result?.id };
      } catch (err) {
        safeLog("event.router.staleEnqueue", err);
        return { action: "handled", taskId };
      }
    }
    case "retry_exhausted": {
      // Gather failure evidence and emit replan_needed event
      try {
        const analysis = gatherFailureAnalysis(event.projectId, taskId, db);
        if (analysis) {
          ingestEvent(event.projectId, "replan_needed", "internal", {
            taskId,
            taskTitle: analysis.taskTitle,
            priority: analysis.priority,
            totalAttempts: analysis.totalAttempts,
            replanCount: analysis.replanCount,
          }, `replan-needed:${taskId}:${Date.now()}`, db);
        }
      } catch (err) { safeLog("event.router.replanEmit", err); }
      return { action: "handled", taskId };
    }
    default:
      return { action: "handled", taskId };
  }
}

function handleWorkflowCompleted(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const workflowId = event.payload.workflowId as string | undefined;
  if (!workflowId) return { action: "ignored" };

  // Check for goals with acceptance criteria that need verification
  try {
    const verificationTasks = handleWorkflowCompletion(event.projectId, workflowId, db);
    if (verificationTasks.length > 0) {
      safeLog("event.router.workflowCompletion", `Created ${verificationTasks.length} verification task(s) for workflow ${workflowId}`);
    }
  } catch (err) { safeLog("event.router.workflowCompletion", err); }

  return { action: "handled" };
}

function handleGoalAchievedEvent(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const goalId = event.payload.goalId as string | undefined;
  if (!goalId) return { action: "ignored" };

  // Check if project is now complete
  try {
    const result = handleGoalAchieved(event.projectId, goalId, db);
    if (result.projectComplete) {
      safeLog("event.router.projectComplete", `Project ${event.projectId} is complete`);
    }
  } catch (err) { safeLog("event.router.goalAchieved", err); }

  return { action: "handled" };
}

function handleReplanNeeded(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const taskId = event.payload.taskId as string | undefined;
  if (!taskId) return { action: "ignored" };

  // Check replan limit
  const replanResult = recordReplanAttempt(event.projectId, taskId, 3, db);

  if (!replanResult.ok) {
    // Max replans hit — escalate to human via proposal
    try {
      const proposalId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO proposals (id, project_id, title, description, proposed_by, status, risk_tier, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 'critical', ?)
      `).run(
        proposalId, event.projectId,
        `Human intervention: ${event.payload.taskTitle ?? taskId}`,
        `Task ${taskId} has exhausted all retries and re-plan attempts. Requires human decision.`,
        "system:replan", Date.now(),
      );

      ingestEvent(event.projectId, "proposal_created", "internal", {
        proposalId,
        proposedBy: "system:replan",
        riskTier: "critical",
        title: `Human intervention: ${event.payload.taskTitle ?? taskId}`,
      }, `proposal-created:${proposalId}`, db);
    } catch (err) { safeLog("event.router.replanEscalate", err); }

    return { action: "handled", taskId };
  }

  // Default strategy: manager handles it via OODA
  // The failure analysis is already available via planning_delta context source.
  // Record an audit entry so the delta report picks it up.
  try {
    writeAuditEntry({
      projectId: event.projectId,
      actor: "system:replan",
      action: "replan_triggered",
      targetType: "task",
      targetId: taskId,
      detail: JSON.stringify({
        replanCount: replanResult.replanCount,
        taskTitle: event.payload.taskTitle,
        priority: event.payload.priority,
      }),
    }, db);
  } catch (err) { safeLog("event.router.replanAudit", err); }

  return { action: "handled", taskId };
}

function handleDispatchSucceeded(_event: ClawforceEvent, _db: DatabaseSync): EventHandlerResult {
  // Acknowledged — useful for auditing, no action needed
  return { action: "handled" };
}

function handleDispatchFailed(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const taskId = event.payload.taskId as string | undefined;
  if (!taskId) return { action: "ignored" };

  const task = getTask(event.projectId, taskId, db);
  if (task && shouldFinalizeRecurringDispatchFailure(task, event.payload)) {
    return finalizeRecurringDispatchFailure(
      event.projectId,
      task,
      describeDispatchFailure(event.payload),
      db,
    );
  }

  // Do NOT re-enqueue when failure is due to budget exceeded or rate limiting.
  // Re-enqueueing budget-blocked tasks creates a tight retry loop (877+ failed
  // entries and 1,656 dispatch_failed events). These tasks should wait for the
  // next budget window reset rather than spinning.
  const budgetExceeded = event.payload.budgetExceeded === true;
  const rateLimited = event.payload.rateLimited === true;
  const nonRetryable = event.payload.nonRetryable === true;
  if (budgetExceeded || rateLimited || nonRetryable) {
    return { action: "handled", taskId };
  }

  // Re-enqueue the task at same priority (dedup will skip if a non-terminal item exists)
  try {
    const result = enqueue(event.projectId, taskId, undefined, undefined, db);
    if (result) {
      return { action: "enqueued", taskId, queueItemId: result.id };
    }
  } catch (err) {
    safeLog("event.router.dispatchFailedEnqueue", err);
  }

  return { action: "handled", taskId };
}

function handleTaskReviewReady(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const taskId = event.payload.taskId as string | undefined;
  if (!taskId) return { action: "ignored" };

  const task = getTask(event.projectId, taskId, db);
  if (!task || task.state !== "REVIEW") return { action: "handled", taskId };

  try {
    maybeRerunIssueChecksForTask(event.projectId, taskId, "REVIEW", "system:entity-remediation", db);
  } catch (err) {
    safeLog("event.router.entityIssueRerunReview", err);
  }

  // Auto-review is opt-in. Only dispatch a verifier when one is explicitly configured.
  const extCfg = getExtendedProjectConfig(event.projectId);
  let verifierAgentId: string | null = null;
  let verifierProjectDir: string | undefined;

  // Try explicit review.verifierAgent config
  if (extCfg?.review?.verifierAgent) {
    const entry = getAgentConfig(extCfg.review.verifierAgent, event.projectId);
    if (entry) {
      verifierAgentId = extCfg.review.verifierAgent;
      verifierProjectDir = entry.projectDir;
    }
  }

  if (!verifierAgentId) {
    // No verifier configured — the manager handles it manually.
    return { action: "ignored" };
  }

  // Build a verification prompt with task context
  const evidence = getTaskEvidence(event.projectId, taskId, db);
  const evidenceSummary = evidence.length > 0
    ? evidence.map((e) => `- [${e.type}] ${e.content.slice(0, 200)}`).join("\n")
    : "No evidence attached.";

  const verifyPrompt = [
    `# Verify Task: ${task.title}`,
    task.description ? `\n## Description\n${task.description}` : "",
    `\n## Evidence Summary\n${evidenceSummary}`,
    "\n## Instructions",
    "Review the task output and evidence. If the work is satisfactory, transition the task to DONE.",
    "If the work is insufficient, transition the task to FAILED with a reason.",
  ].filter(Boolean).join("\n");

  try {
    // skipStateCheck=true: REVIEW tasks are normally blocked from dispatch,
    // but verification dispatches are the intended consumer of REVIEW tasks.
    const result = enqueue(event.projectId, taskId, {
      agentId: verifierAgentId,
      prompt: verifyPrompt,
      projectDir: verifierProjectDir ?? process.cwd(),
    }, undefined, db, undefined, true);

    if (result) {
      return { action: "enqueued", taskId, queueItemId: result.id };
    }
  } catch (err) {
    safeLog("event.router.reviewEnqueue", err);
  }

  return { action: "handled", taskId };
}

function handleEntityIssueChanged(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const issueId = event.payload.issueId as string | undefined;
  if (!issueId) return { action: "ignored" };

  const sourceTaskId = shouldDeferImmediateIssueReopen(event, db);
  let handledTaskId: string | undefined;

  try {
    if (!sourceTaskId) {
      const task = ensureIssueRemediationTask(event.projectId, issueId, "system:entity-remediation", db);
      if (task) {
        handledTaskId = task.id;
      }
    } else {
      handledTaskId = sourceTaskId;
    }
  } catch (err) {
    safeLog("event.router.entityIssueChanged", err);
  }

  try {
    const entityId = event.payload.entityId as string | undefined;
    if (entityId) {
      reconcileEntityReadiness(event.projectId, entityId, "system:entity-readiness", db);
    }
  } catch (err) {
    safeLog("event.router.entityIssueChanged.readiness", err);
  }

  return { action: "handled", taskId: handledTaskId };
}

function shouldDeferImmediateIssueReopen(
  event: ClawforceEvent,
  db: DatabaseSync,
): string | null {
  const issueId = typeof event.payload.issueId === "string" ? event.payload.issueId : null;
  const sourceType = typeof event.payload.sourceType === "string" ? event.payload.sourceType : null;
  const sourceId = typeof event.payload.sourceId === "string" ? event.payload.sourceId : null;
  if (!issueId || sourceType !== "task" || !sourceId) {
    return null;
  }

  const task = getTask(event.projectId, sourceId, db);
  if (!task || task.state !== "DONE" || task.origin !== "reactive" || task.originId !== issueId) {
    return null;
  }

  return task.id;
}

function handleEntityIssueResolved(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const issueId = event.payload.issueId as string | undefined;
  if (!issueId) return { action: "ignored" };

  try {
    const closed = closeIssueRemediationTasks(event.projectId, issueId, "system:entity-remediation", db);
    if (closed.length > 0) {
      return { action: "handled", taskId: closed[0]?.id };
    }
  } catch (err) {
    safeLog("event.router.entityIssueResolved", err);
  }

  try {
    const entityId = event.payload.entityId as string | undefined;
    if (entityId) {
      reconcileEntityReadiness(event.projectId, entityId, "system:entity-readiness", db);
    }
  } catch (err) {
    safeLog("event.router.entityIssueResolved.readiness", err);
  }

  return { action: "handled" };
}

function handleEntityChanged(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const entityId = event.payload.entityId as string | undefined;
  if (!entityId) return { action: "ignored" };

  try {
    reconcileEntityStateSignals(event.projectId, entityId, "system:entity-state-signals", db);
  } catch (err) {
    safeLog("event.router.entityChanged.stateSignals", err);
  }

  try {
    reconcileEntityReadiness(event.projectId, entityId, "system:entity-readiness", db);
  } catch (err) {
    safeLog("event.router.entityChanged.readiness", err);
  }

  return { action: "handled" };
}

function handleDispatchDeadLetter(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const taskId = event.payload.taskId as string | undefined;
  if (!taskId) return { action: "ignored" };

  const task = getTask(event.projectId, taskId, db);
  if (task) {
    const metadata = task.metadata ?? {};
    metadata.dispatch_dead_letter = true;
    metadata.dispatch_dead_letter_at = Date.now();
    // Preserve legacy keys for existing readers while the feed/query surfaces
    // normalize onto the plain metadata shape.
    metadata["$.dispatch_dead_letter"] = true;
    metadata["$.dispatch_dead_letter_at"] = metadata.dispatch_dead_letter_at;
    db.prepare("UPDATE tasks SET metadata = ? WHERE id = ?").run(
      JSON.stringify(metadata),
      taskId,
    );

    const recurringJob = getRecurringJobMetadata(task);
    if (recurringJob) {
      try {
        markRecurringJobFinished(
          event.projectId,
          recurringJob.agentId,
          recurringJob.jobName,
          "failed",
          Date.now(),
          taskId,
          db,
        );
      } catch (err) {
        safeLog("event.router.recurringJobDeadLetter", err);
      }

      if (task.state !== "DONE" && task.state !== "FAILED" && task.state !== "CANCELLED") {
        try {
          transitionTask({
            projectId: event.projectId,
            taskId,
            toState: "FAILED",
            actor: "system:router",
            reason: describeDispatchDeadLetterFailure(event.payload),
            verificationRequired: false,
          }, db);
        } catch (err) {
          safeLog("event.router.deadLetterFailRecurring", err);
        }
      }
    } else {

      const resolvedIssue = getResolvedLinkedIssueForTask(event.projectId, {
        ...task,
        metadata,
      }, db);
      if (resolvedIssue && task.state !== "DONE" && task.state !== "FAILED" && task.state !== "CANCELLED") {
        try {
          transitionTask({
            projectId: event.projectId,
            taskId,
            toState: "CANCELLED",
            actor: "system:router",
            reason: "Linked entity issue already resolved; cancelling dead-lettered remediation task",
            verificationRequired: false,
          }, db);
        } catch (err) {
          safeLog("event.router.deadLetterCancelResolved", err);
        }
      } else if (task.state === "ASSIGNED" || task.state === "IN_PROGRESS") {
        try {
          transitionTask({
            projectId: event.projectId,
            taskId,
            toState: "BLOCKED",
            actor: "system:router",
            reason: "Dispatch retries exhausted; operator review required",
            verificationRequired: false,
          }, db);
        } catch (err) {
          safeLog("event.router.deadLetterBlock", err);
        }
      }
    }
  }

  try {
    writeAuditEntry({
      projectId: event.projectId,
      actor: "system:router",
      action: "event.dead_letter_handled",
      targetType: "task",
      targetId: taskId,
      detail: JSON.stringify({ eventId: event.id, queueItemId: event.payload.queueItemId }),
    }, db);
  } catch (err) { safeLog("event.router.deadLetterAudit", err); }

  return { action: "handled", taskId };
}

function shouldFinalizeRecurringDispatchFailure(
  task: ReturnType<typeof getTask>,
  payload: Record<string, unknown>,
): task is NonNullable<ReturnType<typeof getTask>> {
  if (!task || !getRecurringJobMetadata(task)) return false;
  if (payload.nonRetryable === true) return true;
  if (payload.budgetExceeded === true) return true;
  if (payload.rateLimited === true) return true;
  if (payload.riskGated === true) return true;
  if (payload.phaseGated === true) return true;
  if (typeof payload.safetyLimit === "string" && payload.safetyLimit.length > 0) return true;
  const error = typeof payload.error === "string" ? payload.error : "";
  return error.startsWith("Task not found:")
    || error.startsWith("Task in non-dispatchable state:");
}

function finalizeRecurringDispatchFailure(
  projectId: string,
  task: NonNullable<ReturnType<typeof getTask>>,
  reason: string,
  db: DatabaseSync,
): EventHandlerResult {
  const recurringJob = getRecurringJobMetadata(task);
  if (!recurringJob) return { action: "handled", taskId: task.id };

  try {
    markRecurringJobFinished(
      projectId,
      recurringJob.agentId,
      recurringJob.jobName,
      "failed",
      Date.now(),
      task.id,
      db,
    );
  } catch (err) {
    safeLog("event.router.recurringJobDispatchFailed", err);
  }

  if (task.state !== "DONE" && task.state !== "FAILED" && task.state !== "CANCELLED") {
    try {
      transitionTask({
        projectId,
        taskId: task.id,
        toState: "FAILED",
        actor: "system:router",
        reason,
        verificationRequired: false,
      }, db);
    } catch (err) {
      safeLog("event.router.recurringJobDispatchFailedTransition", err);
    }
  }

  return { action: "handled", taskId: task.id };
}

function describeDispatchFailure(payload: Record<string, unknown>): string {
  const error = typeof payload.error === "string" && payload.error.trim()
    ? payload.error.trim()
    : "Dispatch failed before the recurring workflow run could start";
  return `Recurring workflow dispatch failed: ${error}`;
}

function describeDispatchDeadLetterFailure(payload: Record<string, unknown>): string {
  const lastError = typeof payload.lastError === "string" && payload.lastError.trim()
    ? payload.lastError.trim()
    : "Dispatch retries exhausted before the recurring workflow run could start";
  return `Recurring workflow dispatch exhausted retries: ${lastError}`;
}

function handleProposalApproved(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const proposalId = event.payload.proposalId as string | undefined;
  if (!proposalId) return { action: "ignored" };

  const proposal = getProposal(event.projectId, proposalId, db);
  if (!proposal || proposal.status !== "approved") return { action: "handled" };
  if (proposal.execution_status === "applied") return { action: "handled" };
  const linkedSimulatedAction = getSimulatedActionByProposal(event.projectId, proposalId, db);

  // Record trust decision for the category
  try {
    const intent = getIntentByProposalForProject(event.projectId, proposalId, db);
    if (intent) {
      recordTrustDecision({
        projectId: event.projectId,
        category: intent.category,
        decision: "approved",
        agentId: intent.agentId,
        proposalId,
        toolName: intent.toolName,
        riskTier: intent.riskTier,
      }, db);
    }
  } catch (err) { safeLog("event.router.trustDecision", err); }

  // Check for linked tool call intent (tool gate approval → re-dispatch)
  try {
    const intent = getIntentByProposalForProject(event.projectId, proposalId, db);
    if (intent && intent.taskId) {
      // Resolve the intent
      resolveIntentForProject(event.projectId, intent.id, "approved", db);
      if (linkedSimulatedAction) {
        setSimulatedActionStatus(event.projectId, linkedSimulatedAction.id, "approved_for_live", db);
      }

      // Add pre-approval so the re-dispatched agent can proceed past the gate
      addPreApproval({
        projectId: event.projectId,
        taskId: intent.taskId,
        toolName: intent.toolName,
        category: intent.category,
      }, db);

      // Re-enqueue the task for dispatch (priority 0 = high priority)
      try {
        const result = enqueue(event.projectId, intent.taskId, undefined, 0, db);
        if (result) {
          return { action: "enqueued", taskId: intent.taskId, queueItemId: result.id };
        }
      } catch (err) {
        safeLog("event.router.approvalReDispatch", err);
      }

      return { action: "handled", taskId: intent.taskId };
    }
  } catch (err) {
    safeLog("event.router.intentCheck", err);
  }

  // Try to re-attempt the gated action from the policy snapshot
  if (proposal.approval_policy_snapshot) {
    try {
      const snapshot = JSON.parse(proposal.approval_policy_snapshot) as Record<string, unknown>;
      const replayType = snapshot.replayType as string | undefined;
      const simulatedActionId = (snapshot.simulatedActionId as string | undefined) ?? linkedSimulatedAction?.id;
      const taskId = snapshot.taskId as string | undefined;
      const toState = snapshot.toState as string | undefined;
      const entityId = snapshot.entityId as string | undefined;
      const toHealth = snapshot.toHealth as string | undefined;

      if (replayType === "command" && simulatedActionId) {
        const replay = replaySimulatedCommand(event.projectId, simulatedActionId, db);
        if (!replay.ok) {
          markProposalExecutionFailed(event.projectId, proposalId, replay.error ?? "command replay failed", db);
          throw new Error(replay.error ?? "command replay failed");
        }
        markProposalExecutionApplied(event.projectId, proposalId, {
          taskId: replay.simulatedAction.taskId ?? null,
        }, db);
        try {
          emitDiagnosticEvent({
            type: "proposal.action_executed",
            projectId: event.projectId,
            proposalId,
            simulatedActionId,
            success: replay.ok,
            replayMode: "command",
            error: replay.error,
          });
        } catch (e) { safeLog("event.router.proposalDiag", e); }
        return { action: "handled", taskId: replay.simulatedAction.taskId };
      }

      if (replayType === "workflow_mutation") {
        const snapshot = JSON.parse(proposal.approval_policy_snapshot) as WorkflowMutationProposalSnapshot;
        linkWorkflowMutationProposalIssues(
          event.projectId,
          proposalId,
          getWorkflowMutationAffectedIssueIds(snapshot),
          db,
        );
        const stewardTask = ensureWorkflowMutationTask(event.projectId, proposalId, proposal.proposed_by, snapshot, db);
        pauseSourceTaskForWorkflowMutation(event.projectId, proposalId, proposal.proposed_by, snapshot, stewardTask.id, db);
        markProposalExecutionApplied(event.projectId, proposalId, { taskId: stewardTask.id }, db);

        try {
          emitDiagnosticEvent({
            type: "proposal.action_executed",
            projectId: event.projectId,
            proposalId,
            taskId: stewardTask.id,
            success: true,
            replayMode: "workflow_mutation",
          });
        } catch (e) { safeLog("event.router.proposalDiag", e); }

        return { action: "handled", taskId: stewardTask.id };
      }

      if (taskId && toState) {
        const result = transitionTask({
          projectId: event.projectId,
          taskId,
          toState: toState as Parameters<typeof transitionTask>[0]["toState"],
          actor: proposal.proposed_by,
          reason: `Approved via proposal ${proposalId}`,
          verificationRequired: false,
        }, db);
        if (!result.ok) {
          markProposalExecutionFailed(event.projectId, proposalId, result.reason ?? `task transition to ${toState} failed`, db);
          throw new Error(result.reason ?? `task transition to ${toState} failed`);
        }
        markProposalExecutionApplied(event.projectId, proposalId, { taskId }, db);

        try {
          emitDiagnosticEvent({
            type: "proposal.action_executed",
            projectId: event.projectId,
            proposalId,
            taskId,
            toState,
            success: result.ok,
          });
        } catch (e) { safeLog("event.router.proposalDiag", e); }

        return { action: "handled", taskId };
      }

      if (entityId && (toState || toHealth)) {
        const entity = transitionEntity({
          projectId: event.projectId,
          entityId,
          toState,
          toHealth,
          actor: (snapshot.actor as string | undefined) ?? proposal.proposed_by,
          reason: (snapshot.reason as string | undefined) ?? `Approved via proposal ${proposalId}`,
          metadata: (snapshot.metadata as Record<string, unknown> | undefined),
        }, db);
        markProposalExecutionApplied(event.projectId, proposalId, {}, db);

        try {
          emitDiagnosticEvent({
            type: "proposal.action_executed",
            projectId: event.projectId,
            proposalId,
            entityId,
            toState: entity.state,
            success: true,
          });
        } catch (e) { safeLog("event.router.proposalDiag", e); }

        return { action: "handled" };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        markProposalExecutionFailed(event.projectId, proposalId, message, db);
      } catch (markErr) {
        safeLog("event.router.proposalExecutionFailed", markErr);
      }
      safeLog("event.router.proposalAction", err);
      throw err;
    }
  }

  return { action: "handled" };
}

function ensureWorkflowMutationTask(
  projectId: string,
  proposalId: string,
  proposedBy: string,
  snapshot: WorkflowMutationProposalSnapshot,
  db: DatabaseSync,
) {
  const existing = db.prepare(`
    SELECT id
    FROM tasks
    WHERE project_id = ?
      AND origin = 'lead_proposal'
      AND origin_id = ?
      AND state NOT IN ('DONE', 'FAILED', 'CANCELLED')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(projectId, proposalId) as { id?: string } | undefined;
  if (existing?.id) {
    const task = getTask(projectId, existing.id, db);
    if (task) return task;
  }

  const taskSpec = snapshot.stewardTask as WorkflowMutationTaskSpec;
  return createTask({
    projectId,
    title: taskSpec.title,
    description: taskSpec.description,
    priority: taskSpec.priority,
    assignedTo: snapshot.stewardAgentId,
    createdBy: proposedBy,
    tags: taskSpec.tags,
    kind: taskSpec.kind,
    origin: "lead_proposal",
    originId: proposalId,
    metadata: taskSpec.metadata,
    entityType: snapshot.entityType ?? undefined,
    entityId: snapshot.entityId ?? undefined,
  }, db);
}

function clearIssueWorkflowMutationProposalLinks(
  projectId: string,
  issueIds: string[],
  db: DatabaseSync,
): void {
  if (issueIds.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare(`
    UPDATE entity_issues
    SET proposal_id = NULL,
        last_seen_at = ?
    WHERE project_id = ?
      AND id = ?
  `);
  for (const issueId of issueIds) {
    stmt.run(now, projectId, issueId);
  }
}

function pauseSourceTaskForWorkflowMutation(
  projectId: string,
  proposalId: string,
  actor: string,
  snapshot: WorkflowMutationProposalSnapshot,
  stewardTaskId: string,
  db: DatabaseSync,
): void {
  const sourceTask = getTask(projectId, snapshot.sourceTaskId, db);
  if (!sourceTask) return;
  if (!["OPEN", "ASSIGNED", "IN_PROGRESS", "REVIEW"].includes(sourceTask.state)) return;

  transitionTask({
    projectId,
    taskId: sourceTask.id,
    toState: "BLOCKED",
    actor,
    reason: `Workflow mutation approved via proposal ${proposalId}; follow task ${stewardTaskId} is now responsible for restructuring the loop.`,
    verificationRequired: false,
  }, db);
}

function handleProposalCreated(_event: ClawforceEvent, _db: DatabaseSync): EventHandlerResult {
  // Acknowledged for metrics/audit — no action needed
  return { action: "handled" };
}

function handleProposalRejected(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const proposalId = event.payload.proposalId as string | undefined;
  if (!proposalId) return { action: "ignored" };
  const linkedSimulatedAction = getSimulatedActionByProposal(event.projectId, proposalId, db);
  const proposal = getProposal(event.projectId, proposalId, db);
  const workflowMutationSnapshot = proposal?.origin === "workflow_mutation"
    ? parseWorkflowMutationSnapshot(proposal.approval_policy_snapshot)
    : null;

  // Record trust decision + resolve any linked tool call intent
  try {
    const intent = getIntentByProposalForProject(event.projectId, proposalId, db);
    if (intent) {
      recordTrustDecision({
        projectId: event.projectId,
        category: intent.category,
        decision: "rejected",
        agentId: intent.agentId,
        proposalId,
        toolName: intent.toolName,
        riskTier: intent.riskTier,
      }, db);
      resolveIntentForProject(event.projectId, intent.id, "rejected", db);
    }
  } catch (err) {
    safeLog("event.router.rejectIntent", err);
  }

  if (linkedSimulatedAction) {
    try {
      setSimulatedActionStatus(event.projectId, linkedSimulatedAction.id, "discarded", db);
    } catch (err) {
      safeLog("event.router.simulatedActionReject", err);
    }
  }

  const workflowMutationIssueIds = getWorkflowMutationAffectedIssueIds(workflowMutationSnapshot);
  if (workflowMutationIssueIds.length > 0) {
    try {
      clearIssueWorkflowMutationProposalLinks(event.projectId, workflowMutationIssueIds, db);
    } catch (err) {
      safeLog("event.router.clearWorkflowMutationIssueLink", err);
    }
  }

  return { action: "handled" };
}

function handleTaskAssigned(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const taskId = event.payload.taskId as string | undefined;
  if (!taskId) return { action: "ignored" };

  // Check if auto-dispatch is disabled for this project
  const extConfig = getExtendedProjectConfig(event.projectId);
  if (extConfig?.assignment?.autoDispatchOnAssign === false) {
    return { action: "handled", taskId };
  }

  const task = getTask(event.projectId, taskId, db);
  if (!task || task.state !== "ASSIGNED") return { action: "handled", taskId };

  // Build dispatch payload from agent config
  const payload: Record<string, unknown> = {};
  const agentModel = task.assignedTo ? getAgentModel(task.assignedTo) : null;
  if (agentModel) payload.model = agentModel;

  try {
    const result = enqueue(event.projectId, taskId, payload, undefined, db);
    if (result) return { action: "enqueued", taskId, queueItemId: result.id };
  } catch (err) { safeLog("event.router.autoDispatch", err); }

  return { action: "handled", taskId };
}

/**
 * handleTaskCreated — the SINGLE entry point for all newly created tasks.
 *
 * Canonical flow:
 *   createTask() → emits task_created ONLY
 *     ↓
 *   handleTaskCreated() → decides next step based on state:
 *     - OPEN + no assignee: auto-assign (if configured) → autoAssign emits task_assigned
 *     - OPEN + has assignee: transition OPEN → ASSIGNED → transitionTask emits task_assigned
 *     - ASSIGNED: emit task_assigned so dispatch fires
 *     ↓
 *   handleTaskAssigned() → enqueues for dispatch (with dedup)
 *     ↓
 *   Dispatcher dispatches
 */
function handleTaskCreated(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const taskId = event.payload.taskId as string | undefined;
  const state = event.payload.state as string | undefined;
  const assignedTo = event.payload.assignedTo as string | undefined;
  if (!taskId) return { action: "ignored" };

  // Task was created directly in ASSIGNED state (e.g. createTask with assignedTo).
  // Emit task_assigned so handleTaskAssigned fires and enqueues for dispatch.
  if (state === "ASSIGNED" && assignedTo) {
    try {
      ingestEvent(event.projectId, "task_assigned", "internal", {
        taskId,
        assignedTo,
        fromState: "OPEN",
      }, `task-assigned:${taskId}:created`, db);
    } catch (err) { safeLog("event.router.taskCreatedAssigned", err); }
    return { action: "handled", taskId };
  }

  // OPEN task — attempt auto-assignment if configured
  if (state === "OPEN") {
    const extConfig = getExtendedProjectConfig(event.projectId);
    if (!extConfig?.assignment?.enabled) return { action: "handled", taskId };

    try {
      const result = autoAssign(event.projectId, taskId, extConfig.assignment, db);
      if (result.assigned) return { action: "handled", taskId };
    } catch (err) { safeLog("event.router.autoAssign", err); }
  }

  return { action: "handled", taskId };
}

function handleMeetingTurnCompleted(event: ClawforceEvent, _db: DatabaseSync): EventHandlerResult {
  const payload = event.payload as Record<string, unknown>;
  const channelId = payload.channelId as string;
  if (!channelId) return { action: "ignored" };

  try {
    const result = advanceMeetingTurn(event.projectId, channelId);
    if (result.done) {
      concludeMeeting(event.projectId, channelId, "system");
    }
    return { action: "handled" };
  } catch (err) {
    safeLog("event.router.meetingTurn", err);
    return { action: "ignored" };
  }
}

function handleCustom(_event: ClawforceEvent, _db: DatabaseSync): EventHandlerResult {
  return { action: "ignored" };
}
