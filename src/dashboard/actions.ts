/**
 * Clawforce — Dashboard action handlers
 *
 * REST POST action handlers: approve, reject, reassign, create task,
 * disable/enable agent, message agent, meeting create/message/end, etc.
 * Each action is a thin wrapper around existing core functions.
 */

import type { RouteResult } from "./routes.js";
import {
  isKnownProjectAgent,
  runDisableAgentCommand,
  runEnableAgentCommand,
  runKillAgentCommand,
} from "../app/commands/agent-controls.js";
import { runResolveApprovalCommand } from "../app/commands/approval-controls.js";
import { runAllocateBudgetCommand } from "../app/commands/budget-controls.js";
import {
  buildConfigPreviewResponse,
  validateConfigSection,
} from "../app/commands/config-validation.js";
import {
  runCreateMeetingCommand,
  runEndMeetingCommand,
  runSendMeetingMessageCommand,
  runSendThreadMessageCommand,
} from "../app/commands/channel-controls.js";
import { emitSSE } from "./sse.js";
import { ingestEvent } from "../events/store.js";
import { getDb } from "../db.js";
import { writeAuditEntry } from "../audit.js";
import { safeLog } from "../diagnostics.js";
import { checkLock, applyOverridePolicy } from "../locks/enforce.js";
import { createActionRecord, withActionTracking, withActionTrackingSync } from "./action-status.js";
import { recordChange, type ChangeProvenance } from "../history/store.js";
import {
  runDisableDomainCommand,
  runEnableDomainCommand,
  runDomainKillCommand,
} from "../app/commands/domain-controls.js";
import {
  previewSaveConfigCommand,
  runSaveConfigCommand,
} from "../app/commands/config-saves.js";
import {
  runCreateDemoDomainCommand,
  runCreateStarterDomainCommand,
} from "../app/commands/domain-setup.js";
import {
  runRecoverRecurringRunCommand,
  runRequestControllerHandoffCommand,
} from "../app/commands/setup-controls.js";
import {
  runAcquireLockCommand,
  runReleaseLockCommand,
  runRevertHistoryChangeCommand,
} from "../app/commands/governance-controls.js";
import { runDismissInterventionCommand } from "../app/commands/intervention-controls.js";
import { runSendDirectMessageCommand } from "../app/commands/operator-messages.js";
import { runIngestProjectEventCommand } from "../app/commands/project-controls.js";
import {
  runAttachTaskEvidenceCommand,
  runCreateTaskCommand,
  runReassignTaskCommand,
  runTransitionTaskCommand,
} from "../app/commands/task-controls.js";
import { setWorkflowDraftSessionVisibility } from "../workspace/drafts.js";
import {
  approveWorkflowReview,
  createWorkflowReviewFromDraft,
  rejectWorkflowReview,
} from "../workspace/reviews.js";

/**
 * Route a POST action request. `actionPath` is the path after `/clawforce/api/:domain/`.
 * e.g., "approvals/p1/approve", "tasks/t1/reassign", "agents/a1/disable"
 */
export function handleAction(
  projectId: string,
  actionPath: string,
  body: Record<string, unknown>,
): RouteResult {
  const segments = actionPath.split("/").filter(Boolean);

  if (segments.length === 1) {
    return handleDomainAction(projectId, segments[0]!, body);
  }

  if (segments.length < 2) {
    return notFound(`Unknown action: ${actionPath}`);
  }

  const resource = segments[0]!;

  switch (resource) {
    case "approvals":
      return handleApprovalAction(projectId, segments, body);
    case "tasks":
      return handleTaskAction(projectId, segments, body);
    case "agents":
      return handleAgentAction(projectId, segments, body);
    case "meetings":
      return handleMeetingAction(projectId, segments, body);
    case "messages":
      return handleMessageAction(projectId, segments, body);
    case "events":
      return handleEventsAction(projectId, segments, body);
    case "config":
      return handleConfigAction(projectId, segments, body);
    case "budget":
      return handleBudgetAction(projectId, segments, body);
    case "interventions":
      return handleInterventionAction(projectId, segments, body);
    case "locks":
      return handleLockAction(projectId, segments, body);
    case "history":
      return handleHistoryAction(projectId, segments, body);
    case "setup":
      return handleSetupAction(projectId, segments, body);
    case "workspace":
      return handleWorkspaceAction(projectId, segments, body);
    case "workflow-reviews":
      return handleWorkflowReviewAction(projectId, segments, body);
    default:
      return notFound(`Unknown action resource: ${resource}`);
  }
}

function handleWorkspaceAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  if (segments[1] !== "drafts") {
    return notFound(`Unknown workspace action: ${segments.slice(1).join("/")}`);
  }

  const draftSessionId = segments[2];
  const action = segments[3];
  if (!draftSessionId || !action) {
    return notFound("draftSessionId and action required");
  }

  if (action === "visibility") {
    return handleDraftVisibility(projectId, draftSessionId, body);
  }
  if (action === "confirm") {
    return handleDraftConfirm(projectId, draftSessionId, body);
  }
  return notFound(`Unknown workspace draft action: ${action}`);
}

function handleDraftVisibility(
  projectId: string,
  draftSessionId: string,
  body: Record<string, unknown>,
): RouteResult {
  const overlayVisibility = body.overlayVisibility;
  if (overlayVisibility !== "visible" && overlayVisibility !== "hidden") {
    return badRequest("overlayVisibility must be 'visible' or 'hidden'");
  }

  const actor = (body.actor as string) ?? "dashboard";
  const draftSession = setWorkflowDraftSessionVisibility(
    projectId,
    draftSessionId,
    overlayVisibility,
    actor,
  );
  if (!draftSession) {
    return notFound("Workflow draft session not found");
  }

  emitSSE(projectId, "workspace:draft", {
    draftSessionId,
    workflowId: draftSession.workflowId,
    overlayVisibility: draftSession.overlayVisibility,
  });

  return ok({
    ok: true,
    draftSessionId,
    workflowId: draftSession.workflowId,
    overlayVisibility: draftSession.overlayVisibility,
  });
}

/**
 * Confirm a draft session into a pending workflow review. Idempotent: if a
 * pending review already exists for this draft, the same review is returned
 * with `created: false` instead of creating a second one.
 */
function handleDraftConfirm(
  projectId: string,
  draftSessionId: string,
  body: Record<string, unknown>,
): RouteResult {
  const actor = (body.actor as string) ?? "dashboard";
  const title = typeof body.title === "string" ? body.title : undefined;
  const summary = typeof body.summary === "string" ? body.summary : undefined;

  const result = createWorkflowReviewFromDraft({
    projectId,
    draftSessionId,
    confirmedBy: actor,
    title,
    summary,
  });
  if (!result.ok) {
    if (result.reason === "draft_not_found") {
      return notFound("Workflow draft session not found");
    }
    // Terminal draft — approved/applied drafts cannot be reopened into
    // a new review. Surface as 409 so the UI can sync its state.
    return {
      status: 409,
      body: {
        error: "Draft session is terminal — it has already been ratified and cannot be reconfirmed",
        currentStatus: result.currentStatus,
      },
    };
  }

  emitSSE(projectId, "workspace:review", {
    reviewId: result.record.id,
    workflowId: result.record.workflowId,
    draftSessionId: result.record.draftSessionId,
    status: result.record.status,
    created: result.created,
  });

  return ok({
    ok: true,
    created: result.created,
    reviewId: result.record.id,
    workflowId: result.record.workflowId,
    draftSessionId: result.record.draftSessionId,
    status: result.record.status,
  });
}

/**
 * Resolve a workflow review via approve / reject. Returns 404 for a missing
 * review, 409 when the review is not in a pending state (already resolved).
 */
function handleWorkflowReviewAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  const reviewId = segments[1];
  const action = segments[2];
  if (!reviewId || !action) {
    return notFound("reviewId and action required");
  }
  if (action !== "approve" && action !== "reject") {
    return notFound(`Unknown workflow-review action: ${action}`);
  }

  const actor = (body.actor as string) ?? "dashboard";
  const decisionNotes = typeof body.decisionNotes === "string"
    ? body.decisionNotes
    : typeof body.feedback === "string"
      ? body.feedback
      : undefined;

  const result = action === "approve"
    ? approveWorkflowReview({ projectId, reviewId, actor, decisionNotes })
    : rejectWorkflowReview({ projectId, reviewId, actor, decisionNotes });

  if (!result.ok) {
    if (result.reason === "not_found") {
      return notFound("Workflow review not found");
    }
    // not_pending → already resolved; surface as 409 so the UI can sync state.
    return {
      status: 409,
      body: {
        error: "Workflow review is not pending",
        currentStatus: result.currentStatus,
      },
    };
  }

  emitSSE(projectId, "workspace:review", {
    reviewId: result.record.id,
    workflowId: result.record.workflowId,
    draftSessionId: result.record.draftSessionId,
    status: result.record.status,
    resolvedBy: result.record.resolvedBy,
  });

  return ok({
    ok: true,
    reviewId: result.record.id,
    workflowId: result.record.workflowId,
    draftSessionId: result.record.draftSessionId,
    status: result.record.status,
    resolvedBy: result.record.resolvedBy,
    decisionNotes: result.record.decisionNotes,
    resolvedAt: result.record.resolvedAt,
  });
}

function handleDomainAction(
  projectId: string,
  action: string,
  body: Record<string, unknown>,
): RouteResult {
  const actor = (body.actor as string) ?? "dashboard";

  switch (action) {
    case "disable": {
      const result = runDisableDomainCommand(projectId, {
        actor,
        reason: body.reason as string | undefined,
      });
      emitSSE(projectId, "domain:status", {
        status: "disabled",
        reason: result.reason,
        emergencyStop: result.emergencyStop,
      });
      return ok(result);
    }

    case "enable": {
      const result = runEnableDomainCommand(projectId, { actor });
      emitSSE(projectId, "domain:status", {
        status: "enabled",
        clearedEmergencyStop: result.clearedEmergencyStop,
      });
      return ok(result);
    }

    case "kill": {
      let preActionId: string | undefined;
      try {
        const db = getDb(projectId);
        preActionId = createActionRecord(projectId, "domain_kill", actor, undefined, db);
      } catch { /* non-fatal — proceed without pre-created record */ }

      void handleDomainKillAction(projectId, body, preActionId).catch((err) => {
        safeLog("dashboard.actions.domainKill", err);
      });
      const statusUrl = preActionId ? `/clawforce/api/${projectId}/actions/${preActionId}` : undefined;
      return {
        status: 202,
        body: {
          ok: true,
          action: {
            actionId: preActionId,
            state: "accepted",
            actionType: "domain_kill",
            statusUrl,
          },
          queued: true,
          domainEnabled: false,
          emergencyStop: true,
        },
      };
    }

    default:
      return notFound(`Unknown domain action: ${action}`);
  }
}

export async function handleAgentKillAction(
  projectId: string,
  agentId: string,
  body: Record<string, unknown>,
  existingActionId?: string,
): Promise<RouteResult> {
  if (!isKnownProjectAgent(projectId, agentId)) {
    return notFound(`Agent "${agentId}" is not registered in project "${projectId}".`);
  }

  const actor = (body.actor as string) ?? "dashboard";
  const reason = (body.reason as string) ?? "Killed via dashboard";

  let actionId: string | undefined = existingActionId;
  let killedSessions: number;

  try {
    const tracked = await withActionTracking(
      projectId,
      "agent_kill",
      actor,
      () => runKillAgentCommand(projectId, agentId, body),
      undefined,
      existingActionId,
    );
    actionId = tracked.actionId;
    killedSessions = tracked.result.killedSessions;

    emitSSE(projectId, "action_status", {
      actionId,
      state: "completed",
      actionType: "agent_kill",
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    safeLog("dashboard.actions.agentKill", err);

    // SSE with failed status — actionId may be undefined if tracking setup itself failed
    if (actionId) {
      emitSSE(projectId, "action_status", {
        actionId,
        state: "failed",
        actionType: "agent_kill",
        error: errMsg,
      });
    }
    return { status: 500, body: { error: errMsg } };
  }

  emitSSE(projectId, "agent:status", { agentId, status: "killed", killedSessions, reason });
  return ok({
    ok: true,
    agentId,
    killedSessions,
    reason,
    actionId,
  });
}

export async function handleDomainKillAction(
  projectId: string,
  body: Record<string, unknown>,
  existingActionId?: string,
): Promise<RouteResult> {
  const actor = (body.actor as string) ?? "dashboard";

  let actionId: string | undefined = existingActionId;
  let resultBody: Awaited<ReturnType<typeof runDomainKillCommand>>;

  try {
    const tracked = await withActionTracking(
      projectId,
      "domain_kill",
      actor,
      () => runDomainKillCommand(projectId, {
        actor,
        reason: body.reason as string | undefined,
      }),
      undefined,
      existingActionId,
    );
    actionId = tracked.actionId;
    resultBody = tracked.result;

    emitSSE(projectId, "action_status", {
      actionId,
      state: "completed",
      actionType: "domain_kill",
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    safeLog("dashboard.actions.domainKill", err);

    if (actionId) {
      emitSSE(projectId, "action_status", {
        actionId,
        state: "failed",
        actionType: "domain_kill",
        error: errMsg,
      });
    }
    return { status: 500, body: { error: errMsg } };
  }

  emitSSE(projectId, "domain:status", {
    status: "killed",
    reason: resultBody.reason,
    emergencyStop: resultBody.emergencyStop,
    cancelledDispatches: resultBody.cancelledDispatches,
    killedSessions: resultBody.killedSessions,
  });

  return ok({ ...resultBody, actionId });
}

function handleApprovalAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  // approvals/:id/approve or approvals/:id/reject
  if (segments.length < 3) return notFound("Missing approval action");

  const proposalId = segments[1]!;
  const action = segments[2]!;
  const feedback = body.feedback as string | undefined;

  if (action !== "approve" && action !== "reject") {
    return notFound(`Unknown approval action: ${action}`);
  }

  const result = runResolveApprovalCommand(projectId, proposalId, action, feedback);
  if (result.resolution) {
    emitSSE(projectId, "approval:resolved", { proposalId, status: result.resolution });
  }
  return { status: result.status, body: result.body };
}

function handleTaskAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  // tasks/create
  if (segments[1] === "create") {
    const result = runCreateTaskCommand(projectId, body);
    if (result.sse) emitSSE(projectId, result.sse.event, result.sse.payload);
    return { status: result.status, body: result.body };
  }

  // tasks/:id/reassign or tasks/:id/transition
  if (segments.length < 3) return notFound("Missing task action");

  const taskId = segments[1]!;
  const action = segments[2]!;

  switch (action) {
    case "reassign": {
      const result = runReassignTaskCommand(projectId, taskId, body);
      if (result.sse) emitSSE(projectId, result.sse.event, result.sse.payload);
      return { status: result.status, body: result.body };
    }
    case "transition": {
      const result = runTransitionTaskCommand(projectId, taskId, body);
      if (result.sse) emitSSE(projectId, result.sse.event, result.sse.payload);
      return { status: result.status, body: result.body };
    }
    case "evidence": {
      const result = runAttachTaskEvidenceCommand(projectId, taskId, body);
      if (result.sse) emitSSE(projectId, result.sse.event, result.sse.payload);
      return { status: result.status, body: result.body };
    }
    default:
      return notFound(`Unknown task action: ${action}`);
  }
}

function handleAgentAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  // agents/:id/disable, agents/:id/enable, agents/:id/message, agents/:id/kill
  if (segments.length < 3) return notFound("Missing agent action");

  const agentId = segments[1]!;
  const action = segments[2]!;

  // Validate agent exists when agents are registered (lenient for test environments)
  if (action === "disable" || action === "enable" || action === "message" || action === "kill") {
    if (!isKnownProjectAgent(projectId, agentId)) {
      return notFound(`Agent "${agentId}" is not registered in project "${projectId}".`);
    }
  }

  switch (action) {
    case "disable": {
      const result = runDisableAgentCommand(projectId, agentId, body);
      if (result.sse) emitSSE(projectId, result.sse.event, result.sse.payload);
      return { status: result.status, body: result.body };
    }
    case "enable": {
      const result = runEnableAgentCommand(projectId, agentId, body);
      if (result.sse) emitSSE(projectId, result.sse.event, result.sse.payload);
      return { status: result.status, body: result.body };
    }
    case "message": {
      const content = (body.content as string) ?? (body.message as string);
      return handleMessageAction(projectId, ["messages", "send"], {
        ...body,
        to: agentId,
        content,
      });
    }
    case "kill": {
      let preAgentActionId: string | undefined;
      try {
        const db = getDb(projectId);
        preAgentActionId = createActionRecord(projectId, "agent_kill", (body.actor as string) ?? "dashboard", undefined, db);
      } catch { /* non-fatal — proceed without pre-created record */ }

      void handleAgentKillAction(projectId, agentId, body, preAgentActionId).catch((err) => {
        safeLog("dashboard.actions.agentKill", err);
      });
      const agentStatusUrl = preAgentActionId ? `/clawforce/api/${projectId}/actions/${preAgentActionId}` : undefined;
      return {
        status: 202,
        body: {
          ok: true,
          action: {
            actionId: preAgentActionId,
            state: "accepted",
            actionType: "agent_kill",
            statusUrl: agentStatusUrl,
          },
          queued: true,
          agentId,
        },
      };
    }
    default:
      return notFound(`Unknown agent action: ${action}`);
  }
}

function handleMeetingAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  // meetings/create
  if (segments[1] === "create") {
    const result = runCreateMeetingCommand(projectId, body);
    if (result.sse) emitSSE(projectId, result.sse.event, result.sse.payload);
    return { status: result.status, body: result.body };
  }

  // meetings/:id/message or meetings/:id/end
  if (segments.length < 3) return notFound("Missing meeting action");

  const channelId = segments[1]!;
  const action = segments[2]!;

  switch (action) {
    case "message": {
      const result = runSendMeetingMessageCommand(projectId, channelId, body);
      if (result.sse) emitSSE(projectId, result.sse.event, result.sse.payload);
      return { status: result.status, body: result.body };
    }
    case "end": {
      const result = runEndMeetingCommand(projectId, channelId, body);
      if (result.sse) emitSSE(projectId, result.sse.event, result.sse.payload);
      return { status: result.status, body: result.body };
    }
    default:
      return notFound(`Unknown meeting action: ${action}`);
  }
}

function handleMessageAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  // POST /messages/send — user sends a direct message to an agent
  if (segments[1] === "send") {
    const result = runSendDirectMessageCommand(projectId, {
      toAgent: body.to as string | undefined,
      content: body.content as string | undefined,
      priority: body.priority as "normal" | "high" | "urgent" | undefined,
      proposalId: body.proposalId as string | undefined,
      taskId: body.taskId as string | undefined,
      entityId: body.entityId as string | undefined,
      issueId: body.issueId as string | undefined,
    });
    if (!result.ok) return badRequest(result.error);
    return { status: result.status, body: result.message };
  }

  // messages/:threadId/send — existing channel message pattern
  if (segments.length < 3) return notFound("Missing message action");

  const threadId = segments[1]!;
  const action = segments[2]!;

  switch (action) {
    case "send": {
      const result = runSendThreadMessageCommand(projectId, threadId, body);
      if (result.sse) emitSSE(projectId, result.sse.event, result.sse.payload);
      return { status: result.status, body: result.body };
    }
    default:
      return notFound(`Unknown message action: ${action}`);
  }
}

function handleConfigAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  const action = segments[1];
  switch (action) {
    case "save": {
      const section = body.section as string;
      if (!section) return badRequest("section is required");
      const actor = (body.actor as string) ?? "dashboard";

      // Check if this config surface is locked before persisting
      {
        // Map config sections to lock surfaces
        const lockSurfaceMap: Record<string, string> = {
          agents: "agent-enabled",
          budget: "budget",
          jobs: "jobs",
          tool_gates: "tool-gates",
          rules: "rules",
        };
        const lockSurface = lockSurfaceMap[section] ?? section;
        try {
          const lockCheck = checkLock(projectId, lockSurface, actor);
          if (lockCheck.locked && lockCheck.entry) {
            // Audit the blocked mutation
            try {
              writeAuditEntry({
                projectId,
                actor,
                action: "lock_blocked_mutation",
                targetType: "lock",
                targetId: lockSurface,
                detail: JSON.stringify({
                  surface: lockSurface,
                  blockedActor: actor,
                  lockedBy: lockCheck.entry.lockedBy,
                  reason: lockCheck.entry.reason,
                }),
              });
            } catch { /* non-fatal */ }
            return {
              status: 409,
              body: {
                ok: false,
                error: "LOCKED_BY_HUMAN",
                lock: {
                  surface: lockSurface,
                  lockedBy: lockCheck.entry.lockedBy,
                  lockedAt: lockCheck.entry.lockedAt,
                  reason: lockCheck.entry.reason,
                },
              },
            };
          }
          // Apply override policy (for manual_changes_lock, auto-create/refresh the lock)
          applyOverridePolicy(projectId, lockSurface, actor);
        } catch { /* non-fatal — lock check failure should not block saves */ }
      }

      // Persist the config change via the config API service
      try {
        let actionId: string | undefined;
        let result: ReturnType<typeof runSaveConfigCommand>;
        try {
          const tracked = withActionTrackingSync(
            projectId,
            `config_save:${section}`,
            actor,
            () => runSaveConfigCommand(projectId, {
              section,
              data: body.data,
              actor,
            }),
          );
          actionId = tracked.actionId;
          result = tracked.result;
        } catch (err) {
          return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
        }

        if (!result.ok) {
          return { status: 400, body: { error: result.error } };
        }

        emitSSE(projectId, "action_status", { actionId, state: "completed", actionType: `config_save:${section}` });
        emitSSE(projectId, "config:changed", { section });
        try {
          ingestEvent(projectId, "config_updated", "internal", {
            section,
            actor,
          }, `config-updated:${section}:${Date.now()}`);
        } catch { /* non-fatal */ }
        try {
          const provenance: ChangeProvenance = actor === "dashboard" || actor === "system" ? "human" : "human";
          if (result.change) {
            recordChange(projectId, {
              resourceType: "config",
              resourceId: result.change.resourceId,
              action: "update",
              provenance,
              actor,
              before: result.change.before,
              after: result.change.after,
              reversible: result.change.reversible,
            });
          }
        } catch { /* non-fatal */ }
        return ok({
          ok: true,
          section,
          actionId,
          ...(result.warnings ? { warnings: result.warnings } : {}),
          ...(result.reloadErrors ? { reloadErrors: result.reloadErrors } : {}),
          ...(result.runtimeReload ? { runtimeReload: result.runtimeReload } : {}),
        });
      } catch (err) {
        return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    }
    case "validate": {
      const section = body.section as string;
      if (!section) return badRequest("section is required");
      const validationData = body.data;
      const { errors, warnings } = validateConfigSection(section, validationData, projectId);
      return ok({ valid: errors.length === 0, section, errors, warnings });
    }
    case "preview": {
      const section = typeof body.section === "string" ? body.section : undefined;
      const proposed = body.proposed ?? body.data;
      if (section) {
        const preview = previewSaveConfigCommand(projectId, {
          section,
          data: proposed,
          actor: typeof body.actor === "string" ? body.actor : undefined,
        });
        if (!preview.ok) {
          return { status: preview.status, body: { error: preview.error } };
        }
        return ok(buildConfigPreviewResponse(
          preview.changedKeys,
          preview.valid,
          preview.errors,
        ));
      }

      const current = body.current;
      // Return a diff summary matching ConfigChangePreview type
      const changes: string[] = [];
      if (current && proposed && typeof current === "object" && typeof proposed === "object") {
        const currentKeys = Object.keys(current as Record<string, unknown>);
        const proposedKeys = Object.keys(proposed as Record<string, unknown>);
        const allKeys = new Set([...currentKeys, ...proposedKeys]);
        for (const key of allKeys) {
          const cVal = (current as Record<string, unknown>)[key];
          const pVal = (proposed as Record<string, unknown>)[key];
          if (JSON.stringify(cVal) !== JSON.stringify(pVal)) {
            changes.push(key);
          }
        }
      }
      return ok(buildConfigPreviewResponse(changes, true));
    }
    default:
      return notFound(`Unknown config action: ${action}`);
  }
}

function handleBudgetAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  const action = segments[1];
  switch (action) {
    case "allocate": {
      const result = runAllocateBudgetCommand(projectId, body);
      if (!result.ok) {
        emitSSE(projectId, "action_status", {
          actionId: result.actionId,
          state: "failed",
          actionType: "budget_allocate",
          error: result.error,
        });
        return { status: result.status, body: { ok: false, error: result.error } };
      }

      emitSSE(projectId, "action_status", {
        actionId: result.actionId,
        state: "completed",
        actionType: "budget_allocate",
      });

      emitSSE(projectId, "budget:update", {
        parentAgentId: result.parentAgentId,
        childAgentId: result.childAgentId,
        allocationConfig: result.allocationConfig,
      });

      return ok({
        ok: true,
        parentAgentId: result.parentAgentId,
        childAgentId: result.childAgentId,
        allocationConfig: result.allocationConfig,
        actionId: result.actionId,
      });
    }
    default:
      return notFound(`Unknown budget action: ${action}`);
  }
}

function handleEventsAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  const action = segments[1];

  switch (action) {
    case "ingest": {
      const result = runIngestProjectEventCommand(projectId, body);
      return { status: result.status, body: result.body };
    }
    default:
      return notFound(`Unknown events action: ${action}`);
  }
}

/**
 * Handle POST /clawforce/api/demo/create
 * Creates a demo domain with the full-org example config.
 */
export function handleDemoCreate(): RouteResult {
  const result = runCreateDemoDomainCommand();
  if (!result.ok) {
    return { status: result.status, body: { error: result.error } };
  }

  return {
    status: result.status,
    body: {
      domainId: result.domainId,
      message: result.message,
      reloadErrors: result.reloadErrors,
    },
  };
}

/**
 * Handle POST /clawforce/api/domains/create
 * Creates a minimal starter domain for either a fresh workforce or an existing governed team.
 */
export function handleStarterDomainCreate(body: Record<string, unknown>): RouteResult {
  const actor = (body.actor as string) ?? "dashboard";
  const result = runCreateStarterDomainCommand(body, actor);
  if (!result.ok) {
    return { status: result.status, body: { error: result.error } };
  }

  return {
    status: result.status,
    body: {
      ok: true,
      domainId: result.domainId,
      mode: result.mode,
      createdAgentIds: result.createdAgentIds,
      reusedAgentIds: result.reusedAgentIds,
      message: result.message,
      reloadErrors: result.reloadErrors,
    },
  };
}

// --- Intervention Actions ---

function handleInterventionAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  // interventions/dismiss
  const action = segments[1];

  switch (action) {
    case "dismiss": {
      const result = runDismissInterventionCommand(projectId, body);
      return { status: result.status, body: result.body };
    }
    default:
      return notFound(`Unknown intervention action: ${action}`);
  }
}

function handleLockAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  const action = segments[1];
  const actor = (body.actor as string) ?? "dashboard";

  switch (action) {
    case "acquire": {
      const surface = body.surface as string;
      if (!surface) return badRequest("surface is required");
      const result = runAcquireLockCommand(projectId, surface, actor, body.reason as string | undefined);
      if (!result.ok) {
        return { status: result.status, body: { ok: false, error: result.error } };
      }
      emitSSE(projectId, "locks:changed", { surface, event: "acquired", lockedBy: actor });
      return { status: result.status, body: { ok: true, lock: result.lock } };
    }
    case "release": {
      const surface = body.surface as string;
      if (!surface) return badRequest("surface is required");
      const result = runReleaseLockCommand(projectId, surface, actor);
      if (!result.ok) {
        return { status: result.status, body: { ok: false, error: result.error } };
      }
      emitSSE(projectId, "locks:changed", { surface, event: "released", releasedBy: actor });
      return ok({ ok: true, surface: result.surface });
    }
    default:
      return notFound(`Unknown lock action: ${action}`);
  }
}

function handleHistoryAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  // history/:changeId/revert
  if (segments.length >= 3 && segments[2] === "revert") {
    const changeId = segments[1]!;
    const actor = (body.actor as string) ?? "dashboard";
    const result = runRevertHistoryChangeCommand(projectId, changeId, actor);
    if (!result.ok) {
      return { status: result.status, body: { ok: false, error: result.error } };
    }

    return ok({
      ok: true,
      changeId: result.changeId,
      revertChangeId: result.revertChangeId,
      applied: result.applied,
      ...(result.applyReason ? { applyReason: result.applyReason } : {}),
    });
  }

  return notFound(`Unknown history action: ${segments.join("/")}`);
}

function handleSetupAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  if (segments[1] === "controller" && segments[2] === "handoff") {
    const result = runRequestControllerHandoffCommand(projectId, body);
    return { status: result.status, body: result.body };
  }

  if (segments[1] === "recurring" && segments[3] === "recover") {
    const taskId = segments[2];
    if (!taskId) {
      return badRequest("taskId is required");
    }
    const result = runRecoverRecurringRunCommand(projectId, taskId, body);
    return { status: result.status, body: result.body };
  }

  return notFound(`Unknown setup action: ${segments.join("/")}`);
}

// --- Helpers ---

function ok(body: unknown): RouteResult {
  return { status: 200, body };
}

function notFound(message: string): RouteResult {
  return { status: 404, body: { error: message } };
}

function badRequest(message: string): RouteResult {
  return { status: 400, body: { error: message } };
}
