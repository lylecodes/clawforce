/**
 * Clawforce — Core operations
 *
 * createTask, transitionTask, attachEvidence, getTask, listTasks
 * All operations are SQLite-backed and emit diagnostic events.
 */

import crypto from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { writeAuditEntry } from "../audit.js";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";
import { getDb } from "../db.js";
import { signAction } from "../identity.js";
import { getExtendedProjectConfig } from "../project.js";
import { classifyRisk } from "../risk/classifier.js";
import { getRiskConfig } from "../risk/config.js";
import { applyRiskGate } from "../risk/gate.js";
import { getApprovalNotifier } from "../approval/notify.js";
import { isTaskInFuturePhase } from "../workflow.js";
import { validateTransition } from "./state-machine.js";
import type {
  Evidence,
  EvidenceType,
  Task,
  TaskKind,
  TaskPriority,
  TaskResult,
  TaskState,
  Transition,
  TransitionResult,
} from "../types.js";
import { recordMetric, recordTaskCycleTime } from "../metrics.js";
import { clearWorkerAssignment, registerWorkerAssignment } from "../worker-registry.js";
import { ingestEvent } from "../events/store.js";
import { validateEvidence } from "./evidence-schema.js";
import { completeItem as completeQueueItem, failItem as failQueueItem, cancelItem as cancelQueueItem } from "../dispatch/queue.js";
import { getAgentConfig, getRegisteredAgentIds } from "../project.js";

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    description: (row.description as string) ?? undefined,
    state: row.state as TaskState,
    priority: row.priority as TaskPriority,
    assignedTo: (row.assigned_to as string) ?? undefined,
    createdBy: row.created_by as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    deadline: (row.deadline as number) ?? undefined,
    retryCount: row.retry_count as number,
    maxRetries: row.max_retries as number,
    tags: row.tags ? JSON.parse(row.tags as string) : undefined,
    workflowId: (row.workflow_id as string) ?? undefined,
    workflowPhase: (row.workflow_phase as number) ?? undefined,
    parentTaskId: (row.parent_task_id as string) ?? undefined,
    department: (row.department as string) ?? undefined,
    team: (row.team as string) ?? undefined,
    goalId: (row.goal_id as string) ?? undefined,
    kind: (row.kind as TaskKind) ?? undefined,
    origin: (row.origin as import("../types.js").TaskOrigin) ?? undefined,
    originId: (row.origin_id as string) ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
  };
}

function rowToEvidence(row: Record<string, unknown>): Evidence {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    type: row.type as EvidenceType,
    content: row.content as string,
    contentHash: row.content_hash as string,
    attachedBy: row.attached_by as string,
    attachedAt: row.attached_at as number,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
  };
}

function rowToTransition(row: Record<string, unknown>): Transition {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    fromState: row.from_state as TaskState,
    toState: row.to_state as TaskState,
    actor: row.actor as string,
    actorSignature: (row.actor_signature as string) ?? undefined,
    reason: (row.reason as string) ?? undefined,
    evidenceId: (row.evidence_id as string) ?? undefined,
    createdAt: row.created_at as number,
  };
}

export function createTask(
  params: {
    projectId: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    assignedTo?: string;
    createdBy: string;
    deadline?: number;
    maxRetries?: number;
    tags?: string[];
    workflowId?: string;
    workflowPhase?: number;
    parentTaskId?: string;
    department?: string;
    team?: string;
    goalId?: string;
    kind?: TaskKind;
    origin?: import("../types.js").TaskOrigin;
    originId?: string;
    metadata?: Record<string, unknown>;
  },
  dbOverride?: DatabaseSync,
): Task {
  const db = dbOverride ?? getDb(params.projectId);

  // Validate parent exists when parentTaskId is provided
  if (params.parentTaskId) {
    const parentRow = db.prepare(
      "SELECT id FROM tasks WHERE id = ? AND project_id = ?",
    ).get(params.parentTaskId, params.projectId) as Record<string, unknown> | undefined;
    if (!parentRow) {
      throw new Error(`Parent task "${params.parentTaskId}" not found in project "${params.projectId}"`);
    }
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  // Reject system/internal actors as assignees — tasks must be assigned to real agents
  const assignedTo = params.assignedTo?.startsWith("system:") ? undefined : params.assignedTo;
  let state: TaskState = assignedTo ? "ASSIGNED" : "OPEN";

  // Workflow phase gate: force OPEN if task is in a future phase
  if (state === "ASSIGNED" && params.workflowId && params.workflowPhase != null) {
    const gate = isTaskInFuturePhase({ workflowId: params.workflowId, workflowPhase: params.workflowPhase, projectId: params.projectId }, db);
    if (gate.blocked) {
      state = "OPEN";
    }
  }

  const stmt = db.prepare(`
    INSERT INTO tasks (id, project_id, title, description, state, priority, assigned_to,
      created_by, created_at, updated_at, deadline, retry_count, max_retries, tags,
      workflow_id, workflow_phase, parent_task_id, department, team, goal_id, kind, origin, origin_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Wrap task INSERT + audit + event in a single transaction for atomicity.
  // If any write fails, the whole thing rolls back — no orphaned tasks without event trails.
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    stmt.run(
      id,
      params.projectId,
      params.title,
      params.description ?? null,
      state,
      params.priority ?? "P2",
      assignedTo ?? null,
      params.createdBy,
      now,
      now,
      params.deadline ?? null,
      params.maxRetries ?? 3,
      params.tags ? JSON.stringify(params.tags) : null,
      params.workflowId ?? null,
      params.workflowPhase ?? null,
      params.parentTaskId ?? null,
      params.department ?? null,
      params.team ?? null,
      params.goalId ?? null,
      params.kind ?? null,
      params.origin ?? null,
      params.originId ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
    );

    writeAuditEntry({
      projectId: params.projectId,
      actor: params.createdBy,
      action: "task.create",
      targetType: "task",
      targetId: id,
      detail: params.title,
      withinTransaction: true,
    }, db);

    // Emit task_created event ONLY. handleTaskCreated() in the event router is the
    // single entry point that handles both OPEN and ASSIGNED tasks:
    // - OPEN tasks → auto-assign (if configured) → emits task_assigned
    // - ASSIGNED tasks → emits task_assigned (so dispatch fires)
    // This eliminates duplicate task_assigned events from createTask + handleTaskCreated.
    ingestEvent(params.projectId, "task_created", "internal", {
      taskId: id,
      title: params.title,
      state,
      assignedTo,
      department: params.department,
      team: params.team,
    }, `task-created:${id}`, db);

    db.prepare("COMMIT").run();
  } catch (err) {
    try { db.prepare("ROLLBACK").run(); } catch { /* already rolled back */ }
    throw err;
  }

  const task = getTask(params.projectId, id, db)!;

  // Check for potential duplicate (non-terminal task with same title)
  let duplicateWarning: string | undefined;
  try {
    const existing = db.prepare(
      "SELECT id, state FROM tasks WHERE project_id = ? AND title = ? AND state NOT IN ('DONE', 'FAILED', 'CANCELLED') AND id != ?",
    ).get(params.projectId, params.title, id) as Record<string, unknown> | undefined;
    if (existing) {
      duplicateWarning = `Potential duplicate: task "${params.title}" already exists as ${(existing.id as string).slice(0, 8)} (${existing.state})`;
    }
  } catch (err) {
    safeLog("task.create.dedupCheck", err);
  }
  (task as Task & { duplicateWarning?: string }).duplicateWarning = duplicateWarning;

  // Track assignment so bootstrap hook can detect workers (side effect — outside transaction)
  if (assignedTo) {
    registerWorkerAssignment(assignedTo, params.projectId, id);
  }

  // Diagnostic emitter — external side effect, not a DB write
  try {
    emitDiagnosticEvent({
      type: "clawforce.transition",
      projectId: params.projectId,
      taskId: id,
      fromState: "NONE",
      toState: state,
      actor: params.createdBy,
    });
  } catch (err) {
    safeLog("task.create.diagnostic", err);
  }

  return task;
}

export function transitionTask(
  params: {
    projectId: string;
    taskId: string;
    toState: TaskState;
    actor: string;
    reason?: string;
    evidenceId?: string;
    verificationRequired?: boolean;
    assignedTo?: string;
    /** Skip BEGIN/COMMIT wrapping when caller already holds a transaction. */
    withinTransaction?: boolean;
  },
  dbOverride?: DatabaseSync,
): TransitionResult {
  const db = dbOverride ?? getDb(params.projectId);
  const task = getTask(params.projectId, params.taskId, db);
  if (!task) return { ok: false, reason: "Task not found" };

  // Risk tier check (before validation)
  try {
    const extConfig = getExtendedProjectConfig(params.projectId);
    const riskConfig = getRiskConfig(extConfig?.riskTiers);
    if (riskConfig.enabled) {
      const classification = classifyRisk({
        actionType: "transition",
        toState: params.toState,
        fromState: task.state,
        taskPriority: task.priority,
        actor: params.actor,
      }, riskConfig);

      if (classification.tier !== "low") {
        const gateResult = applyRiskGate({
          projectId: params.projectId,
          actionType: "transition",
          actionDetail: `${task.state} → ${params.toState} on task "${task.title}"`,
          actor: params.actor,
          classification,
          config: riskConfig,
          dbOverride: db,
        });

        if (gateResult.action === "block") {
          return { ok: false, reason: gateResult.reason };
        }
        if (gateResult.action === "require_approval") {
          // Create a proposal for this action
          try {
            const proposalId = crypto.randomUUID();
            const proposalDesc = `Risk-gated transition: ${task.state} → ${params.toState} on task ${task.id}`;
            db.prepare(`
              INSERT INTO proposals (id, project_id, title, description, proposed_by, status, risk_tier, created_at)
              VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
            `).run(
              proposalId, params.projectId, gateResult.proposalTitle,
              proposalDesc, params.actor, classification.tier, Date.now(),
            );

            // Notify via configured channel (async, non-blocking)
            getApprovalNotifier()?.sendProposalNotification({
              proposalId,
              projectId: params.projectId,
              title: gateResult.proposalTitle,
              description: proposalDesc,
              proposedBy: params.actor,
              riskTier: classification.tier,
            }).catch(err => safeLog("transition.proposalNotify", err));

            // Emit proposal_created event
            try {
              ingestEvent(params.projectId, "proposal_created", "internal", {
                proposalId,
                proposedBy: params.actor,
                riskTier: classification.tier,
                title: gateResult.proposalTitle,
              }, `proposal-created:${proposalId}`, db);
            } catch (err2) {
              safeLog("transition.proposalEvent", err2);
            }
          } catch (err) {
            safeLog("transition.riskProposal", err);
          }
          return { ok: false, reason: `Action requires approval (risk tier: ${classification.tier}): ${classification.reasons.join("; ")}` };
        }
        // delay: proceed but log it (actual delay enforcement is at dispatch level)
      }
    }
  } catch (err) {
    safeLog("transition.riskCheck", err);
    // Risk check failure is non-fatal — proceed
  }

  // Workflow phase gate: block ASSIGNED/IN_PROGRESS for future-phase tasks
  if (params.toState === "ASSIGNED" || params.toState === "IN_PROGRESS") {
    const gate = isTaskInFuturePhase(task, db);
    if (gate.blocked) {
      return { ok: false, reason: gate.reason! };
    }
  }

  // Parent dependency gate: block IN_PROGRESS if parent task is not DONE
  if (params.toState === "IN_PROGRESS" && task.parentTaskId) {
    const parentRow = db.prepare(
      "SELECT id, state FROM tasks WHERE id = ? AND project_id = ?",
    ).get(task.parentTaskId, params.projectId) as Record<string, unknown> | undefined;
    if (parentRow && (parentRow.state as string) !== "DONE") {
      return {
        ok: false,
        reason: `Cannot start: parent task ${(parentRow.id as string).slice(0, 8)} is still in state ${parentRow.state}`,
      };
    }
  }

  // Check if evidence exists when transitioning to REVIEW
  let hasEvidence = !!params.evidenceId;
  if (!hasEvidence && task.state === "IN_PROGRESS" && params.toState === "REVIEW") {
    const evidenceRow = db
      .prepare("SELECT COUNT(*) as cnt FROM evidence WHERE task_id = ?")
      .get(params.taskId) as Record<string, unknown> | undefined;
    hasEvidence = !!evidenceRow && (evidenceRow.cnt as number) > 0;
  }

  // Compute verificationRequired: respect explicit param, then check self-review config
  let verificationRequired = params.verificationRequired ?? true;

  if (verificationRequired && task.state === "REVIEW" &&
      (params.toState === "DONE" || params.toState === "FAILED" || params.toState === "IN_PROGRESS") &&
      params.actor === task.assignedTo) {
    const reviewConfig = getExtendedProjectConfig(params.projectId)?.review;
    if (reviewConfig?.selfReviewAllowed) {
      const maxPriority = reviewConfig.selfReviewMaxPriority ?? "P3";
      if (isSelfReviewEligible(task.priority, maxPriority)) {
        verificationRequired = false;
      }
    }
  }

  const error = validateTransition({
    task,
    toState: params.toState,
    actor: params.actor,
    hasEvidence,
    verificationRequired,
  });

  if (error) return { ok: false, reason: error.message };

  // Lease-conflict check condition — actual query moved inside transaction to avoid TOCTOU
  const needsLeaseCheck =
    (task.state === "OPEN" && params.toState === "ASSIGNED") ||
    (task.state === "ASSIGNED" && params.toState === "IN_PROGRESS");

  const now = Date.now();
  const transitionId = crypto.randomUUID();
  const signatureData = `${transitionId}:${params.taskId}:${task.state}:${params.toState}:${params.actor}:${now}`;
  let actorSignature: string | undefined;
  try {
    actorSignature = signAction(params.actor, signatureData);
  } catch (err) {
    safeLog("transition.sign", err);
  }

  // Update task state
  const updateFields: string[] = ["state = ?", "updated_at = ?"];
  const updateValues: SQLInputValue[] = [params.toState, now];

  // Handle assignment on any transition → ASSIGNED
  if (params.toState === "ASSIGNED" && params.assignedTo) {
    updateFields.push("assigned_to = ?");
    updateValues.push(params.assignedTo);
  } else if (params.toState === "ASSIGNED" && task.state === "OPEN") {
    updateFields.push("assigned_to = ?");
    updateValues.push(params.actor);
  }

  // Increment retry on FAILED → OPEN
  if (task.state === "FAILED" && params.toState === "OPEN") {
    updateFields.push("retry_count = retry_count + 1");
  }

  // Clear assignment on unassign transitions
  if (params.toState === "OPEN" && task.state !== "FAILED") {
    updateFields.push("assigned_to = NULL");
  }

  updateValues.push(params.taskId, task.state, params.projectId);

  // D1: Wrap state UPDATE + transition INSERT + audit + events in a single transaction.
  // This ensures no inconsistent state: if any DB write fails, everything rolls back.
  // Side effects (queue ops, worker registry, diagnostics, child unblocking) stay outside.
  const ownTransaction = !params.withinTransaction;
  if (ownTransaction) db.prepare("BEGIN IMMEDIATE").run();
  try {
    // Re-read task state inside transaction to close TOCTOU window between
    // the initial getTask() (pre-validation) and the actual UPDATE.
    const freshTask = db.prepare(
      "SELECT state, lease_holder, lease_expires_at FROM tasks WHERE id = ? AND project_id = ?",
    ).get(params.taskId, params.projectId) as Record<string, unknown> | undefined;

    if (!freshTask || freshTask.state !== task.state) {
      if (ownTransaction) db.prepare("ROLLBACK").run();
      return { ok: false, reason: `Concurrent state change: task no longer in state "${task.state}"` };
    }

    // Lease-conflict check using fresh read (no separate query needed)
    if (needsLeaseCheck) {
      const holder = freshTask.lease_holder as string | null;
      const expiresAt = freshTask.lease_expires_at as number | null;
      const actor = params.assignedTo ?? params.actor;

      if (holder && expiresAt && expiresAt > Date.now() && holder !== actor) {
        if (ownTransaction) db.prepare("ROLLBACK").run();
        return {
          ok: false,
          reason: `Task is leased by "${holder}" until ${new Date(expiresAt).toISOString()}. Cannot transition while another agent holds the lease.`,
        };
      }
    }

    const updateResult = db.prepare(
      `UPDATE tasks SET ${updateFields.join(", ")} WHERE id = ? AND state = ? AND project_id = ?`
    ).run(...updateValues);
    if (updateResult.changes === 0) {
      if (ownTransaction) db.prepare("ROLLBACK").run();
      return { ok: false, reason: `Concurrent state change: task no longer in state "${task.state}"` };
    }

    // Record transition
    db.prepare(`
      INSERT INTO transitions (id, task_id, from_state, to_state, actor, actor_signature, reason, evidence_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      transitionId,
      params.taskId,
      task.state,
      params.toState,
      params.actor,
      actorSignature ?? null,
      params.reason ?? null,
      params.evidenceId ?? null,
      now,
    );

    // Audit log entry — inside transaction for atomicity
    writeAuditEntry({
      projectId: params.projectId,
      actor: params.actor,
      action: "task.transition",
      targetType: "task",
      targetId: params.taskId,
      detail: JSON.stringify({ from: task.state, to: params.toState, reason: params.reason }),
      withinTransaction: true,
    }, db);

    // Event writes — inside transaction so event trail is always consistent with state

    if (params.toState === "ASSIGNED") {
      const assignee = params.assignedTo ?? params.actor;
      ingestEvent(params.projectId, "task_assigned", "internal", {
        taskId: params.taskId,
        assignedTo: assignee,
        fromState: task.state,
      }, `task-assigned:${params.taskId}:${transitionId}`, db);
    }

    if (task.state === "IN_PROGRESS" && params.toState === "REVIEW") {
      let evidenceCount = 0;
      try {
        const evidenceRow = db.prepare("SELECT COUNT(*) as cnt FROM evidence WHERE task_id = ?").get(params.taskId) as Record<string, unknown> | undefined;
        evidenceCount = (evidenceRow?.cnt as number) ?? 0;
      } catch (err) { safeLog("transition.evidenceCount", err); }

      ingestEvent(params.projectId, "task_review_ready", "internal", {
        taskId: params.taskId,
        assignedTo: task.assignedTo,
        fromState: task.state,
        evidenceCount,
      }, `task-review:${params.taskId}:${transitionId}`, db);
    }

    if (params.toState === "DONE") {
      ingestEvent(params.projectId, "task_completed", "internal", {
        taskId: params.taskId,
        actor: params.actor,
        workflowId: task.workflowId,
      }, `task-completed:${params.taskId}`, db);
    }

    if (params.toState === "FAILED") {
      ingestEvent(params.projectId, "task_failed", "internal", {
        taskId: params.taskId,
        actor: params.actor,
        reason: params.reason,
        workflowId: task.workflowId,
      }, `task-failed:${params.taskId}:${transitionId}`, db);
    }

    // Always emit task_transitioned for every state change
    ingestEvent(params.projectId, "task_transitioned", "internal", {
      taskId: params.taskId,
      fromState: task.state,
      toState: params.toState,
      agentId: params.actor,
      transitionId,
    }, `task-transitioned:${params.taskId}:${transitionId}`, db);

    if (ownTransaction) db.prepare("COMMIT").run();
  } catch (err) {
    if (ownTransaction) {
      try { db.prepare("ROLLBACK").run(); } catch { /* already rolled back */ }
    }
    throw err;
  }

  // --- Side effects (outside transaction) ---

  // Track/clear worker assignment for bootstrap hook detection
  if (params.toState === "ASSIGNED") {
    const assignee = params.assignedTo ?? params.actor;
    registerWorkerAssignment(assignee, params.projectId, params.taskId);
  }
  if (params.toState === "DONE" || params.toState === "FAILED" || params.toState === "CANCELLED") {
    if (task.assignedTo) clearWorkerAssignment(task.assignedTo, db);
  }

  // Update dispatch queue item when task leaves dispatchable states
  // This ensures the queue reflects completion even if the adapter hook doesn't fire
  try {
    const isNonDispatchable = params.toState !== "ASSIGNED" && params.toState !== "IN_PROGRESS";

    if (isNonDispatchable) {
      // Cancel any pending (queued) items — they haven't started yet, don't let them
      // reach the dispatcher only to fail with non_dispatchable_state.
      const pendingItems = db.prepare(
        `SELECT id FROM dispatch_queue
         WHERE project_id = ? AND task_id = ? AND status = 'queued'`,
      ).all(params.projectId, params.taskId) as Array<Record<string, unknown>>;
      // eslint-disable-next-line no-console
      console.debug("[ops] cancelPending", params.toState, pendingItems.length, params.projectId, params.taskId);
      for (const item of pendingItems) {
        cancelQueueItem(String(item["id"]), db);
      }
    }

    // Also clean up any active (leased/dispatched) items
    const activeQueueItem = db.prepare(
      `SELECT id FROM dispatch_queue
       WHERE project_id = ? AND task_id = ? AND status IN ('dispatched', 'leased')
       LIMIT 1`,
    ).get(params.projectId, params.taskId) as Record<string, unknown> | undefined;
    if (activeQueueItem) {
      const queueItemId = activeQueueItem.id as string;
      if (params.toState === "FAILED" || params.toState === "CANCELLED") {
        failQueueItem(queueItemId, `Task transitioned to ${params.toState}`, db, params.projectId);
      } else if (params.toState !== "ASSIGNED" && params.toState !== "IN_PROGRESS") {
        // Task advanced past dispatch states (e.g. REVIEW, DONE) — mark completed
        completeQueueItem(queueItemId, db, params.projectId);
      }
    }
  } catch (err) { safeLog("transition.queueUpdate", err); }

  // Record cycle time metric when task reaches DONE (exclude exercise tasks from KPI metrics)
  if (params.toState === "DONE") {
    if (task.kind !== "exercise") {
      try {
        recordTaskCycleTime(params.projectId, params.taskId, task.createdAt, now, task.assignedTo, db);
      } catch (err) { safeLog("transition.cycleTime", err); }

      // Record completion_rate metric (value 1.0 = completed) for SLO tracking
      try {
        recordMetric({
          projectId: params.projectId,
          type: "task",
          subject: params.taskId,
          key: "completion_rate",
          value: 1,
          tags: { assignedTo: task.assignedTo, department: task.department },
        }, db);
      } catch (err) { safeLog("transition.completionRate", err); }
    }
  }

  // Record completion_rate metric (value 0 = failed) for SLO tracking (exclude exercise tasks)
  if (params.toState === "FAILED" && task.kind !== "exercise") {
    try {
      recordMetric({
        projectId: params.projectId,
        type: "task",
        subject: params.taskId,
        key: "completion_rate",
        value: 0,
        tags: { assignedTo: task.assignedTo, department: task.department },
      }, db);
    } catch (err) { safeLog("transition.completionRateFailed", err); }
  }

  // Auto-unblock child tasks: when a parent completes, move BLOCKED children to ASSIGNED
  // (outside transaction — each child transition manages its own transaction)
  if (params.toState === "DONE") {
    try {
      const blockedChildren = db.prepare(
        "SELECT id, assigned_to FROM tasks WHERE parent_task_id = ? AND project_id = ? AND state = 'BLOCKED'",
      ).all(params.taskId, params.projectId) as Array<Record<string, unknown>>;
      for (const child of blockedChildren) {
        const childId = child.id as string;
        const childAssignee = child.assigned_to as string | null;
        transitionTask({
          projectId: params.projectId,
          taskId: childId,
          toState: childAssignee ? "ASSIGNED" : "OPEN",
          actor: "system:dependency",
          reason: `Parent task ${params.taskId.slice(0, 8)} completed — unblocking`,
        }, db);
      }
    } catch (err) { safeLog("transition.unblockChildren", err); }
  }

  const updatedTask = getTask(params.projectId, params.taskId, db)!;
  const transition: Transition = {
    id: transitionId,
    taskId: params.taskId,
    fromState: task.state,
    toState: params.toState,
    actor: params.actor,
    actorSignature,
    reason: params.reason,
    evidenceId: params.evidenceId,
    createdAt: now,
  };

  try {
    emitDiagnosticEvent({
      type: "clawforce.transition",
      projectId: params.projectId,
      taskId: params.taskId,
      fromState: task.state,
      toState: params.toState,
      actor: params.actor,
    });
  } catch (err) {
    safeLog("transition.diagnostic", err);
  }

  return { ok: true, task: updatedTask, transition };
}

/**
 * Reassign a task to a new agent. Routes through transitionTask for
 * IN_PROGRESS → ASSIGNED state changes. For ASSIGNED tasks (no state change),
 * handles assignment update with proper audit trail and worker registry.
 */
export function reassignTask(
  params: {
    projectId: string;
    taskId: string;
    newAssignee: string;
    actor: string;
    reason?: string;
  },
  dbOverride?: DatabaseSync,
): TransitionResult {
  const db = dbOverride ?? getDb(params.projectId);
  const task = getTask(params.projectId, params.taskId, db);
  if (!task) return { ok: false, reason: "Task not found" };

  // Skip reassignment if already assigned to the same agent
  if (task.state === "ASSIGNED" && task.assignedTo === params.newAssignee) {
    return { ok: true, task, transition: { id: "", taskId: params.taskId, fromState: "ASSIGNED", toState: "ASSIGNED", actor: params.actor, createdAt: Date.now() } };
  }

  // Validate that the target agent exists in the domain config (when agents are registered)
  try {
    const allAgentIds = getRegisteredAgentIds();
    const projectAgentIds = allAgentIds.filter((id) => {
      const entry = getAgentConfig(id);
      return entry?.projectId === params.projectId;
    });
    // Only enforce when agents are registered for this project (skip in test/bare setups)
    if (projectAgentIds.length > 0 && !projectAgentIds.includes(params.newAssignee)) {
      return {
        ok: false,
        reason: `Agent "${params.newAssignee}" is not registered in project "${params.projectId}". Cannot reassign to a non-existent agent.`,
      };
    }
  } catch {
    // If project module is unavailable, skip validation
  }

  if (task.state !== "ASSIGNED" && task.state !== "IN_PROGRESS") {
    return {
      ok: false,
      reason: `Cannot reassign task in state ${task.state}. Only ASSIGNED or IN_PROGRESS tasks can be reassigned.`,
    };
  }

  const previousAssignee = task.assignedTo;
  const reassignReason = params.reason ?? `Reassigned from ${previousAssignee ?? "unassigned"} to ${params.newAssignee}`;

  if (task.state === "IN_PROGRESS") {
    // State change — route through transitionTask for full validation
    return transitionTask({
      projectId: params.projectId,
      taskId: params.taskId,
      toState: "ASSIGNED",
      actor: params.actor,
      assignedTo: params.newAssignee,
      reason: reassignReason,
      verificationRequired: false,
    }, db);
  }

  // ASSIGNED — no state change, just update the assignee
  // Still need: phase gate, audit, worker registry, signature

  const gate = isTaskInFuturePhase(task, db);
  if (gate.blocked) {
    return { ok: false, reason: gate.reason! };
  }

  const now = Date.now();
  const transitionId = crypto.randomUUID();
  const signatureData = `${transitionId}:${params.taskId}:ASSIGNED:ASSIGNED:${params.actor}:${now}`;
  let actorSignature: string | undefined;
  try {
    actorSignature = signAction(params.actor, signatureData);
  } catch (err) {
    safeLog("reassign.sign", err);
  }

  // Wrap UPDATE + INSERT in a transaction for atomicity (matching transitionTask pattern)
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    // Update assigned_to (optimistic lock on state)
    const updateResult = db.prepare(
      "UPDATE tasks SET assigned_to = ?, updated_at = ? WHERE id = ? AND state = 'ASSIGNED' AND project_id = ?",
    ).run(params.newAssignee, now, params.taskId, params.projectId);

    if (updateResult.changes === 0) {
      db.prepare("ROLLBACK").run();
      return { ok: false, reason: "Concurrent state change: task no longer in ASSIGNED state" };
    }

    // Record transition
    db.prepare(`
      INSERT INTO transitions (id, task_id, from_state, to_state, actor, actor_signature, reason, created_at)
      VALUES (?, ?, 'ASSIGNED', 'ASSIGNED', ?, ?, ?, ?)
    `).run(transitionId, params.taskId, params.actor, actorSignature ?? null, reassignReason, now);

    db.prepare("COMMIT").run();
  } catch (err) {
    try { db.prepare("ROLLBACK").run(); } catch { /* already rolled back */ }
    throw err;
  }

  // Worker registry
  if (previousAssignee) {
    clearWorkerAssignment(previousAssignee, db);
  }
  registerWorkerAssignment(params.newAssignee, params.projectId, params.taskId);

  // Audit
  try {
    writeAuditEntry({
      projectId: params.projectId,
      actor: params.actor,
      action: "task.reassign",
      targetType: "task",
      targetId: params.taskId,
      detail: JSON.stringify({ previousAssignee, newAssignee: params.newAssignee }),
    }, db);
  } catch (err) {
    safeLog("reassign.audit", err);
  }

  try {
    emitDiagnosticEvent({
      type: "clawforce.transition",
      projectId: params.projectId,
      taskId: params.taskId,
      fromState: "ASSIGNED",
      toState: "ASSIGNED",
      actor: params.actor,
    });
  } catch (err) {
    safeLog("reassign.diagnostic", err);
  }

  // Emit task_assigned event so audit logs and notifications capture reassignment
  try {
    ingestEvent(params.projectId, "task_assigned", "internal", {
      taskId: params.taskId,
      assignedTo: params.newAssignee,
      fromState: "ASSIGNED",
    }, `task-assigned:${params.taskId}:${params.newAssignee}`, db);
  } catch (err) { safeLog("reassign.assignedEvent", err); }

  const updatedTask = getTask(params.projectId, params.taskId, db)!;
  const transition: Transition = {
    id: transitionId,
    taskId: params.taskId,
    fromState: "ASSIGNED",
    toState: "ASSIGNED",
    actor: params.actor,
    actorSignature,
    reason: reassignReason,
    createdAt: now,
  };

  return { ok: true, task: updatedTask, transition };
}

export function attachEvidence(
  params: {
    projectId: string;
    taskId: string;
    type: EvidenceType;
    content: string;
    attachedBy: string;
    metadata?: Record<string, unknown>;
  },
  dbOverride?: DatabaseSync,
): Evidence {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const contentHash = crypto.createHash("sha256").update(params.content).digest("hex");
  const now = Date.now();

  // Advisory validation — log warnings but never block
  try {
    const validation = validateEvidence(params.type, params.content, params.metadata);
    if (!validation.valid) {
      for (const warning of validation.warnings) {
        safeLog("evidence.validation", warning);
      }
    }
  } catch (err) {
    safeLog("evidence.validationInit", err);
  }

  db.prepare(`
    INSERT INTO evidence (id, task_id, type, content, content_hash, attached_by, attached_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.taskId,
    params.type,
    params.content,
    contentHash,
    params.attachedBy,
    now,
    params.metadata ? JSON.stringify(params.metadata) : null,
  );

  try {
    writeAuditEntry({
      projectId: params.projectId,
      actor: params.attachedBy,
      action: "evidence.attach",
      targetType: "evidence",
      targetId: id,
      detail: params.type,
    }, db);
  } catch (err) {
    safeLog("evidence.audit", err);
  }

  return {
    id,
    taskId: params.taskId,
    type: params.type as EvidenceType,
    content: params.content,
    contentHash,
    attachedBy: params.attachedBy,
    attachedAt: now,
    metadata: params.metadata,
  };
}

export function getTask(projectId: string, taskId: string, dbOverride?: DatabaseSync): Task | undefined {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : undefined;
}

export function getTasksByIds(projectId: string, taskIds: string[], dbOverride?: DatabaseSync): Task[] {
  if (taskIds.length === 0) return [];
  const db = dbOverride ?? getDb(projectId);
  const placeholders = taskIds.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT * FROM tasks WHERE id IN (${placeholders})`).all(...taskIds) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function getTaskEvidence(projectId: string, taskId: string, dbOverride?: DatabaseSync): Evidence[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare("SELECT * FROM evidence WHERE task_id = ? ORDER BY attached_at").all(taskId) as Record<string, unknown>[];
  return rows.map(rowToEvidence);
}

export function getTaskTransitions(projectId: string, taskId: string, dbOverride?: DatabaseSync): Transition[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare("SELECT * FROM transitions WHERE task_id = ? ORDER BY created_at").all(taskId) as Record<string, unknown>[];
  return rows.map(rowToTransition);
}

export type ListTasksFilter = {
  state?: TaskState;
  states?: TaskState[];
  assignedTo?: string;
  priority?: TaskPriority;
  tags?: string[];
  workflowId?: string;
  department?: string;
  team?: string;
  kind?: TaskKind;
  excludeKinds?: TaskKind[];
  origin?: import("../types.js").TaskOrigin;
  limit?: number;
};

export function listTasks(
  projectId: string,
  filter?: ListTasksFilter,
  dbOverride?: DatabaseSync,
): Task[] {
  const db = dbOverride ?? getDb(projectId);
  const conditions: string[] = ["project_id = ?"];
  const values: SQLInputValue[] = [projectId];

  if (filter?.states && filter.states.length > 0) {
    const placeholders = filter.states.map(() => "?").join(", ");
    conditions.push(`state IN (${placeholders})`);
    values.push(...filter.states);
  } else if (filter?.state) {
    conditions.push("state = ?");
    values.push(filter.state);
  }
  if (filter?.assignedTo) {
    conditions.push("assigned_to = ?");
    values.push(filter.assignedTo);
  }
  if (filter?.priority) {
    conditions.push("priority = ?");
    values.push(filter.priority);
  }
  if (filter?.workflowId) {
    conditions.push("workflow_id = ?");
    values.push(filter.workflowId);
  }
  if (filter?.department) {
    conditions.push("department = ?");
    values.push(filter.department);
  }
  if (filter?.team) {
    conditions.push("team = ?");
    values.push(filter.team);
  }
  if (filter?.kind) {
    conditions.push("kind = ?");
    values.push(filter.kind);
  }
  if (filter?.origin) {
    conditions.push("origin = ?");
    values.push(filter.origin);
  }
  if (filter?.excludeKinds && filter.excludeKinds.length > 0) {
    const placeholders = filter.excludeKinds.map(() => "?").join(", ");
    conditions.push(`(kind IS NULL OR kind NOT IN (${placeholders}))`);
    values.push(...filter.excludeKinds);
  }

  const limit = Math.min(filter?.limit ?? 100, 1000);
  const sql = `SELECT * FROM tasks WHERE ${conditions.join(" AND ")}
    ORDER BY
      CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 END,
      created_at ASC
    LIMIT ?`;
  values.push(limit);

  const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];
  let tasks = rows.map(rowToTask);

  // Tag filtering in application layer (JSON column)
  if (filter?.tags && filter.tags.length > 0) {
    tasks = tasks.filter((t) => filter.tags!.some((tag) => t.tags?.includes(tag)));
  }

  return tasks;
}

// --- Task Leases ---

/**
 * Acquire a lease on a task. Atomic: succeeds only if no active lease exists
 * or the existing lease has expired.
 * Returns true if the lease was acquired.
 */
export function acquireTaskLease(
  projectId: string,
  taskId: string,
  holder: string,
  durationMs: number,
  dbOverride?: DatabaseSync,
): boolean {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const expiresAt = now + durationMs;

  const result = db.prepare(
    `UPDATE tasks
     SET lease_holder = ?, lease_acquired_at = ?, lease_expires_at = ?
     WHERE id = ? AND project_id = ?
       AND (lease_holder IS NULL OR lease_expires_at < ?)`,
  ).run(holder, now, expiresAt, taskId, projectId, now);

  return result.changes > 0;
}

/**
 * Release a task lease. Only the current holder can release it.
 * Returns true if the lease was released.
 */
export function releaseTaskLease(
  projectId: string,
  taskId: string,
  holder: string,
  dbOverride?: DatabaseSync,
): boolean {
  const db = dbOverride ?? getDb(projectId);

  const result = db.prepare(
    `UPDATE tasks
     SET lease_holder = NULL, lease_acquired_at = NULL, lease_expires_at = NULL
     WHERE id = ? AND project_id = ? AND lease_holder = ?`,
  ).run(taskId, projectId, holder);

  return result.changes > 0;
}

/**
 * Renew (extend) an existing task lease. Only the current holder can renew.
 * Returns true if the lease was renewed.
 */
export function renewTaskLease(
  projectId: string,
  taskId: string,
  holder: string,
  durationMs: number,
  dbOverride?: DatabaseSync,
): boolean {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const expiresAt = now + durationMs;

  const result = db.prepare(
    `UPDATE tasks
     SET lease_expires_at = ?
     WHERE id = ? AND project_id = ? AND lease_holder = ?`,
  ).run(expiresAt, taskId, projectId, holder);

  return result.changes > 0;
}

/** Priority ordering: P0=highest, P3=lowest. Returns true if taskPriority is at or below maxPriority. */
const PRIORITY_ORDER: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function isSelfReviewEligible(taskPriority: TaskPriority, maxPriority: TaskPriority): boolean {
  return PRIORITY_ORDER[taskPriority] >= PRIORITY_ORDER[maxPriority];
}
