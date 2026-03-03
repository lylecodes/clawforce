/**
 * Clawforce — Event router
 *
 * Claims pending events and routes each to a type-specific handler.
 * Built-in handlers:
 * - task_completed/task_failed → check workflow phase gates, enqueue next phase
 * - sweep_finding → create/escalate task based on finding
 * - custom → no-op (extensibility point)
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";
import type { ClawforceEvent } from "../types.js";
import { claimPendingEvents, ingestEvent, markFailed, markHandled, markIgnored } from "./store.js";
import { enqueue } from "../dispatch/queue.js";
import { getTask, getTaskEvidence, transitionTask } from "../tasks/ops.js";
import { advanceWorkflow, getWorkflow } from "../workflow.js";
import { getRegisteredAgentIds, getAgentConfig } from "../project.js";
import { recordMetric } from "../metrics.js";
import { writeAuditEntry } from "../audit.js";
import { getProposal } from "../approval/resolve.js";

export type EventHandlerResult = {
  action: "handled" | "ignored" | "enqueued";
  taskId?: string;
  queueItemId?: string;
};

type EventHandler = (
  event: ClawforceEvent,
  db: DatabaseSync,
) => EventHandlerResult;

const handlers: Record<string, EventHandler> = {
  task_completed: handleTaskCompleted,
  task_failed: handleTaskFailed,
  sweep_finding: handleSweepFinding,
  dispatch_succeeded: handleDispatchSucceeded,
  dispatch_failed: handleDispatchFailed,
  task_review_ready: handleTaskReviewReady,
  dispatch_dead_letter: handleDispatchDeadLetter,
  proposal_approved: handleProposalApproved,
  custom: handleCustom,
  ci_failed: handleCustom,
  pr_opened: handleCustom,
  deploy_finished: handleCustom,
};

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

  const outcomes = { handled: 0, ignored: 0, enqueued: 0, failed: 0 };

  for (const event of events) {
    const handler = handlers[event.type] ?? handleCustom;
    try {
      const result = handler(event, db);
      if (result.action === "ignored") {
        markIgnored(event.id, db);
        outcomes.ignored++;
      } else {
        markHandled(event.id, result.action, db);
        if (result.action === "enqueued") outcomes.enqueued++;
        else outcomes.handled++;
      }

      try {
        recordMetric({ projectId, type: "system", subject: event.type, key: "event_processed", value: 1, tags: { eventId: event.id, outcome: result.action, taskId: result.taskId } }, db);
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
      // Already escalated by sweep — just acknowledge
      return { action: "handled", taskId };
    }
    default:
      return { action: "handled", taskId };
  }
}

function handleDispatchSucceeded(_event: ClawforceEvent, _db: DatabaseSync): EventHandlerResult {
  // Acknowledged — useful for auditing, no action needed
  return { action: "handled" };
}

function handleDispatchFailed(event: ClawforceEvent, db: DatabaseSync): EventHandlerResult {
  const taskId = event.payload.taskId as string | undefined;
  if (!taskId) return { action: "ignored" };

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

  // Look for a registered verifier/reviewer agent in the same project
  const agentIds = getRegisteredAgentIds();
  let verifierAgentId: string | null = null;
  let verifierProjectDir: string | undefined;

  for (const agentId of agentIds) {
    const entry = getAgentConfig(agentId);
    if (!entry || entry.projectId !== event.projectId) continue;
    if (/verifier|reviewer/i.test(agentId)) {
      verifierAgentId = agentId;
      verifierProjectDir = entry.projectDir;
      break;
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
    const result = enqueue(event.projectId, taskId, {
      prompt: verifyPrompt,
      projectDir: verifierProjectDir ?? process.cwd(),
    }, undefined, db);

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

function handleCustom(_event: ClawforceEvent, _db: DatabaseSync): EventHandlerResult {
  return { action: "ignored" };
}
