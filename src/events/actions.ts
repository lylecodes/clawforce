/**
 * Clawforce — Event action executors
 *
 * Built-in action implementations for the event-action router.
 * Each executor is isolated — one failing does not block others.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  ClawforceEvent,
  CreateTaskAction,
  NotifyAction,
  EscalateAction,
  EnqueueWorkAction,
  EmitEventAction,
  DispatchAgentAction,
  EventActionConfig,
} from "../types.js";
import { safeLog } from "../diagnostics.js";
import { interpolate, type TemplateContext } from "./template.js";
import { ingestEvent } from "./store.js";
import { createTask } from "../tasks/ops.js";
import { createMessage } from "../messaging/store.js";
import { enqueue } from "../dispatch/queue.js";
import { getRegisteredAgentIds, getAgentConfig, getExtendedProjectConfig } from "../project.js";
import { autoAssign } from "../assignment/engine.js";

export type ActionResult = {
  action: string;
  ok: boolean;
  detail?: Record<string, unknown>;
  error?: string;
};

function buildContext(event: ClawforceEvent): TemplateContext {
  return {
    event: { id: event.id, type: event.type, source: event.source, projectId: event.projectId },
    payload: event.payload,
  };
}

/**
 * Execute a single event action config against an event.
 */
export function executeAction(
  event: ClawforceEvent,
  config: EventActionConfig,
  db: DatabaseSync,
): ActionResult {
  switch (config.action) {
    case "create_task": return executeCreateTask(event, config, db);
    case "notify": return executeNotify(event, config, db);
    case "escalate": return executeEscalate(event, config, db);
    case "enqueue_work": return executeEnqueueWork(event, config, db);
    case "emit_event": return executeEmitEvent(event, config, db);
    case "dispatch_agent": return executeDispatchAgent(event, config, db);
    default:
      return { action: (config as { action: string }).action, ok: false, error: "Unknown action type" };
  }
}

function executeCreateTask(
  event: ClawforceEvent,
  config: CreateTaskAction,
  db: DatabaseSync,
): ActionResult {
  const ctx = buildContext(event);
  const title = interpolate(config.template, ctx);
  const description = config.description ? interpolate(config.description, ctx) : undefined;

  // Dedup: skip if non-terminal task with same title exists
  const existing = db.prepare(
    "SELECT id FROM tasks WHERE project_id = ? AND title = ? AND state NOT IN ('DONE', 'FAILED', 'CANCELLED') LIMIT 1",
  ).get(event.projectId, title) as Record<string, unknown> | undefined;
  if (existing) {
    return { action: "create_task", ok: true, detail: { deduplicated: true, existingTaskId: existing.id } };
  }

  const task = createTask({
    projectId: event.projectId,
    title,
    description,
    priority: config.priority ?? "P2",
    createdBy: `system:event_handler:${event.type}`,
    assignedTo: config.assign_to && config.assign_to !== "auto" ? config.assign_to : undefined,
    department: config.department,
    team: config.team,
    metadata: { sourceEventId: event.id, sourceEventType: event.type },
  }, db);

  // Handle auto-assignment
  if (config.assign_to === "auto" && task.state === "OPEN") {
    try {
      const extConfig = getExtendedProjectConfig(event.projectId);
      if (extConfig?.assignment?.enabled) {
        autoAssign(event.projectId, task.id, extConfig.assignment, db);
      }
    } catch (err) { safeLog("actions.autoAssign", err); }
  }

  return { action: "create_task", ok: true, detail: { taskId: task.id, title } };
}

function executeNotify(
  event: ClawforceEvent,
  config: NotifyAction,
  db: DatabaseSync,
): ActionResult {
  const ctx = buildContext(event);
  const content = interpolate(config.message, ctx);
  const toAgent = config.to ?? findManagerAgent(event.projectId);

  if (!toAgent) {
    return { action: "notify", ok: false, error: "No target agent for notification" };
  }

  const msg = createMessage({
    fromAgent: `system:event_handler:${event.type}`,
    toAgent,
    projectId: event.projectId,
    type: "notification",
    priority: config.priority ?? "normal",
    content,
  }, db);

  return { action: "notify", ok: true, detail: { messageId: msg.id, to: toAgent } };
}

function executeEscalate(
  event: ClawforceEvent,
  config: EscalateAction,
  db: DatabaseSync,
): ActionResult {
  const ctx = buildContext(event);
  const message = config.message
    ? interpolate(config.message, ctx)
    : `Event ${event.type} requires escalation`;

  let targetAgent: string | undefined;
  if (config.to === "manager") {
    targetAgent = findManagerAgent(event.projectId);
  } else {
    targetAgent = config.to;
  }

  if (!targetAgent) {
    return { action: "escalate", ok: false, error: "No escalation target found" };
  }

  const msg = createMessage({
    fromAgent: `system:event_handler:${event.type}`,
    toAgent: targetAgent,
    projectId: event.projectId,
    type: "escalation",
    priority: "urgent",
    content: message,
  }, db);

  return { action: "escalate", ok: true, detail: { messageId: msg.id, to: targetAgent } };
}

function executeEnqueueWork(
  event: ClawforceEvent,
  config: EnqueueWorkAction,
  db: DatabaseSync,
): ActionResult {
  const taskId = config.task_id
    ? interpolate(config.task_id, buildContext(event))
    : (event.payload.taskId as string | undefined);

  if (!taskId) {
    return { action: "enqueue_work", ok: false, error: "No taskId available" };
  }

  const item = enqueue(event.projectId, taskId, undefined, config.priority ?? undefined, db);

  if (!item) {
    return { action: "enqueue_work", ok: true, detail: { deduplicated: true, taskId } };
  }

  return { action: "enqueue_work", ok: true, detail: { queueItemId: item.id, taskId } };
}

function executeEmitEvent(
  event: ClawforceEvent,
  config: EmitEventAction,
  db: DatabaseSync,
): ActionResult {
  const ctx = buildContext(event);
  const eventType = interpolate(config.event_type, ctx);
  const dedupKey = config.dedup_key ? interpolate(config.dedup_key, ctx) : undefined;

  let payload: Record<string, unknown>;
  if (config.event_payload) {
    payload = {};
    for (const [key, valTemplate] of Object.entries(config.event_payload)) {
      payload[key] = interpolate(valTemplate, ctx);
    }
  } else {
    payload = { ...event.payload, sourceEventId: event.id };
  }

  const result = ingestEvent(event.projectId, eventType, "internal", payload, dedupKey, db);

  return { action: "emit_event", ok: true, detail: { eventId: result.id, type: eventType, deduplicated: result.deduplicated } };
}

function executeDispatchAgent(
  event: ClawforceEvent,
  config: DispatchAgentAction,
  db: DatabaseSync,
): ActionResult {
  const agentId = findAgentByRole(event.projectId, config.agent_role);
  if (!agentId) {
    return { action: "dispatch_agent", ok: false, error: `No agent found with role "${config.agent_role}" in project ${event.projectId}` };
  }

  const taskId = (event.payload.taskId as string | undefined);
  if (!taskId) {
    return { action: "dispatch_agent", ok: false, error: "No taskId in event payload for dispatch_agent" };
  }

  const payload: Record<string, unknown> = {
    agentId,
    ...(config.model ? { model: config.model } : {}),
    ...(config.session_type ? { sessionType: config.session_type } : {}),
    ...(config.payload ?? {}),
  };

  const item = enqueue(event.projectId, taskId, payload, undefined, db);

  if (!item) {
    return { action: "dispatch_agent", ok: true, detail: { deduplicated: true, taskId, agentId } };
  }

  return { action: "dispatch_agent", ok: true, detail: { queueItemId: item.id, taskId, agentId } };
}

/** Find an agent by role (extends preset) for a project. */
export function findAgentByRole(projectId: string, role: string): string | undefined {
  try {
    const agentIds = getRegisteredAgentIds();
    for (const agentId of agentIds) {
      const entry = getAgentConfig(agentId);
      if (entry?.projectId !== projectId) continue;

      // Match by extends preset (e.g., "lead" maps to "manager", "worker" maps to "employee")
      const preset = entry.config.extends;
      if (preset === role) return agentId;

      // Common role aliases
      if (role === "lead" && (preset === "manager" || entry.config.coordination?.enabled)) return agentId;
      if (role === "worker" && preset === "employee") return agentId;
      if (role === "verifier" && preset === "verifier") return agentId;

      // Match by explicit role field if present
      if ((entry.config as Record<string, unknown>).role === role) return agentId;
    }
  } catch { /* project module not available */ }
  return undefined;
}

/** Find the first manager agent for a project. */
export function findManagerAgent(projectId: string): string | undefined {
  try {
    const agentIds = getRegisteredAgentIds();
    for (const agentId of agentIds) {
      const entry = getAgentConfig(agentId);
      if (entry?.projectId === projectId && (entry.config.extends === "manager" || entry.config.coordination?.enabled)) {
        return agentId;
      }
    }
  } catch { /* project module not available */ }
  return undefined;
}
