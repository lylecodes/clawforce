/**
 * Clawforce — Dashboard action handlers
 *
 * REST POST action handlers: approve, reject, reassign, create task,
 * disable/enable agent, message agent, meeting create/message/end, etc.
 * Each action is a thin wrapper around existing core functions.
 */

import type { RouteResult } from "./routes.js";
import { approveProposal, rejectProposal } from "../approval/resolve.js";
import { attachEvidence, createTask, reassignTask, transitionTask } from "../tasks/ops.js";
import {
  disableAgent,
  enableAgent,
  disableDomain,
  enableDomain,
  isDomainDisabled,
} from "../enforcement/disabled-store.js";
import { startMeeting, concludeMeeting } from "../channels/meeting.js";
import { sendChannelMessage } from "../channels/messages.js";
import { createMessage } from "../messaging/store.js";
import { emitSSE } from "./sse.js";
import { EVENT_ACTION_TYPES, type EvidenceType, TaskPriority, type TaskState } from "../types.js";
import { ingestEvent } from "../events/store.js";
import { createDemoConfig } from "./demo.js";
import { createGoal } from "../goals/ops.js";
import { getDb } from "../db.js";
import { getRegisteredAgentIds, getAgentConfig, getExtendedProjectConfig } from "../project.js";
import { writeAuditEntry } from "../audit.js";
import { activateEmergencyStop, deactivateEmergencyStop, isEmergencyStopActive } from "../safety.js";
import { killStuckAgent } from "../audit/auto-kill.js";
import { allocateBudget, type BudgetAllocation } from "../budget-cascade.js";
import { normalizeBudgetConfig } from "../budget/normalize.js";
import {
  updateDomainConfig as updateDomainConfigViaService,
  updateGlobalAgentConfig,
  upsertGlobalAgents,
  writeDomainConfig,
  reloadAllDomains,
  readDomainConfig as readDomainConfigViaService,
  readGlobalConfig as readGlobalConfigViaService,
} from "../config/api-service.js";
import { safeLog } from "../diagnostics.js";
import type { DomainConfig, GlobalAgentDef } from "../config/schema.js";
import { validateRuleDefinition } from "../config/schema.js";

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
    default:
      return notFound(`Unknown action resource: ${resource}`);
  }
}

function handleDomainAction(
  projectId: string,
  action: string,
  body: Record<string, unknown>,
): RouteResult {
  const actor = (body.actor as string) ?? "dashboard";

  switch (action) {
    case "disable": {
      const reason = (body.reason as string) ?? "Disabled via dashboard";
      disableDomain(projectId, reason, actor);
      emitSSE(projectId, "domain:status", {
        status: "disabled",
        reason,
        emergencyStop: isEmergencyStopActive(projectId),
      });
      try {
        writeAuditEntry({
          projectId,
          actor,
          action: "disable_domain",
          targetType: "domain",
          targetId: projectId,
          detail: reason,
        });
      } catch { /* non-fatal */ }
      return ok({
        ok: true,
        domainEnabled: false,
        emergencyStop: isEmergencyStopActive(projectId),
        reason,
      });
    }

    case "enable": {
      const hadEmergencyStop = isEmergencyStopActive(projectId);
      const wasDisabled = isDomainDisabled(projectId);

      if (hadEmergencyStop) {
        deactivateEmergencyStop(projectId);
        try {
          writeAuditEntry({
            projectId,
            actor,
            action: "emergency_resume",
            targetType: "domain",
            targetId: projectId,
          });
        } catch { /* non-fatal */ }
      }

      if (wasDisabled) {
        enableDomain(projectId);
        try {
          writeAuditEntry({
            projectId,
            actor,
            action: "enable_domain",
            targetType: "domain",
            targetId: projectId,
          });
        } catch { /* non-fatal */ }
      }

      emitSSE(projectId, "domain:status", {
        status: "enabled",
        clearedEmergencyStop: hadEmergencyStop,
      });
      return ok({
        ok: true,
        domainEnabled: true,
        emergencyStop: false,
        clearedEmergencyStop: hadEmergencyStop,
        resumed: wasDisabled || hadEmergencyStop,
      });
    }

    case "kill":
      void handleDomainKillAction(projectId, body).catch((err) => {
        safeLog("dashboard.actions.domainKill", err);
      });
      return {
        status: 202,
        body: {
          ok: true,
          queued: true,
          domainEnabled: false,
          emergencyStop: true,
        },
      };

    default:
      return notFound(`Unknown domain action: ${action}`);
  }
}

function getProjectAgentIds(projectId: string): string[] {
  try {
    return getRegisteredAgentIds().filter((agentId) => {
      const entry = getAgentConfig(agentId);
      return entry?.projectId === projectId;
    });
  } catch {
    return [];
  }
}

function isKnownProjectAgent(projectId: string, agentId: string): boolean {
  const projectAgentIds = getProjectAgentIds(projectId);
  return projectAgentIds.length === 0 || projectAgentIds.includes(agentId);
}

function cancelQueuedDispatches(projectId: string, reason: string): number {
  try {
    const db = getDb(projectId);
    const result = db.prepare(
      "UPDATE dispatch_queue SET status = 'cancelled', last_error = ?, completed_at = ? WHERE project_id = ? AND status IN ('queued', 'leased')",
    ).run(reason, Date.now(), projectId) as { changes?: number };
    return result.changes ?? 0;
  } catch {
    return 0;
  }
}

async function killAgentSessions(projectId: string, agentId: string, reason: string): Promise<number> {
  let killedSessions = 0;
  for (const kind of ["main", "cron"] as const) {
    const killed = await killStuckAgent({
      projectId,
      agentId,
      sessionKey: `agent:${agentId}:${kind}`,
      reason,
    });
    if (killed) killedSessions++;
  }
  return killedSessions;
}

export async function handleAgentKillAction(
  projectId: string,
  agentId: string,
  body: Record<string, unknown>,
): Promise<RouteResult> {
  if (!isKnownProjectAgent(projectId, agentId)) {
    return notFound(`Agent "${agentId}" is not registered in project "${projectId}".`);
  }

  const actor = (body.actor as string) ?? "dashboard";
  const reason = (body.reason as string) ?? "Killed via dashboard";
  const killedSessions = await killAgentSessions(projectId, agentId, reason);

  emitSSE(projectId, "agent:status", { agentId, status: "killed", killedSessions, reason });
  try {
    writeAuditEntry({
      projectId,
      actor,
      action: "kill_agent",
      targetType: "agent",
      targetId: agentId,
      detail: JSON.stringify({ reason, killedSessions }),
    });
  } catch { /* non-fatal */ }

  return ok({
    ok: true,
    agentId,
    killedSessions,
    reason,
  });
}

export async function handleDomainKillAction(
  projectId: string,
  body: Record<string, unknown>,
): Promise<RouteResult> {
  const actor = (body.actor as string) ?? "dashboard";
  const rawReason = (body.reason as string) ?? "Emergency stop via dashboard";
  const reason = rawReason.startsWith("EMERGENCY:") ? rawReason : `EMERGENCY: ${rawReason}`;

  disableDomain(projectId, reason, actor);
  activateEmergencyStop(projectId);
  const cancelledDispatches = cancelQueuedDispatches(projectId, reason);

  let killedSessions = 0;
  for (const agentId of getProjectAgentIds(projectId)) {
    killedSessions += await killAgentSessions(projectId, agentId, reason);
  }

  emitSSE(projectId, "domain:status", {
    status: "killed",
    reason,
    emergencyStop: true,
    cancelledDispatches,
    killedSessions,
  });

  try {
    writeAuditEntry({
      projectId,
      actor,
      action: "disable_domain",
      targetType: "domain",
      targetId: projectId,
      detail: reason,
    });
    writeAuditEntry({
      projectId,
      actor,
      action: "emergency_stop",
      targetType: "domain",
      targetId: projectId,
      detail: JSON.stringify({ reason, cancelledDispatches, killedSessions }),
    });
  } catch { /* non-fatal */ }

  return ok({
    ok: true,
    domainEnabled: false,
    emergencyStop: true,
    reason,
    cancelledDispatches,
    killedSessions,
  });
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

  switch (action) {
    case "approve": {
      const result = approveProposal(projectId, proposalId, feedback);
      if (!result) return notFound(`Proposal ${proposalId} not found or already resolved`);
      emitSSE(projectId, "approval:resolved", { proposalId, status: "approved" });
      return ok(result);
    }
    case "reject": {
      const result = rejectProposal(projectId, proposalId, feedback);
      if (!result) return notFound(`Proposal ${proposalId} not found or already resolved`);
      emitSSE(projectId, "approval:resolved", { proposalId, status: "rejected" });
      return ok(result);
    }
    default:
      return notFound(`Unknown approval action: ${action}`);
  }
}

function handleTaskAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  // tasks/create
  if (segments[1] === "create") {
    const title = body.title as string;
    if (!title) return badRequest("title is required");

    const task = createTask({
      projectId,
      title,
      description: body.description as string | undefined,
      priority: body.priority as TaskPriority | undefined,
      assignedTo: body.assignedTo as string | undefined,
      createdBy: (body.createdBy as string) ?? "dashboard",
      deadline: body.deadline as number | undefined,
      tags: body.tags as string[] | undefined,
      department: body.department as string | undefined,
      team: body.team as string | undefined,
      goalId: body.goalId as string | undefined,
    });
    emitSSE(projectId, "task:update", { taskId: task.id, action: "created" });
    return { status: 201, body: task };
  }

  // tasks/:id/reassign or tasks/:id/transition
  if (segments.length < 3) return notFound("Missing task action");

  const taskId = segments[1]!;
  const action = segments[2]!;

  switch (action) {
    case "reassign": {
      const newAssignee = body.newAssignee as string;
      if (!newAssignee) return badRequest("newAssignee is required");

      const result = reassignTask({
        projectId,
        taskId,
        newAssignee,
        actor: (body.actor as string) ?? "dashboard",
        reason: body.reason as string | undefined,
      });
      if (!result.ok) return { status: 400, body: { error: result.reason } };
      emitSSE(projectId, "task:update", { taskId, action: "reassigned", newAssignee });
      return ok(result);
    }
    case "transition": {
      const toState = body.toState as TaskState;
      if (!toState) return badRequest("toState is required");

      const result = transitionTask({
        projectId,
        taskId,
        toState,
        actor: (body.actor as string) ?? "dashboard",
        reason: body.reason as string | undefined,
      });
      if (!result.ok) return { status: 400, body: { error: result.reason } };
      emitSSE(projectId, "task:update", { taskId, action: "transitioned", toState });
      return ok(result);
    }
    case "evidence": {
      const content = body.content as string;
      if (!content) return badRequest("content is required");

      const evidence = attachEvidence({
        projectId,
        taskId,
        type: (body.type as EvidenceType) ?? "custom",
        content,
        attachedBy: (body.attachedBy as string) ?? "dashboard",
        metadata: body.metadata as Record<string, unknown> | undefined,
      });
      emitSSE(projectId, "task:update", { taskId, action: "evidence_attached", evidenceId: evidence.id });
      return { status: 201, body: { ok: true, evidence: { id: evidence.id, content: evidence.content, type: evidence.type } } };
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
      const reason = (body.reason as string) ?? "Disabled via dashboard";
      disableAgent(projectId, agentId, reason);
      emitSSE(projectId, "agent:status", { agentId, status: "disabled", reason });
      try {
        ingestEvent(projectId, "agent_disabled", "internal", {
          agentId,
          reason,
          actor: (body.actor as string) ?? "dashboard",
        }, `agent-disabled:${agentId}:${Date.now()}`);
      } catch { /* non-fatal */ }
      return ok({ agentId, status: "disabled" });
    }
    case "enable": {
      enableAgent(projectId, agentId);
      emitSSE(projectId, "agent:status", { agentId, status: "idle" });
      try {
        ingestEvent(projectId, "agent_enabled", "internal", {
          agentId,
          actor: (body.actor as string) ?? "dashboard",
        }, `agent-enabled:${agentId}:${Date.now()}`);
      } catch { /* non-fatal */ }
      return ok({ agentId, status: "enabled" });
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
      void handleAgentKillAction(projectId, agentId, body).catch((err) => {
        safeLog("dashboard.actions.agentKill", err);
      });
      return {
        status: 202,
        body: {
          ok: true,
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
    const participants = body.participants as string[];
    if (!participants || !Array.isArray(participants) || participants.length === 0) {
      return badRequest("participants array is required");
    }

    // Validate participants exist when agents are registered (lenient for test environments)
    try {
      const allAgentIds = getRegisteredAgentIds();
      const projectAgentIds = allAgentIds.filter((id) => {
        const entry = getAgentConfig(id);
        return entry?.projectId === projectId;
      });
      if (projectAgentIds.length > 0) {
        const invalid = participants.filter((p) => !projectAgentIds.includes(p));
        if (invalid.length > 0) {
          return badRequest(`Invalid participant(s): ${invalid.join(", ")}. These agents are not registered in project "${projectId}".`);
        }
      }
    } catch {
      // If project module is unavailable, skip validation
    }

    try {
      const result = startMeeting({
        projectId,
        channelName: body.channelName as string | undefined,
        participants,
        prompt: body.prompt as string | undefined,
        initiator: (body.initiator as string) ?? "dashboard",
      });
      emitSSE(projectId, "meeting:started", {
        channelId: result.channel.id,
        participants,
      });
      return { status: 201, body: result };
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : String(err));
    }
  }

  // meetings/:id/message or meetings/:id/end
  if (segments.length < 3) return notFound("Missing meeting action");

  const channelId = segments[1]!;
  const action = segments[2]!;

  switch (action) {
    case "message": {
      const content = body.content as string;
      if (!content) return badRequest("content is required");

      try {
        const msg = sendChannelMessage({
          fromAgent: (body.fromAgent as string) ?? "dashboard",
          channelId,
          projectId,
          content,
        });
        emitSSE(projectId, "meeting:turn", { channelId, messageId: msg.id });
        return ok(msg);
      } catch (err) {
        return badRequest(err instanceof Error ? err.message : String(err));
      }
    }
    case "end": {
      try {
        const channel = concludeMeeting(
          projectId,
          channelId,
          (body.actor as string) ?? "dashboard",
        );
        emitSSE(projectId, "meeting:ended", { channelId });
        return ok(channel);
      } catch (err) {
        return badRequest(err instanceof Error ? err.message : String(err));
      }
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
    const to = body.to as string;
    const content = body.content as string;
    if (!to) return badRequest("to is required");
    if (!content) return badRequest("content is required");

    try {
      const msg = createMessage({
        fromAgent: "user",
        toAgent: to,
        projectId,
        content,
        type: "direct",
        priority: (body.priority as "normal" | "high" | "urgent") ?? "normal",
        metadata: body.proposalId ? { proposalId: body.proposalId as string } : undefined,
      });
      emitSSE(projectId, "message:new", { toAgent: to, messageId: msg.id, fromAgent: "user" });

      // Emit event so the lead picks up the user message in its next briefing
      try {
        ingestEvent(projectId, "user_message", "internal", {
          messageId: msg.id,
          toAgent: to,
          content: content.slice(0, 200),
        }, `user-msg:${msg.id}`);
      } catch { /* non-fatal */ }

      return { status: 201, body: msg };
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : String(err));
    }
  }

  // messages/:threadId/send — existing channel message pattern
  if (segments.length < 3) return notFound("Missing message action");

  const threadId = segments[1]!;
  const action = segments[2]!;

  switch (action) {
    case "send": {
      const content = body.content as string;
      if (!content) return badRequest("content is required");

      try {
        const msg = sendChannelMessage({
          fromAgent: (body.fromAgent as string) ?? "dashboard",
          channelId: threadId,
          projectId,
          content,
        });
        emitSSE(projectId, "message:new", { threadId, messageId: msg.id });
        return ok(msg);
      } catch (err) {
        return badRequest(err instanceof Error ? err.message : String(err));
      }
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
      let data = body.data;
      let sectionToPersist = section;
      if (!section) return badRequest("section is required");

      // Persist the config change via the config API service
      try {
        // Check domain exists first
        const existing = readDomainConfigViaService(projectId);
        if (!existing) {
          return { status: 404, body: { error: `Domain config file not found: ${projectId}.yaml` } };
        }

        if (section === "agents") {
          const result = saveAgentsConfig(projectId, data, (body.actor as string) ?? "dashboard");
          if (!result.ok) {
            return { status: result.status, body: { error: result.error } };
          }
          emitSSE(projectId, "config:changed", { section });
          try {
            ingestEvent(projectId, "config_updated", "internal", {
              section,
              actor: (body.actor as string) ?? "dashboard",
            }, `config-updated:${section}:${Date.now()}`);
          } catch { /* non-fatal */ }
          return ok({ ok: true, section });
        } else if (section === "budget") {
          const result = saveBudgetConfig(
            projectId,
            data,
            existing,
            (body.actor as string) ?? "dashboard",
          );
          if (!result.ok) {
            return { status: result.status, body: { error: result.error } };
          }
          emitSSE(projectId, "config:changed", { section });
          try {
            ingestEvent(projectId, "config_updated", "internal", {
              section,
              actor: (body.actor as string) ?? "dashboard",
            }, `config-updated:${section}:${Date.now()}`);
          } catch { /* non-fatal */ }
          return ok({ ok: true, section });
        } else if (section === "safety") {
          if (!isPlainObject(data)) return badRequest("safety: data must be an object");
          data = canonicalizeSafetyConfig(data);
        } else if (section === "jobs") {
          const result = saveJobsConfig(projectId, data, (body.actor as string) ?? "dashboard");
          if (!result.ok) {
            return { status: result.status, body: { error: result.error } };
          }
          emitSSE(projectId, "config:changed", { section });
          try {
            ingestEvent(projectId, "config_updated", "internal", {
              section,
              actor: (body.actor as string) ?? "dashboard",
            }, `config-updated:${section}:${Date.now()}`);
          } catch { /* non-fatal */ }
          return ok({ ok: true, section });
        } else if (section === "profile") {
          if (!isPlainObject(data)) return badRequest("profile: data must be an object");
          const profileData = data as Record<string, unknown>;
          const operationalProfile = profileData.operational_profile;
          if (operationalProfile !== undefined && typeof operationalProfile !== "string") {
            return badRequest("profile.operational_profile must be a string");
          }
          sectionToPersist = "operational_profile";
          data = operationalProfile;
        } else if (section === "initiatives") {
          if (!isPlainObject(data)) return badRequest("initiatives: data must be an object");
          sectionToPersist = "goals";
          data = canonicalizeInitiatives(data, existing.goals);
        } else if (section === "dashboard_assistant") {
          const assistantConfig = canonicalizeDashboardAssistantConfig(projectId, data);
          if (!assistantConfig.ok) {
            return { status: 400, body: { error: assistantConfig.error } };
          }
          data = assistantConfig.value;
        }

        const result = updateDomainConfigViaService(
          projectId,
          sectionToPersist,
          data,
          (body.actor as string) ?? "dashboard",
        );

        if (!result.ok) {
          return { status: 400, body: { error: result.error } };
        }

        emitSSE(projectId, "config:changed", { section });
        try {
          ingestEvent(projectId, "config_updated", "internal", {
            section,
            actor: (body.actor as string) ?? "dashboard",
          }, `config-updated:${section}:${Date.now()}`);
        } catch { /* non-fatal */ }
        return ok({ ok: true, section });
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
      const current = body.current;
      const proposed = body.proposed;
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
      return ok({
        costDelta: changes.length > 0 ? `~${changes.length} field(s) changed` : "No change",
        costDirection: "neutral" as const,
        consequence: changes.length > 0
          ? `Modified fields: ${changes.join(", ")}. Changes will take effect after save.`
          : "No changes detected between current and proposed configuration.",
        risk: changes.length > 3 ? "MEDIUM" : "LOW",
        riskExplanation: changes.length > 3
          ? "Multiple fields changed — review carefully before applying."
          : "Minor configuration change with low operational risk.",
      });
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
      const parentAgentId = readStringBody(body, "parentAgentId", "parent_agent_id");
      const childAgentId = readStringBody(body, "childAgentId", "child_agent_id");
      const actor = readStringBody(body, "actor") ?? "dashboard";

      if (!parentAgentId || !childAgentId) {
        return badRequest("parentAgentId and childAgentId are required");
      }

      const dailyLimitCents = readIntegerBody(body, "dailyLimitCents", "daily_limit_cents");
      const rawAllocationConfig = body.allocationConfig ?? body.allocation_config;

      let allocationConfig: BudgetAllocation | undefined;
      if (rawAllocationConfig != null) {
        try {
          const parsed = typeof rawAllocationConfig === "string"
            ? JSON.parse(rawAllocationConfig)
            : rawAllocationConfig;
          const normalized = normalizeBudgetConfig(parsed as Parameters<typeof normalizeBudgetConfig>[0]);
          allocationConfig = {
            hourly: normalized.hourly,
            daily: normalized.daily,
            monthly: normalized.monthly,
          };
        } catch {
          return badRequest("allocationConfig must be valid JSON or an object");
        }
      } else if (dailyLimitCents == null) {
        return badRequest("Either allocationConfig or dailyLimitCents is required");
      }

      const result = allocateBudget({
        projectId,
        parentAgentId,
        childAgentId,
        dailyLimitCents: dailyLimitCents ?? undefined,
        allocationConfig,
      });

      if (!result.ok) {
        return { status: 400, body: { ok: false, error: result.reason } };
      }

      try {
        writeAuditEntry({
          projectId,
          actor,
          action: "allocate_budget",
          targetType: "budget",
          targetId: childAgentId,
          detail: JSON.stringify({
            parentAgentId,
            childAgentId,
            dailyLimitCents,
            allocationConfig,
          }),
        });
      } catch { /* non-fatal */ }

      emitSSE(projectId, "budget:update", {
        parentAgentId,
        childAgentId,
        allocationConfig: allocationConfig ?? { daily: { cents: dailyLimitCents } },
      });

      return ok({
        ok: true,
        parentAgentId,
        childAgentId,
        allocationConfig: allocationConfig ?? { daily: { cents: dailyLimitCents } },
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
      if (!body.type || typeof body.type !== "string") {
        return badRequest("Missing required field: type");
      }
      const db = getDb(projectId);
      const result = ingestEvent(
        projectId,
        body.type as string,
        "webhook",
        (body.payload as Record<string, unknown>) ?? {},
        (body.dedup_key as string) ?? undefined,
        db,
      );
      return { status: result.deduplicated ? 200 : 201, body: result };
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
  try {
    const { global, domain, domainExtras } = createDemoConfig();

    // Write agents to global config via the config API service
    if (global.agents) {
      const agentResult = upsertGlobalAgents(global.agents, "demo-setup");
      if (!agentResult.ok) {
        return { status: 500, body: { error: `Failed to write demo agents: ${agentResult.error}` } };
      }
    }

    // Build domain config with extras (budget, safety, goals)
    const domainConfig: Record<string, unknown> = {
      domain: domain.name,
      agents: domain.agents,
    };
    if (domain.orchestrator) domainConfig.orchestrator = domain.orchestrator;
    if (domain.operational_profile) domainConfig.operational_profile = domain.operational_profile;
    Object.assign(domainConfig, domainExtras);

    // Write domain file via the config API service (full replacement)
    const domainResult = writeDomainConfig(domain.name, domainConfig as unknown as import("../config/schema.js").DomainConfig);
    if (!domainResult.ok) {
      return { status: 500, body: { error: `Failed to write demo domain: ${domainResult.error}` } };
    }

    // Load the new domain config into the running runtime so queries work immediately
    const reloadResult = reloadAllDomains();
    const loadedOk = reloadResult.domains.includes(domain.name);

    // Create goal records for demo initiatives so they show in the Command Center
    // First, clear any existing demo-setup goals to prevent duplicates on repeated clicks
    if (loadedOk && domainExtras.goals) {
      try {
        const db = getDb(domain.name);
        db.prepare("DELETE FROM goals WHERE project_id = ? AND created_by = 'demo-setup'").run(domain.name);
      } catch {
        // Non-fatal: table might not exist yet
      }

      try {
        const goals = domainExtras.goals as Record<string, { allocation?: number; description?: string; department?: string }>;
        for (const [goalId, goalDef] of Object.entries(goals)) {
          createGoal({
            projectId: domain.name,
            title: goalId.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
            description: goalDef.description,
            department: goalDef.department,
            allocation: goalDef.allocation,
            createdBy: "demo-setup",
          });
        }
      } catch {
        // Non-fatal: goals are nice-to-have for the demo
      }
    }

    return {
      status: 201,
      body: {
        domainId: domain.name,
        message: `Demo domain "${domain.name}" created with ${domain.agents.length} agents.${loadedOk ? "" : " Warning: domain written but not loaded into runtime."}`,
      },
    };
  } catch (err) {
    return {
      status: 500,
      body: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

type StarterDomainMode = "new" | "governance";

function normalizeStarterDomainId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/[:._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizePathList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const paths = raw
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  return paths.length > 0 ? Array.from(new Set(paths)) : undefined;
}

function normalizeExistingAgentIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function budgetTemplateForProfile(profile: string): DomainConfig["budget"] {
  const dailyByProfile: Record<string, number> = {
    low: 1_000,
    medium: 3_000,
    high: 7_500,
    ultra: 15_000,
  };
  const daily = dailyByProfile[profile] ?? dailyByProfile.medium;
  return {
    project: {
      hourly: { cents: Math.max(250, Math.round(daily / 10)) },
      daily: { cents: daily },
      monthly: { cents: daily * 22 },
    },
  };
}

type StarterDomainPlan = {
  domainId: string;
  mode: StarterDomainMode;
  domainConfig: DomainConfig;
  agentsToCreate: Record<string, GlobalAgentDef>;
  createdAgentIds: string[];
  reusedAgentIds: string[];
};

function buildStarterDomainPlan(
  body: Record<string, unknown>,
): { ok: true; plan: StarterDomainPlan } | { ok: false; error: string; status?: number } {
  const rawDomainId = typeof body.domainId === "string"
    ? body.domainId
    : typeof body.domain === "string"
      ? body.domain
      : "";
  const domainId = normalizeStarterDomainId(rawDomainId);
  if (!domainId) {
    return { ok: false, status: 400, error: "domainId is required" };
  }

  const mode = body.mode === "governance" ? "governance" : body.mode === "new" ? "new" : null;
  if (!mode) {
    return { ok: false, status: 400, error: "mode must be one of: new, governance" };
  }

  if (readDomainConfigViaService(domainId)) {
    return { ok: false, status: 409, error: `Domain "${domainId}" already exists.` };
  }

  const globalConfig = readGlobalConfigViaService();
  const existingGlobalAgents = globalConfig.agents ?? {};
  const mission = typeof body.mission === "string" && body.mission.trim()
    ? body.mission.trim()
    : undefined;
  const paths = normalizePathList(body.paths);
  const operationalProfile = typeof body.operationalProfile === "string" && body.operationalProfile.trim()
    ? body.operationalProfile.trim()
    : typeof body.operational_profile === "string" && body.operational_profile.trim()
      ? body.operational_profile.trim()
      : "medium";

  if (mode === "new") {
    const leadAgentId = `${domainId}-lead`;
    const builderAgentId = `${domainId}-builder`;
    const collisions = [leadAgentId, builderAgentId].filter((agentId) => existingGlobalAgents[agentId]);
    if (collisions.length > 0) {
      return {
        ok: false,
        status: 409,
        error: `Starter agent IDs already exist in global config: ${collisions.join(", ")}`,
      };
    }

    const agentsToCreate: Record<string, GlobalAgentDef> = {
      [leadAgentId]: {
        extends: "manager",
        title: "Business Lead",
        persona: mission
          ? `You lead this business. Focus the team on: ${mission}`
          : "You lead this business. Set direction, coordinate work, and keep the team within budget.",
      },
      [builderAgentId]: {
        extends: "employee",
        title: "Builder",
        reports_to: leadAgentId,
        team: "build",
        persona: mission
          ? `You execute the lead's plan for this business. Focus on: ${mission}`
          : "You execute the lead's plan for this business and report results clearly.",
      },
    };

    return {
      ok: true,
      plan: {
        domainId,
        mode,
        agentsToCreate,
        createdAgentIds: Object.keys(agentsToCreate),
        reusedAgentIds: [],
        domainConfig: {
          domain: domainId,
          template: "startup",
          agents: Object.keys(agentsToCreate),
          orchestrator: leadAgentId,
          ...(paths ? { paths } : {}),
          operational_profile: operationalProfile as DomainConfig["operational_profile"],
          budget: budgetTemplateForProfile(operationalProfile),
        },
      },
    };
  }

  const existingAgents = normalizeExistingAgentIds(body.existingAgents);
  if (existingAgents.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "existingAgents is required for governance mode",
    };
  }

  const requestedLeadAgentId = typeof body.leadAgentId === "string" && body.leadAgentId.trim()
    ? body.leadAgentId.trim()
    : undefined;
  const leadAgentId = requestedLeadAgentId ?? existingAgents[0]!;
  if (!existingAgents.includes(leadAgentId)) {
    return {
      ok: false,
      status: 400,
      error: `leadAgentId "${leadAgentId}" must be included in existingAgents`,
    };
  }

  const agentsToCreate: Record<string, GlobalAgentDef> = {};
  const reusedAgentIds: string[] = [];

  for (const agentId of existingAgents) {
    if (existingGlobalAgents[agentId]) {
      reusedAgentIds.push(agentId);
      continue;
    }

    agentsToCreate[agentId] = {
      extends: agentId === leadAgentId ? "manager" : "employee",
      title: humanizeIdentifier(agentId),
      ...(agentId === leadAgentId ? {} : { reports_to: leadAgentId }),
    };
  }

  return {
    ok: true,
    plan: {
      domainId,
      mode,
      agentsToCreate,
      createdAgentIds: Object.keys(agentsToCreate),
      reusedAgentIds,
      domainConfig: {
        domain: domainId,
        agents: existingAgents,
        orchestrator: leadAgentId,
        ...(paths ? { paths } : {}),
        operational_profile: operationalProfile as DomainConfig["operational_profile"],
        budget: budgetTemplateForProfile(operationalProfile),
      },
    },
  };
}

/**
 * Handle POST /clawforce/api/domains/create
 * Creates a minimal starter domain for either a fresh workforce or an existing governed team.
 */
export function handleStarterDomainCreate(body: Record<string, unknown>): RouteResult {
  const actor = (body.actor as string) ?? "dashboard";
  const planned = buildStarterDomainPlan(body);
  if (!planned.ok) {
    return {
      status: planned.status ?? 400,
      body: { error: planned.error },
    };
  }

  const { plan } = planned;

  try {
    if (plan.createdAgentIds.length > 0) {
      const agentResult = upsertGlobalAgents(plan.agentsToCreate, actor);
      if (!agentResult.ok) {
        return { status: 500, body: { error: `Failed to create starter agents: ${agentResult.error}` } };
      }
    }

    const domainResult = writeDomainConfig(plan.domainId, plan.domainConfig);
    if (!domainResult.ok) {
      return { status: 500, body: { error: `Failed to write starter domain: ${domainResult.error}` } };
    }

    const reloadResult = reloadAllDomains();
    const loadedOk = reloadResult.domains.includes(plan.domainId);

    try {
      writeAuditEntry({
        projectId: plan.domainId,
        actor,
        action: "create_domain",
        targetType: "domain",
        targetId: plan.domainId,
        detail: JSON.stringify({
          mode: plan.mode,
          createdAgentIds: plan.createdAgentIds,
          reusedAgentIds: plan.reusedAgentIds,
        }),
      });
    } catch { /* non-fatal */ }

    return {
      status: 201,
      body: {
        ok: true,
        domainId: plan.domainId,
        mode: plan.mode,
        createdAgentIds: plan.createdAgentIds,
        reusedAgentIds: plan.reusedAgentIds,
        message: loadedOk
          ? `Domain "${plan.domainId}" created and loaded.`
          : `Domain "${plan.domainId}" created, but runtime reload reported errors.`,
        reloadErrors: reloadResult.errors,
      },
    };
  } catch (err) {
    return {
      status: 500,
      body: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

// --- Config validation ---

function validateConfigSection(
  section: string,
  data: unknown,
  projectId?: string,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (data == null) {
    errors.push(`${section}: data is required`);
    return { errors, warnings };
  }

  switch (section) {
    case "agents": {
      if (!Array.isArray(data) && !isPlainObject(data)) {
        errors.push("agents: must be an array or object of agent configs");
        break;
      }
      const agents = normalizeAgentConfigInput(data);
      for (const [index, agentConfig] of agents.entries()) {
        const agentId = readStringBody(agentConfig, "id");
        if (!agentId) {
          errors.push(`agents[${index}].id: must be a non-empty string`);
          continue;
        }
        if (agentConfig == null || typeof agentConfig !== "object") {
          errors.push(`agents.${agentId}: config must be an object`);
          continue;
        }
        const cfg = agentConfig as Record<string, unknown>;
        if (cfg.persona !== undefined && typeof cfg.persona !== "string") {
          errors.push(`agents.${agentId}.persona: must be a string`);
        }
        if (cfg.title !== undefined && typeof cfg.title !== "string") {
          errors.push(`agents.${agentId}.title: must be a string`);
        }
      }
      break;
    }
    case "budget": {
      if (typeof data !== "object" || Array.isArray(data)) {
        errors.push("budget: must be an object");
        break;
      }
      const budget = data as Record<string, unknown>;
      const windowKeys = ["hourly", "daily", "monthly"];
      for (const wk of windowKeys) {
        if (budget[wk] === undefined) continue;
        if (typeof budget[wk] !== "object" || budget[wk] === null) {
          errors.push(`budget.${wk}: must be an object`);
          continue;
        }
        const win = budget[wk] as Record<string, unknown>;
        for (const dim of ["cents", "tokens", "requests"]) {
          if (win[dim] === undefined) continue;
          if (typeof win[dim] !== "number") {
            errors.push(`budget.${wk}.${dim}: must be a number`);
          } else if ((win[dim] as number) < 0) {
            errors.push(`budget.${wk}.${dim}: must be non-negative`);
          }
        }
      }
      break;
    }
    case "safety": {
      if (!isPlainObject(data)) {
        errors.push("safety: must be an object");
        break;
      }
      const safety = canonicalizeSafetyConfig(data);
      if (safety.maxSpawnDepth !== undefined) {
        if (typeof safety.maxSpawnDepth !== "number") {
          errors.push("safety.maxSpawnDepth: must be a number");
        } else if ((safety.maxSpawnDepth as number) < 1 || (safety.maxSpawnDepth as number) > 100) {
          errors.push("safety.maxSpawnDepth: must be between 1 and 100");
        }
      }
      if (safety.costCircuitBreaker !== undefined) {
        if (typeof safety.costCircuitBreaker !== "number") {
          errors.push("safety.costCircuitBreaker: must be a number");
        } else if ((safety.costCircuitBreaker as number) < 0) {
          errors.push("safety.costCircuitBreaker: must be non-negative");
        }
      }
      break;
    }
    case "defaults": {
      if (!isPlainObject(data)) {
        errors.push("defaults: must be an object");
        break;
      }
      validatePartialAgentConfigShape("defaults", data, errors);
      break;
    }
    case "role_defaults": {
      if (!isPlainObject(data)) {
        errors.push("role_defaults: must be an object");
        break;
      }
      for (const [role, value] of Object.entries(data)) {
        if (!isPlainObject(value)) {
          errors.push(`role_defaults.${role}: must be an object`);
          continue;
        }
        validatePartialAgentConfigShape(`role_defaults.${role}`, value, errors);
      }
      break;
    }
    case "team_templates": {
      if (!isPlainObject(data)) {
        errors.push("team_templates: must be an object");
        break;
      }
      for (const [team, value] of Object.entries(data)) {
        if (!isPlainObject(value)) {
          errors.push(`team_templates.${team}: must be an object`);
          continue;
        }
        validatePartialAgentConfigShape(`team_templates.${team}`, value, errors);
      }
      break;
    }
    case "profile": {
      if (!isPlainObject(data)) {
        errors.push("profile: must be an object");
        break;
      }
      const profile = data as Record<string, unknown>;
      if (profile.operational_profile !== undefined && typeof profile.operational_profile !== "string") {
        errors.push("profile.operational_profile: must be a string");
      }
      break;
    }
    case "rules": {
      if (!Array.isArray(data)) {
        errors.push("rules: must be an array");
        break;
      }
      for (const [index, value] of data.entries()) {
        const validation = validateRuleDefinition(value);
        if (!validation.valid) {
          for (const error of validation.errors) {
            errors.push(`rules[${index}].${error.field}: ${error.message}`);
          }
        }
        if (isPlainObject(value) && value.action && isPlainObject(value.action)) {
          const agentId = typeof value.action.agent === "string" ? value.action.agent.trim() : "";
          if (agentId && projectId) {
            const entry = getAgentConfig(agentId);
            if (!entry || entry.projectId !== projectId) {
              warnings.push(`rules[${index}].action.agent: references unknown agent "${agentId}"`);
            }
          }
        }
      }
      break;
    }
    case "initiatives": {
      if (!isPlainObject(data)) {
        errors.push("initiatives: must be an object");
        break;
      }
      for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
        if (!isPlainObject(value)) {
          errors.push(`initiatives.${name}: must be an object`);
          continue;
        }
        const allocation = (value as Record<string, unknown>).allocation_pct;
        if (allocation !== undefined) {
          if (typeof allocation !== "number") {
            errors.push(`initiatives.${name}.allocation_pct: must be a number`);
          } else if (allocation < 0 || allocation > 100) {
            errors.push(`initiatives.${name}.allocation_pct: must be between 0 and 100`);
          }
        }
      }
      break;
    }
    case "workflows": {
      if (!Array.isArray(data)) {
        errors.push("workflows: must be an array");
        break;
      }
      for (const [index, value] of data.entries()) {
        if (typeof value !== "string" || !value.trim()) {
          errors.push(`workflows[${index}]: must be a non-empty string`);
        }
      }
      break;
    }
    case "knowledge": {
      if (!isPlainObject(data)) {
        errors.push("knowledge: must be an object");
      }
      break;
    }
    case "event_handlers": {
      if (!isPlainObject(data)) {
        errors.push("event_handlers: must be an object");
        break;
      }
      validateEventHandlersShape(data, errors, warnings, projectId);
      break;
    }
    case "jobs": {
      if (!Array.isArray(data)) {
        errors.push("jobs: must be an array");
        break;
      }
      for (const [index, value] of data.entries()) {
        if (!isPlainObject(value)) {
          errors.push(`jobs[${index}]: must be an object`);
          continue;
        }
        if (typeof value.id !== "string" || !value.id.trim()) {
          errors.push(`jobs[${index}].id: must be a non-empty string`);
        }
        if (typeof value.agent !== "string" || !value.agent.trim()) {
          errors.push(`jobs[${index}].agent: must be a non-empty string`);
        }
        if (value.cron !== undefined && typeof value.cron !== "string") {
          errors.push(`jobs[${index}].cron: must be a string`);
        }
        if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
          errors.push(`jobs[${index}].enabled: must be a boolean`);
        }
      }
      break;
    }
    case "dashboard_assistant": {
      if (!isPlainObject(data)) {
        errors.push("dashboard_assistant: must be an object");
        break;
      }
      if (data.enabled !== undefined && typeof data.enabled !== "boolean") {
        errors.push("dashboard_assistant.enabled: must be a boolean");
      }
      if (data.model !== undefined && typeof data.model !== "string") {
        errors.push("dashboard_assistant.model: must be a string");
      }
      if (data.agentId !== undefined) {
        if (typeof data.agentId !== "string") {
          errors.push("dashboard_assistant.agentId: must be a string");
        } else if (!data.agentId.trim()) {
          errors.push("dashboard_assistant.agentId: must be a non-empty string");
        } else if (projectId) {
          const entry = getAgentConfig(data.agentId.trim());
          if (!entry || entry.projectId !== projectId) {
            errors.push("dashboard_assistant.agentId: must reference an agent in this domain");
          }
        }
      }
      break;
    }
    default:
      // For unknown sections, just validate it's a valid object
      if (typeof data !== "object") {
        warnings.push(`${section}: expected an object`);
      }
      break;
  }

  return { errors, warnings };
}

function validatePartialAgentConfigShape(
  prefix: string,
  data: Record<string, unknown>,
  errors: string[],
): void {
  if (data.title !== undefined && typeof data.title !== "string") {
    errors.push(`${prefix}.title: must be a string`);
  }
  if (data.persona !== undefined && typeof data.persona !== "string") {
    errors.push(`${prefix}.persona: must be a string`);
  }
  if (data.reports_to !== undefined && typeof data.reports_to !== "string") {
    errors.push(`${prefix}.reports_to: must be a string`);
  }
  if (data.department !== undefined && typeof data.department !== "string") {
    errors.push(`${prefix}.department: must be a string`);
  }
  if (data.team !== undefined && typeof data.team !== "string") {
    errors.push(`${prefix}.team: must be a string`);
  }
  if (data.channel !== undefined && typeof data.channel !== "string") {
    errors.push(`${prefix}.channel: must be a string`);
  }
  if (data.briefing !== undefined && !Array.isArray(data.briefing)) {
    errors.push(`${prefix}.briefing: must be an array`);
  }
  if (data.expectations !== undefined && !Array.isArray(data.expectations)) {
    errors.push(`${prefix}.expectations: must be an array`);
  }
  if (data.performance_policy !== undefined && !isPlainObject(data.performance_policy)) {
    errors.push(`${prefix}.performance_policy: must be an object`);
  }
}

function validateEventHandlersShape(
  data: Record<string, unknown>,
  errors: string[],
  warnings: string[],
  projectId?: string,
): void {
  for (const [eventType, rawConfig] of Object.entries(data)) {
    if (!eventType.trim()) {
      errors.push("event_handlers: contains empty event type key");
      continue;
    }

    const handlerConfig = Array.isArray(rawConfig)
      ? { actions: rawConfig, override_builtin: false }
      : isPlainObject(rawConfig)
        ? rawConfig
        : null;

    if (!handlerConfig) {
      errors.push(`event_handlers.${eventType}: must be an array or object`);
      continue;
    }

    const actions = Array.isArray(handlerConfig.actions)
      ? handlerConfig.actions
      : Array.isArray(rawConfig)
        ? rawConfig
        : null;

    if (!actions) {
      errors.push(`event_handlers.${eventType}.actions: must be an array`);
      continue;
    }

    if (
      isPlainObject(handlerConfig) &&
      handlerConfig.override_builtin !== undefined &&
      typeof handlerConfig.override_builtin !== "boolean"
    ) {
      errors.push(`event_handlers.${eventType}.override_builtin: must be a boolean`);
    }

    for (const [index, action] of actions.entries()) {
      validateEventHandlerAction(
        eventType,
        index,
        action,
        errors,
        warnings,
        projectId,
      );
    }
  }
}

function validateEventHandlerAction(
  eventType: string,
  index: number,
  action: unknown,
  errors: string[],
  warnings: string[],
  projectId?: string,
): void {
  const prefix = `event_handlers.${eventType}[${index}]`;
  if (!isPlainObject(action)) {
    errors.push(`${prefix}: must be an object`);
    return;
  }

  const actionType = typeof action.action === "string" ? action.action : "";
  if (!actionType) {
    errors.push(`${prefix}.action: must be a non-empty string`);
    return;
  }
  if (!EVENT_ACTION_TYPES.includes(actionType as typeof EVENT_ACTION_TYPES[number])) {
    errors.push(`${prefix}.action: unknown action "${actionType}"`);
    return;
  }

  switch (actionType) {
    case "create_task": {
      if (typeof action.template !== "string" || !action.template.trim()) {
        errors.push(`${prefix}.template: must be a non-empty string`);
      }
      if (action.description !== undefined && typeof action.description !== "string") {
        errors.push(`${prefix}.description: must be a string`);
      }
      if (action.priority !== undefined && typeof action.priority !== "string") {
        errors.push(`${prefix}.priority: must be a string`);
      }
      if (action.assign_to !== undefined) {
        if (typeof action.assign_to !== "string") {
          errors.push(`${prefix}.assign_to: must be a string`);
        } else if (action.assign_to !== "auto" && projectId) {
          const entry = getAgentConfig(action.assign_to.trim());
          if (!entry || entry.projectId !== projectId) {
            warnings.push(`${prefix}.assign_to: references unknown agent "${action.assign_to}"`);
          }
        }
      }
      if (action.department !== undefined && typeof action.department !== "string") {
        errors.push(`${prefix}.department: must be a string`);
      }
      if (action.team !== undefined && typeof action.team !== "string") {
        errors.push(`${prefix}.team: must be a string`);
      }
      break;
    }
    case "notify": {
      if (typeof action.message !== "string" || !action.message.trim()) {
        errors.push(`${prefix}.message: must be a non-empty string`);
      }
      if (action.to !== undefined) {
        if (typeof action.to !== "string") {
          errors.push(`${prefix}.to: must be a string`);
        } else if (projectId) {
          const entry = getAgentConfig(action.to.trim());
          if (!entry || entry.projectId !== projectId) {
            warnings.push(`${prefix}.to: references unknown agent "${action.to}"`);
          }
        }
      }
      if (action.priority !== undefined && typeof action.priority !== "string") {
        errors.push(`${prefix}.priority: must be a string`);
      }
      break;
    }
    case "escalate": {
      if (typeof action.to !== "string" || !action.to.trim()) {
        errors.push(`${prefix}.to: must be a non-empty string`);
      } else if (action.to !== "manager" && projectId) {
        const entry = getAgentConfig(action.to.trim());
        if (!entry || entry.projectId !== projectId) {
          warnings.push(`${prefix}.to: references unknown agent "${action.to}"`);
        }
      }
      if (action.message !== undefined && typeof action.message !== "string") {
        errors.push(`${prefix}.message: must be a string`);
      }
      break;
    }
    case "enqueue_work": {
      if (action.task_id !== undefined && typeof action.task_id !== "string") {
        errors.push(`${prefix}.task_id: must be a string`);
      }
      if (action.priority !== undefined && typeof action.priority !== "number") {
        errors.push(`${prefix}.priority: must be a number`);
      }
      break;
    }
    case "emit_event": {
      if (typeof action.event_type !== "string" || !action.event_type.trim()) {
        errors.push(`${prefix}.event_type: must be a non-empty string`);
      }
      if (action.event_payload !== undefined) {
        if (!isPlainObject(action.event_payload)) {
          errors.push(`${prefix}.event_payload: must be an object`);
        } else {
          for (const [key, value] of Object.entries(action.event_payload)) {
            if (typeof value !== "string") {
              errors.push(`${prefix}.event_payload.${key}: must be a string`);
            }
          }
        }
      }
      if (action.dedup_key !== undefined && typeof action.dedup_key !== "string") {
        errors.push(`${prefix}.dedup_key: must be a string`);
      }
      break;
    }
    case "dispatch_agent": {
      if (typeof action.agent_role !== "string" || !action.agent_role.trim()) {
        errors.push(`${prefix}.agent_role: must be a non-empty string`);
      }
      if (action.model !== undefined && typeof action.model !== "string") {
        errors.push(`${prefix}.model: must be a string`);
      }
      if (action.session_type !== undefined) {
        if (
          typeof action.session_type !== "string" ||
          !["reactive", "active", "planning"].includes(action.session_type)
        ) {
          errors.push(`${prefix}.session_type: must be one of reactive, active, planning`);
        }
      }
      if (action.payload !== undefined && !isPlainObject(action.payload)) {
        errors.push(`${prefix}.payload: must be an object`);
      }
      break;
    }
  }
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
      const dismissKey = body.dismissKey as string | undefined;
      if (!dismissKey) return badRequest("Missing dismissKey");

      const db = getDb(projectId);
      try {
        const row = db.prepare(
          `SELECT value FROM onboarding_state WHERE project_id = ? AND key = 'dismissed_interventions'`,
        ).get(projectId) as { value: string } | undefined;

        const dismissed: string[] = row ? JSON.parse(row.value) : [];
        if (!dismissed.includes(dismissKey)) {
          dismissed.push(dismissKey);
        }

        db.prepare(
          `INSERT INTO onboarding_state (project_id, key, value, updated_at) VALUES (?, 'dismissed_interventions', ?, ?)
           ON CONFLICT (project_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(projectId, JSON.stringify(dismissed), Date.now());

        return ok({ ok: true, dismissKey, status: "dismissed" });
      } catch (err) {
        return { status: 500, body: { error: `Failed to dismiss intervention: ${err}` } };
      }
    }
    default:
      return notFound(`Unknown intervention action: ${action}`);
  }
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

function readStringBody(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readIntegerBody(body: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalizeSafetyConfig(data: unknown): Record<string, unknown> {
  if (!isPlainObject(data)) return {};
  const safety = data as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  const maxSpawnDepth = safety.maxSpawnDepth ?? safety.spawn_depth_limit;
  if (typeof maxSpawnDepth === "number") next.maxSpawnDepth = maxSpawnDepth;

  const costCircuitBreaker = safety.costCircuitBreaker ?? safety.circuit_breaker_multiplier;
  if (typeof costCircuitBreaker === "number") next.costCircuitBreaker = costCircuitBreaker;

  const loopDetectionThreshold = safety.loopDetectionThreshold ?? safety.loop_detection_threshold;
  if (typeof loopDetectionThreshold === "number") next.loopDetectionThreshold = loopDetectionThreshold;

  for (const [key, value] of Object.entries(safety)) {
    if (!(key in {
      maxSpawnDepth: true,
      spawn_depth_limit: true,
      costCircuitBreaker: true,
      circuit_breaker_multiplier: true,
      loopDetectionThreshold: true,
      loop_detection_threshold: true,
    })) {
      next[key] = value;
    }
  }

  return next;
}

function canonicalizeInitiatives(
  data: unknown,
  existingGoals: unknown,
): Record<string, unknown> {
  const initiatives = isPlainObject(data) ? data : {};
  const priorGoals = isPlainObject(existingGoals) ? existingGoals : {};
  const nextGoals: Record<string, unknown> = {};

  for (const [goalId, goalValue] of Object.entries(priorGoals)) {
    if (isPlainObject(goalValue)) {
      nextGoals[goalId] = { ...goalValue };
    } else {
      nextGoals[goalId] = goalValue;
    }
  }

  for (const [goalId, value] of Object.entries(initiatives)) {
    if (!isPlainObject(value)) continue;
    const allocation = (value as Record<string, unknown>).allocation_pct;
    const existing = isPlainObject(nextGoals[goalId]) ? nextGoals[goalId] as Record<string, unknown> : {};
    nextGoals[goalId] = {
      ...existing,
      ...(typeof allocation === "number" ? { allocation } : {}),
    };
  }

  for (const goalId of Object.keys(nextGoals)) {
    if (goalId in initiatives) continue;
    if (!isPlainObject(nextGoals[goalId])) continue;
    const current = { ...(nextGoals[goalId] as Record<string, unknown>) };
    if ("allocation" in current) {
      delete current.allocation;
      nextGoals[goalId] = current;
    }
  }

  return nextGoals;
}

function saveJobsConfig(
  projectId: string,
  data: unknown,
  actor: string,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!Array.isArray(data)) {
    return { ok: false, status: 400, error: "jobs: data must be an array" };
  }

  const globalConfig = readGlobalConfigViaService();
  const grouped = new Map<string, Record<string, Record<string, unknown>>>();
  const payloadAgentIds = new Set<string>();
  const projectAgentIds = new Set(getProjectAgentIds(projectId));

  for (const [index, item] of data.entries()) {
    if (!isPlainObject(item)) {
      return { ok: false, status: 400, error: `jobs[${index}] must be an object` };
    }

    const agentId = readStringBody(item, "agent");
    const jobId = readStringBody(item, "id");
    if (!agentId || !jobId) {
      return { ok: false, status: 400, error: `jobs[${index}] must include id and agent` };
    }
    payloadAgentIds.add(agentId);

    const entry = getAgentConfig(agentId);
    if (!entry || entry.projectId !== projectId) {
      return { ok: false, status: 404, error: `Agent "${agentId}" is not registered in project "${projectId}"` };
    }

    const jobName = parseDashboardJobName(jobId);
    const globalAgent = globalConfig.agents?.[agentId] as Record<string, unknown> | undefined;
    const existingJobs = (globalAgent?.jobs && typeof globalAgent.jobs === "object")
      ? globalAgent.jobs as Record<string, unknown>
      : {};
    const existingJob = existingJobs[jobName];
    const nextJobs = grouped.get(agentId) ?? {};

    const current = isPlainObject(existingJob) ? existingJob as Record<string, unknown> : {};
    nextJobs[jobName] = {
      ...current,
      cron: typeof item.cron === "string" ? item.cron : (current.cron as string | undefined),
      enabled: typeof item.enabled === "boolean" ? item.enabled : current.enabled ?? true,
      ...(typeof item.description === "string" ? { description: item.description } : current.description !== undefined ? { description: current.description } : {}),
    };

    grouped.set(agentId, nextJobs);
  }

  const persistedAgentIds = new Set<string>([
    ...Array.from(projectAgentIds).filter((agentId) => !!globalConfig.agents?.[agentId]),
    ...payloadAgentIds,
  ]);

  for (const agentId of persistedAgentIds) {
    const jobs = grouped.get(agentId) ?? {};
    const result = updateGlobalAgentConfig(agentId, { jobs }, actor);
    if (!result.ok) {
      return { ok: false, status: 400, error: result.error ?? `Failed to update jobs for "${agentId}"` };
    }
  }

  return { ok: true };
}

function saveAgentsConfig(
  projectId: string,
  data: unknown,
  actor: string,
): { ok: true } | { ok: false; status: number; error: string } {
  const agents = normalizeAgentConfigInput(data);
  const rawGlobalConfig = readGlobalConfigViaService();
  const upserts: Record<string, Record<string, unknown>> = {};
  const domainAgentIds: string[] = [];

  for (const [index, item] of agents.entries()) {
    const agentId = readStringBody(item, "id");
    if (!agentId) {
      return { ok: false, status: 400, error: `agents[${index}].id must be a non-empty string` };
    }

    const existingRuntime = getAgentConfig(agentId);
    if (existingRuntime && existingRuntime.projectId !== projectId) {
      return {
        ok: false,
        status: 409,
        error: `Agent "${agentId}" belongs to project "${existingRuntime.projectId}", not "${projectId}"`,
      };
    }

    const existingRaw = rawGlobalConfig.agents?.[agentId];
    upserts[agentId] = canonicalizeDashboardAgentConfig(item, existingRaw);
    domainAgentIds.push(agentId);
  }

  const agentResult = upsertGlobalAgents(
    upserts as Parameters<typeof upsertGlobalAgents>[0],
    actor,
  );
  if (!agentResult.ok) {
    return { ok: false, status: 400, error: agentResult.error ?? "Failed to update agent config" };
  }

  const domainResult = updateDomainConfigViaService(projectId, "agents", domainAgentIds, actor);
  if (!domainResult.ok) {
    return { ok: false, status: 400, error: domainResult.error ?? "Failed to update domain agents list" };
  }

  return { ok: true };
}

function saveBudgetConfig(
  projectId: string,
  data: unknown,
  existingDomain: Record<string, unknown>,
  actor: string,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!isPlainObject(data)) {
    return { ok: false, status: 400, error: "budget: data must be an object" };
  }

  const profile = typeof data.operational_profile === "string"
    ? data.operational_profile.trim() || undefined
    : undefined;
  const initiatives = isPlainObject(data.initiatives)
    ? data.initiatives as Record<string, unknown>
    : undefined;

  const budgetData = { ...data };
  delete budgetData.operational_profile;
  delete budgetData.initiatives;

  const budgetResult = updateDomainConfigViaService(projectId, "budget", budgetData, actor);
  if (!budgetResult.ok) {
    return { ok: false, status: 400, error: budgetResult.error ?? "Failed to update budget config" };
  }

  if (profile !== undefined) {
    const profileResult = updateDomainConfigViaService(projectId, "operational_profile", profile, actor);
    if (!profileResult.ok) {
      return { ok: false, status: 400, error: profileResult.error ?? "Failed to update operational profile" };
    }
  }

  if (initiatives !== undefined) {
    const goals = canonicalizeBudgetInitiatives(initiatives, existingDomain.goals);
    const initiativesResult = updateDomainConfigViaService(projectId, "goals", goals, actor);
    if (!initiativesResult.ok) {
      return { ok: false, status: 400, error: initiativesResult.error ?? "Failed to update initiative allocations" };
    }
  }

  return { ok: true };
}

function normalizeAgentConfigInput(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter(isPlainObject);
  }
  if (isPlainObject(data)) {
    return Object.entries(data).map(([id, value]) => {
      if (isPlainObject(value)) {
        return { id, ...value };
      }
      return { id };
    });
  }
  return [];
}

function canonicalizeDashboardAgentConfig(
  item: Record<string, unknown>,
  existingRaw: unknown,
): Record<string, unknown> {
  const current = isPlainObject(existingRaw) ? { ...existingRaw } : {};
  const next: Record<string, unknown> = { ...current };

  assignOptionalString(next, "extends", item.extends);
  assignOptionalString(next, "title", item.title);
  assignOptionalString(next, "persona", item.persona);
  assignOptionalString(next, "reports_to", item.reports_to);
  assignOptionalString(next, "department", item.department);
  assignOptionalString(next, "team", item.team);
  assignOptionalString(next, "channel", item.channel);

  if (Array.isArray(item.briefing)) {
    next.briefing = reconcileDashboardBriefing(
      item.briefing as unknown[],
      Array.isArray(current.briefing) ? current.briefing : [],
    );
  }

  if (Array.isArray(item.expectations)) {
    next.expectations = reconcileDashboardExpectations(
      item.expectations as unknown[],
      Array.isArray(current.expectations) ? current.expectations : [],
    );
  }

  if (isPlainObject(item.performance_policy)) {
    next.performance_policy = { ...item.performance_policy };
  }

  return next;
}

function assignOptionalString(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      delete target[key];
      return;
    }
    target[key] = trimmed;
    return;
  }
  if (value === null) {
    delete target[key];
  }
}

function reconcileDashboardBriefing(
  input: unknown[],
  existing: unknown[],
): unknown[] {
  const pool = [...existing];
  return input
    .map((entry) => {
      if (typeof entry !== "string") return entry;
      const index = pool.findIndex((candidate) => renderContextSourceLabel(candidate) === entry);
      if (index !== -1) {
        return pool.splice(index, 1)[0]!;
      }
      return parseDashboardBriefingEntry(entry);
    })
    .filter((entry) => entry !== null);
}

function reconcileDashboardExpectations(
  input: unknown[],
  existing: unknown[],
): unknown[] {
  const pool = [...existing];
  return input
    .map((entry) => {
      if (typeof entry !== "string") return entry;
      const index = pool.findIndex((candidate) => renderExpectationLabel(candidate) === entry);
      if (index !== -1) {
        return pool.splice(index, 1)[0]!;
      }
      return parseDashboardExpectation(entry);
    })
    .filter((entry) => entry !== null);
}

function renderContextSourceLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isPlainObject(value)) return "";
  const source = typeof value.source === "string" ? value.source : "";
  if (!source) return "";
  if (source === "file" && typeof value.path === "string" && value.path.trim()) {
    return `file: ${value.path.trim()}`;
  }
  if (source === "custom_stream" && typeof value.streamName === "string" && value.streamName.trim()) {
    return `custom_stream: ${value.streamName.trim()}`;
  }
  return source;
}

function parseDashboardBriefingEntry(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const fileMatch = trimmed.match(/^file:\s*(.+)$/i);
  if (fileMatch?.[1]?.trim()) {
    return { source: "file", path: fileMatch[1].trim() };
  }

  const streamMatch = trimmed.match(/^custom_stream:\s*(.+)$/i);
  if (streamMatch?.[1]?.trim()) {
    return { source: "custom_stream", streamName: streamMatch[1].trim() };
  }

  return { source: trimmed };
}

function renderExpectationLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isPlainObject(value)) return "";
  const tool = typeof value.tool === "string" ? value.tool : "";
  if (!tool) return "";
  const action = Array.isArray(value.action)
    ? value.action.map(String).join(", ")
    : typeof value.action === "string"
      ? value.action
      : "";
  const minCalls = typeof value.min_calls === "number" ? value.min_calls : 1;
  return `${tool}${action ? `: ${action}` : ""} (min: ${minCalls})`;
}

function parseDashboardExpectation(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const withMin = trimmed.match(/^(.*?)(?:\s+\(min:\s*(\d+)\))$/);
  const body = withMin?.[1]?.trim() ?? trimmed;
  const minCalls = withMin?.[2] ? Number.parseInt(withMin[2], 10) : 1;

  const colonIndex = body.indexOf(":");
  const tool = (colonIndex === -1 ? body : body.slice(0, colonIndex)).trim();
  if (!tool) return null;

  const actionText = colonIndex === -1 ? "" : body.slice(colonIndex + 1).trim();
  let action: string | string[] = "";
  if (actionText.length > 0) {
    const actions = actionText.split(",").map((part) => part.trim()).filter(Boolean);
    action = actions.length > 1 ? actions : actions[0] ?? "";
  }

  return {
    tool,
    action,
    min_calls: Number.isFinite(minCalls) ? minCalls : 1,
  };
}

function canonicalizeBudgetInitiatives(
  data: Record<string, unknown>,
  existingGoals: unknown,
): Record<string, unknown> {
  const shaped: Record<string, { allocation_pct: number }> = {};
  for (const [goalId, allocation] of Object.entries(data)) {
    if (typeof allocation !== "number") continue;
    shaped[goalId] = { allocation_pct: allocation };
  }
  return canonicalizeInitiatives(shaped, existingGoals);
}

function canonicalizeDashboardAssistantConfig(
  projectId: string,
  data: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!isPlainObject(data)) {
    return { ok: false, error: "dashboard_assistant: data must be an object" };
  }

  const config: Record<string, unknown> = {};

  if (data.enabled !== undefined) {
    if (typeof data.enabled !== "boolean") {
      return { ok: false, error: "dashboard_assistant.enabled must be a boolean" };
    }
    config.enabled = data.enabled;
  }

  if (data.model !== undefined) {
    if (typeof data.model !== "string") {
      return { ok: false, error: "dashboard_assistant.model must be a string" };
    }
    const model = data.model.trim();
    if (model) config.model = model;
  }

  if (data.agentId !== undefined) {
    if (typeof data.agentId !== "string") {
      return { ok: false, error: "dashboard_assistant.agentId must be a string" };
    }
    const agentId = data.agentId.trim();
    if (agentId) {
      const entry = getAgentConfig(agentId);
      if (!entry || entry.projectId !== projectId) {
        return { ok: false, error: "dashboard_assistant.agentId must reference an agent in this domain" };
      }
      config.agentId = agentId;
    }
  }

  return { ok: true, value: config };
}

function parseDashboardJobName(id: string): string {
  const idx = id.lastIndexOf(":");
  return idx === -1 ? id : id.slice(idx + 1);
}
