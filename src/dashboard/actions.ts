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
import { disableAgent, enableAgent } from "../enforcement/disabled-store.js";
import { startMeeting, concludeMeeting } from "../channels/meeting.js";
import { sendChannelMessage } from "../channels/messages.js";
import { createMessage } from "../messaging/store.js";
import { emitSSE } from "./sse.js";
import type { EvidenceType, TaskPriority, TaskState } from "../types.js";
import { ingestEvent } from "../events/store.js";
import { createDemoConfig } from "./demo.js";
import { scaffoldConfigDir, initDomain } from "../config/wizard.js";
import { loadGlobalConfig } from "../config/loader.js";
import { initializeAllDomains } from "../config/init.js";
import { createGoal } from "../goals/ops.js";
import { getDb } from "../db.js";
import { getRegisteredAgentIds, getAgentConfig, getExtendedProjectConfig } from "../project.js";
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
  if (action === "disable" || action === "enable") {
    try {
      const allAgentIds = getRegisteredAgentIds();
      const projectAgentIds = allAgentIds.filter((id) => {
        const entry = getAgentConfig(id);
        return entry?.projectId === projectId;
      });
      if (projectAgentIds.length > 0 && !projectAgentIds.includes(agentId)) {
        return notFound(`Agent "${agentId}" is not registered in project "${projectId}".`);
      }
    } catch {
      // If project module is unavailable, skip validation
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
      if (!section) return badRequest("section is required");

      // When saving the "agents" section, convert bare string briefing items
      // back to ContextSource objects to prevent data loss. The frontend
      // BriefingBuilder normalizes ContextSource objects to bare strings,
      // which destroys rich fields like path, content, and filter.
      if (section === "agents" && data && typeof data === "object") {
        const agents = data as Record<string, Record<string, unknown>>;
        for (const agentId of Object.keys(agents)) {
          const agentData = agents[agentId];
          if (agentData && Array.isArray(agentData.briefing)) {
            agentData.briefing = (agentData.briefing as unknown[]).map((item) =>
              typeof item === "string" ? { source: item } : item,
            );
          }
          // Also handle briefing inside jobs
          if (agentData && agentData.jobs && typeof agentData.jobs === "object") {
            const jobs = agentData.jobs as Record<string, Record<string, unknown>>;
            for (const jobId of Object.keys(jobs)) {
              const jobData = jobs[jobId];
              if (jobData && Array.isArray(jobData.briefing)) {
                jobData.briefing = (jobData.briefing as unknown[]).map((item) =>
                  typeof item === "string" ? { source: item } : item,
                );
              }
            }
          }
        }
        data = agents;
      }

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

        emitSSE(projectId, "config:changed", { section });
        try {
          ingestEvent(projectId, "config_updated", "internal", {
            section,
            actor: (body.actor as string) ?? "dashboard",
          }, `config-updated:${section}:${Date.now()}`);
        } catch { /* non-fatal */ }
        return ok({ saved: true, section });
      } catch (err) {
        return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    }
    case "validate": {
      const section = body.section as string;
      if (!section) return badRequest("section is required");
      const validationData = body.data;
      const { errors, warnings } = validateConfigSection(section, validationData);
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

// --- Config validation ---

function validateConfigSection(
  section: string,
  data: unknown,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (data == null) {
    errors.push(`${section}: data is required`);
    return { errors, warnings };
  }

  switch (section) {
    case "agents": {
      if (typeof data !== "object" || Array.isArray(data)) {
        errors.push("agents: must be an object mapping agent IDs to configs");
        break;
      }
      const agents = data as Record<string, unknown>;
      for (const [agentId, agentConfig] of Object.entries(agents)) {
        if (!agentId || typeof agentId !== "string") {
          errors.push("agents: each agent must have a string id");
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
      if (typeof data !== "object" || Array.isArray(data)) {
        errors.push("safety: must be an object");
        break;
      }
      const safety = data as Record<string, unknown>;
      if (safety.maxSpawnDepth !== undefined) {
        if (typeof safety.maxSpawnDepth !== "number") {
          errors.push("safety.maxSpawnDepth: must be a number");
        } else if ((safety.maxSpawnDepth as number) < 1 || (safety.maxSpawnDepth as number) > 100) {
          errors.push("safety.maxSpawnDepth: must be between 1 and 100");
        }
      }
      if (safety.maxConcurrentSessions !== undefined) {
        if (typeof safety.maxConcurrentSessions !== "number") {
          errors.push("safety.maxConcurrentSessions: must be a number");
        } else if ((safety.maxConcurrentSessions as number) < 1 || (safety.maxConcurrentSessions as number) > 50) {
          errors.push("safety.maxConcurrentSessions: must be between 1 and 50");
        }
      }
      if (safety.maxCostPerSessionCents !== undefined) {
        if (typeof safety.maxCostPerSessionCents !== "number") {
          errors.push("safety.maxCostPerSessionCents: must be a number");
        } else if ((safety.maxCostPerSessionCents as number) < 0) {
          errors.push("safety.maxCostPerSessionCents: must be non-negative");
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
