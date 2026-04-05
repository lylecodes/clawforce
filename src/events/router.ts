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
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";
import type { ClawforceEvent } from "../types.js";
import { claimPendingEvents, ingestEvent, markFailed, markHandled, markIgnored } from "./store.js";
import { enqueue } from "../dispatch/queue.js";
import { getTask, getTaskEvidence, transitionTask } from "../tasks/ops.js";
import { cascadeUnblock } from "../tasks/deps.js";
import { gatherFailureAnalysis, recordReplanAttempt } from "../planning/replan.js";
import { getAgentModel } from "../config/openclaw-reader.js";
import { handleWorkflowCompletion, handleGoalAchieved } from "../planning/completion.js";
import { advanceWorkflow, getWorkflow } from "../workflow.js";
import { getRegisteredAgentIds, getAgentConfig, getExtendedProjectConfig } from "../project.js";
import { recordMetric } from "../metrics.js";
import { executeAction, type ActionResult } from "./actions.js";
import { writeAuditEntry } from "../audit.js";
import { getProposal } from "../approval/resolve.js";
import { getIntentByProposalForProject, resolveIntentForProject } from "../approval/intent-store.js";
import { addPreApproval } from "../approval/pre-approved.js";
import { advanceMeetingTurn, concludeMeeting } from "../channels/meeting.js";
import { autoAssign } from "../assignment/engine.js";
import { recordTrustDecision } from "../trust/tracker.js";

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

  const task = getTask(event.projectId, taskId, db);
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

function handleTaskFailed(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const taskId = event.payload.taskId as string | undefined;

  // Record negative trust signal for the assigned agent (P2 data flow)
  if (taskId) {
    try {
      const failedTask = getTask(event.projectId, taskId, db);
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

  // Do NOT re-enqueue when failure is due to budget exceeded or rate limiting.
  // Re-enqueueing budget-blocked tasks creates a tight retry loop (877+ failed
  // entries and 1,656 dispatch_failed events). These tasks should wait for the
  // next budget window reset rather than spinning.
  const budgetExceeded = event.payload.budgetExceeded === true;
  const rateLimited = event.payload.rateLimited === true;
  if (budgetExceeded || rateLimited) {
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

  // Look for a verifier: config-driven first, then regex fallback
  const extCfg = getExtendedProjectConfig(event.projectId);
  let verifierAgentId: string | null = null;
  let verifierProjectDir: string | undefined;

  // 1. Try explicit review.verifierAgent config
  if (extCfg?.review?.verifierAgent) {
    const entry = getAgentConfig(extCfg.review.verifierAgent);
    if (entry && entry.projectId === event.projectId) {
      verifierAgentId = extCfg.review.verifierAgent;
      verifierProjectDir = entry.projectDir;
    }
  }

  // 2. Fallback: regex pattern matching (backward compat)
  if (!verifierAgentId) {
    const agentIds = getRegisteredAgentIds();
    for (const agentId of agentIds) {
      const entry = getAgentConfig(agentId);
      if (!entry || entry.projectId !== event.projectId) continue;
      if (/verifier|reviewer/i.test(agentId)) {
        verifierAgentId = agentId;
        verifierProjectDir = entry.projectDir;
        break;
      }
    }
  }

  if (!verifierAgentId) {
    // No verifier configured — orchestrator handles it manually
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

function handleDispatchDeadLetter(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const taskId = event.payload.taskId as string | undefined;
  if (!taskId) return { action: "ignored" };

  // Mark task metadata with dead letter flag
  const task = getTask(event.projectId, taskId, db);
  if (task) {
    const metadata = task.metadata ?? {};
    metadata["$.dispatch_dead_letter"] = true;
    metadata["$.dispatch_dead_letter_at"] = Date.now();
    db.prepare("UPDATE tasks SET metadata = ? WHERE id = ?").run(
      JSON.stringify(metadata),
      taskId,
    );
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

function handleProposalApproved(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const proposalId = event.payload.proposalId as string | undefined;
  if (!proposalId) return { action: "ignored" };

  const proposal = getProposal(event.projectId, proposalId);
  if (!proposal || proposal.status !== "approved") return { action: "handled" };

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
      const taskId = snapshot.taskId as string | undefined;
      const toState = snapshot.toState as string | undefined;

      if (taskId && toState) {
        const result = transitionTask({
          projectId: event.projectId,
          taskId,
          toState: toState as Parameters<typeof transitionTask>[0]["toState"],
          actor: proposal.proposed_by,
          reason: `Approved via proposal ${proposalId}`,
          verificationRequired: false,
        }, db);

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
    } catch (err) {
      safeLog("event.router.proposalAction", err);
    }
  }

  return { action: "handled" };
}

function handleProposalCreated(_event: ClawforceEvent, _db: DatabaseSync): EventHandlerResult {
  // Acknowledged for metrics/audit — no action needed
  return { action: "handled" };
}

function handleProposalRejected(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const proposalId = event.payload.proposalId as string | undefined;
  if (!proposalId) return { action: "ignored" };

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
