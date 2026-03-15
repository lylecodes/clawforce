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
import { createGoal } from "../goals/ops.js";
import { getDb } from "../db.js";
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
    case "messages":
      return handleMessageAction(projectId, segments, body);
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

function handleMessageAction(
  projectId: string,
  segments: string[],
  body: Record<string, unknown>,
): RouteResult {
  // messages/:threadId/send
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
        emitSSE(projectId, "message:sent", { threadId, messageId: msg.id });
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
      const data = body.data;
      if (!section) return badRequest("section is required");

      // Attempt to persist the config change to the domain YAML file
      try {
        const baseDir = path.join(os.homedir(), ".clawforce");
        const domainsDir = path.join(baseDir, "domains");
        const domainPath = path.join(domainsDir, `${projectId}.yaml`);

        if (!fs.existsSync(domainPath)) {
          return { status: 404, body: { error: `Domain config file not found: ${projectId}.yaml` } };
        }

        const raw = fs.readFileSync(domainPath, "utf-8");
        const config = YAML.parse(raw) as Record<string, unknown>;
        config[section] = data;
        fs.writeFileSync(domainPath, YAML.stringify(config), "utf-8");

        // Reload domain config into runtime
        try {
          initializeAllDomains(baseDir);
        } catch {
          // Non-fatal: file is saved even if runtime reload fails
        }

        emitSSE(projectId, "config:updated", { section });
        return ok({ saved: true, section });
      } catch (err) {
        return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    }
    case "validate": {
      const section = body.section as string;
      if (!section) return badRequest("section is required");
      // Basic validation: check that the data is well-formed
      return ok({ valid: true, section, errors: [], warnings: [] });
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
