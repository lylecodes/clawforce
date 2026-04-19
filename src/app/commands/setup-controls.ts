import { writeAuditEntry } from "../../audit.js";
import { safeLog } from "../../diagnostics.js";
import { enqueue, releaseActiveItem, retryFailedItem } from "../../dispatch/queue.js";
import { getAgentConfig } from "../../project.js";
import {
  getCurrentControllerGeneration,
  requestControllerGeneration,
} from "../../runtime/controller-leases.js";
import { replayRecurringJobTask } from "../../scheduling/recurring-jobs.js";
import { resolveEffectiveConfig } from "../../jobs.js";
import { getTask } from "../../tasks/ops.js";

export type SetupControlCommandResult = {
  status: number;
  body: unknown;
};

function buildRecurringDispatchPayload(
  projectId: string,
  taskId: string,
): Record<string, unknown> | undefined {
  const task = getTask(projectId, taskId);
  if (!task?.assignedTo) return undefined;

  const payload: Record<string, unknown> = {};
  const recurringJob = task.metadata
    && typeof task.metadata === "object"
    && !Array.isArray(task.metadata)
    && typeof task.metadata.recurringJob === "object"
    && task.metadata.recurringJob !== null
    && !Array.isArray(task.metadata.recurringJob)
    ? task.metadata.recurringJob as Record<string, unknown>
    : null;
  const jobName = typeof recurringJob?.jobName === "string"
    ? recurringJob.jobName.trim()
    : "";
  if (jobName) {
    payload.jobName = jobName;
  }

  const agentEntry = getAgentConfig(task.assignedTo, projectId);
  const effectiveConfig = jobName && agentEntry?.config
    ? resolveEffectiveConfig(agentEntry.config, jobName) ?? agentEntry.config
    : agentEntry?.config;
  if (typeof effectiveConfig?.model === "string" && effectiveConfig.model.trim()) {
    payload.model = effectiveConfig.model.trim();
  }

  return Object.keys(payload).length > 0 ? payload : undefined;
}

export function runRequestControllerHandoffCommand(
  projectId: string,
  body: Record<string, unknown>,
): SetupControlCommandResult {
  const actor = typeof body.actor === "string" && body.actor.trim()
    ? body.actor.trim()
    : "dashboard:setup";
  const generation = getCurrentControllerGeneration();
  const actionId = `setup-controller-handoff:${projectId}:${Date.now()}`;

  requestControllerGeneration(projectId, {
    generation,
    requestedBy: actor,
    reason: "dashboard_setup_handoff_request",
    metadata: {
      origin: "dashboard_setup",
      actionId,
    },
  });

  try {
    writeAuditEntry({
      projectId,
      actor,
      action: "setup.controller_handoff.requested",
      targetType: "controller_lease",
      targetId: projectId,
      detail: JSON.stringify({ generation, actionId }),
    });
  } catch (err) {
    safeLog("setupControls.requestControllerHandoff.audit", err);
  }

  return {
    status: 200,
    body: {
      ok: true,
      message: `Requested controller handoff for ${projectId}; the next live controller should claim generation ${generation}.`,
      actionId,
      mode: "handoff_requested",
      requestedGeneration: generation,
    },
  };
}

export function runRecoverRecurringRunCommand(
  projectId: string,
  taskId: string,
  body: Record<string, unknown>,
): SetupControlCommandResult {
  const actor = typeof body.actor === "string" && body.actor.trim()
    ? body.actor.trim()
    : "dashboard:setup";
  const release = releaseActiveItem(projectId, { taskId, actor, reason: "dashboard_setup_recurring_recovery" });
  let mode: "released" | "retried" | "replayed";
  let queueItemId: string | undefined;
  let recoveredTaskId: string | undefined;

  if (release.ok) {
    mode = "released";
    queueItemId = release.queueItem.id;
    recoveredTaskId = release.previousItem.taskId;
  } else {
    const retry = retryFailedItem(projectId, { taskId, actor });
    if (retry.ok) {
      mode = retry.queueItem.taskId === taskId ? "retried" : "replayed";
      queueItemId = retry.queueItem.id;
      recoveredTaskId = retry.queueItem.taskId;
    } else {
      const replay = replayRecurringJobTask(projectId, taskId, actor);
      if (!replay.ok) {
        return { status: 400, body: { error: replay.reason } };
      }
      const queueItem = enqueue(
        projectId,
        replay.task.id,
        buildRecurringDispatchPayload(projectId, replay.task.id),
        undefined,
        undefined,
        undefined,
        false,
        true,
      );
      if (!queueItem) {
        return {
          status: 500,
          body: { error: `Failed to enqueue replayed recurring task ${replay.task.id}` },
        };
      }
      mode = "replayed";
      queueItemId = queueItem.id;
      recoveredTaskId = replay.task.id;
    }
  }

  const generation = getCurrentControllerGeneration();
  const actionId = `setup-recurring-recovery:${taskId}:${Date.now()}`;
  requestControllerGeneration(projectId, {
    generation,
    requestedBy: actor,
    reason: `dashboard_setup_recovery:${taskId}`,
    metadata: {
      origin: "dashboard_setup",
      actionId,
      taskId,
      recoveryMode: mode,
      recoveredTaskId,
      queueItemId,
    },
  });

  try {
    writeAuditEntry({
      projectId,
      actor,
      action: "setup.recurring_recovery",
      targetType: "task",
      targetId: taskId,
      detail: JSON.stringify({
        actionId,
        recoveryMode: mode,
        recoveredTaskId,
        queueItemId,
        requestedGeneration: generation,
      }),
    });
  } catch (err) {
    safeLog("setupControls.recoverRecurringRun.audit", err);
  }

  const actionLabel = mode === "released"
    ? "Released the stalled recurring dispatch back to queued work"
    : mode === "retried"
      ? "Retried the recurring run from its failed dispatch"
      : "Replayed the recurring run with a fresh task";

  return {
    status: 200,
    body: {
      ok: true,
      message: `${actionLabel} and requested controller handoff for ${projectId}.`,
      actionId,
      mode,
      requestedGeneration: generation,
      taskId,
      queueItemId,
      recoveredTaskId,
    },
  };
}
