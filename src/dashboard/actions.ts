/**
 * Clawforce — Dashboard action handlers
 *
 * REST POST action handlers: approve, reject, reassign, create task,
 * disable/enable agent, message agent, meeting create/message/end, etc.
 * Each action is a thin wrapper around existing core functions.
 */

import type { RouteResult } from "./routes.js";
import { approveProposal, rejectProposal } from "../approval/resolve.js";
import { createTask, reassignTask, transitionTask } from "../tasks/ops.js";
import { disableAgent, enableAgent } from "../enforcement/disabled-store.js";
import { startMeeting, concludeMeeting } from "../channels/meeting.js";
import { sendChannelMessage } from "../channels/messages.js";
import { emitSSE } from "./sse.js";
import type { TaskPriority, TaskState } from "../types.js";
import { createDemoConfig } from "./demo.js";
import { scaffoldConfigDir, initDomain } from "../config/wizard.js";
import { loadGlobalConfig } from "../config/loader.js";
import { initializeAllDomains } from "../config/init.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";

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
    case "config":
      return handleConfigAction(projectId, segments, body);
    case "budget":
      return handleBudgetAction(projectId, segments, body);
    default:
      return notFound(`Unknown action resource: ${resource}`);
  }
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

  switch (action) {
    case "disable": {
      const reason = (body.reason as string) ?? "Disabled via dashboard";
      disableAgent(projectId, agentId, reason);
      emitSSE(projectId, "agent:status", { agentId, status: "disabled", reason });
      return ok({ agentId, status: "disabled" });
    }
    case "enable": {
      enableAgent(projectId, agentId);
      emitSSE(projectId, "agent:status", { agentId, status: "idle" });
      return ok({ agentId, status: "enabled" });
    }
    case "message": {
      // Deferred: requires adapter wiring (injectAgentMessage)
      // This is handled at the gateway-routes level where the adapter is available
      return { status: 501, body: { error: "Agent messaging requires gateway adapter wiring" } };
    }
    case "kill": {
      // Deferred: requires adapter wiring (runtime kill)
      return { status: 501, body: { error: "Session kill requires gateway adapter wiring" } };
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

function handleConfigAction(
  _projectId: string,
  segments: string[],
  _body: Record<string, unknown>,
): RouteResult {
  const action = segments[1];
  switch (action) {
    case "save":
    case "validate":
    case "preview":
      // Deferred: requires config writer wiring
      return { status: 501, body: { error: `Config ${action} not yet implemented` } };
    default:
      return notFound(`Unknown config action: ${action}`);
  }
}

function handleBudgetAction(
  _projectId: string,
  segments: string[],
  _body: Record<string, unknown>,
): RouteResult {
  const action = segments[1];
  switch (action) {
    case "allocate":
      // Deferred: requires budget allocation wiring
      return { status: 501, body: { error: "Budget allocation not yet implemented" } };
    default:
      return notFound(`Unknown budget action: ${action}`);
  }
}

/**
 * Handle POST /clawforce/api/demo/create
 * Creates a demo domain with the full-org example config.
 */
export function handleDemoCreate(): RouteResult {
  try {
    const { global, domain, domainExtras } = createDemoConfig();
    const baseDir = path.join(os.homedir(), ".clawforce");

    // Scaffold config directory
    scaffoldConfigDir(baseDir);

    // Write agents to global config
    if (global.agents) {
      const configPath = path.join(baseDir, "config.yaml");
      let existing: Record<string, unknown>;

      try {
        existing = loadGlobalConfig(baseDir) as Record<string, unknown>;
      } catch {
        existing = { agents: {} };
      }

      const existingAgents = (existing.agents ?? {}) as Record<string, unknown>;
      Object.assign(existingAgents, global.agents);
      existing.agents = existingAgents;

      fs.writeFileSync(configPath, YAML.stringify(existing), "utf-8");
    }

    // Build domain YAML with extras (budget, safety, goals)
    const domainYaml: Record<string, unknown> = {
      domain: domain.name,
      agents: domain.agents,
    };
    if (domain.orchestrator) domainYaml.orchestrator = domain.orchestrator;
    if (domain.operational_profile) domainYaml.operational_profile = domain.operational_profile;
    Object.assign(domainYaml, domainExtras);

    // Write domain file
    const domainsDir = path.join(baseDir, "domains");
    fs.mkdirSync(domainsDir, { recursive: true });
    const domainPath = path.join(domainsDir, `${domain.name}.yaml`);

    // If demo domain already exists, overwrite it
    fs.writeFileSync(domainPath, YAML.stringify(domainYaml), "utf-8");

    // Load the new domain config into the running runtime so queries work immediately
    const initResult = initializeAllDomains(baseDir);
    const loadedOk = initResult.domains.includes(domain.name);

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
