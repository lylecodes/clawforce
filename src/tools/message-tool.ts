/**
 * Clawforce — Message tool
 *
 * Agent communication tool. Actions: send, list, read, reply,
 * plus protocol actions: request, delegate, request_feedback,
 * respond, accept, reject, complete, submit_review, list_protocols.
 */

import { Type } from "@sinclair/typebox";
import { ingestEvent } from "../events/store.js";
import { createMessage, getMessage, listMessages, markRead, getThread } from "../messaging/store.js";
import {
  initiateRequest,
  initiateDelegation,
  initiateFeedback,
  respondToRequest,
  acceptDelegation,
  rejectDelegation,
  completeDelegation,
  submitFeedback,
  getActiveProtocols,
} from "../messaging/protocols.js";
import { notifyMessage } from "../messaging/notify.js";
import { stringEnum } from "../schema-helpers.js";
import type { MessageType, MessagePriority } from "../types.js";
import { MESSAGE_TYPES, MESSAGE_PRIORITIES } from "../types.js";
import type { ToolResult } from "./common.js";
import { jsonResult, readNumberParam, readStringParam, resolveProjectId, safeExecute } from "./common.js";

const MESSAGE_ACTIONS = [
  "send", "list", "read", "reply",
  "request", "delegate", "request_feedback",
  "respond", "accept", "reject", "complete", "submit_review",
  "list_protocols",
] as const;

const ClawforceMessageSchema = Type.Object({
  action: stringEnum(MESSAGE_ACTIONS, { description: "Action to perform." }),
  project_id: Type.Optional(Type.String({ description: "Project identifier." })),
  // send params
  to: Type.Optional(Type.String({ description: "Recipient agent ID (for send/request/delegate/request_feedback)." })),
  content: Type.Optional(Type.String({ description: "Message content (for send/reply/respond/complete/submit_review)." })),
  type: Type.Optional(Type.String({ description: "Message type: direct, request, delegation, notification (default: direct)." })),
  priority: Type.Optional(Type.String({ description: "Priority: low, normal, high, urgent (default: normal)." })),
  // list params
  status: Type.Optional(Type.String({ description: "Filter by status: queued, delivered, read (for list)." })),
  filter_type: Type.Optional(Type.String({ description: "Filter by message type (for list)." })),
  limit: Type.Optional(Type.Number({ description: "Max results (for list, default 20)." })),
  // read/reply/protocol params
  message_id: Type.Optional(Type.String({ description: "Message ID (for read/reply/respond/accept/reject/complete/submit_review)." })),
  // protocol params
  deadline: Type.Optional(Type.Number({ description: "Response deadline in minutes from now (for request/delegate/request_feedback)." })),
  artifact: Type.Optional(Type.String({ description: "Artifact to review: file path, task ID, etc. (for request_feedback)." })),
  review_criteria: Type.Optional(Type.String({ description: "What to evaluate (for request_feedback)." })),
  verdict: Type.Optional(Type.String({ description: "Review verdict: approve, revise, reject (for submit_review)." })),
  task_id: Type.Optional(Type.String({ description: "Linked task ID (for delegate)." })),
  note: Type.Optional(Type.String({ description: "Acceptance note (for accept)." })),
  reason: Type.Optional(Type.String({ description: "Rejection reason (for reject)." })),
});

export function createClawforceMessageTool(options?: {
  agentSessionKey?: string;
  agentId?: string;
  projectId?: string;
}) {
  return {
    label: "Messaging",
    name: "clawforce_message",
    description:
      "Agent communication system. " +
      "send: Send a direct message. " +
      "list: List inbox. " +
      "read: Read a message. " +
      "reply: Reply to a message. " +
      "request: Send a structured request expecting a response (with optional deadline). " +
      "delegate: Delegate work to another agent (with acceptance flow). " +
      "request_feedback: Request review of a work product. " +
      "respond: Respond to a request protocol. " +
      "accept/reject: Accept or reject a delegation. " +
      "complete: Complete delegated work with results. " +
      "submit_review: Submit feedback with verdict (approve/revise/reject). " +
      "list_protocols: List active protocols you're involved in.",
    parameters: ClawforceMessageSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      return safeExecute(async () => {
        const action = readStringParam(params, "action", { required: true })!;
        const resolved = resolveProjectId(params, options?.projectId);
        if (resolved.error) return jsonResult({ ok: false, reason: resolved.error });
        const projectId = resolved.projectId!;
        const actor = options?.agentId ?? options?.agentSessionKey ?? "unknown";

        switch (action) {
          case "send":
            return handleSend(projectId, actor, params);
          case "list":
            return handleList(projectId, actor, params);
          case "read":
            return handleRead(projectId, params);
          case "reply":
            return handleReply(projectId, actor, params);
          case "request":
            return handleRequest(projectId, actor, params);
          case "delegate":
            return handleDelegate(projectId, actor, params);
          case "request_feedback":
            return handleRequestFeedback(projectId, actor, params);
          case "respond":
            return handleRespond(projectId, actor, params);
          case "accept":
            return handleAccept(projectId, actor, params);
          case "reject":
            return handleReject(projectId, actor, params);
          case "complete":
            return handleComplete(projectId, actor, params);
          case "submit_review":
            return handleSubmitReview(projectId, actor, params);
          case "list_protocols":
            return handleListProtocols(projectId, actor);
          default:
            return jsonResult({ ok: false, reason: `Unknown action: ${action}` });
        }
      });
    },
  };
}

// --- Existing handlers ---

function handleSend(
  projectId: string,
  actor: string,
  params: Record<string, unknown>,
): ToolResult {
  const to = readStringParam(params, "to", { required: true });
  if (!to) return jsonResult({ ok: false, reason: "Missing required parameter: to" });
  const content = readStringParam(params, "content", { required: true });
  if (!content) return jsonResult({ ok: false, reason: "Missing required parameter: content" });

  const typeRaw = readStringParam(params, "type") ?? "direct";
  if (!MESSAGE_TYPES.includes(typeRaw as MessageType)) {
    return jsonResult({ ok: false, reason: `Invalid message type: ${typeRaw}. Must be one of: ${MESSAGE_TYPES.join(", ")}` });
  }
  const type = typeRaw as MessageType;

  const priorityRaw = readStringParam(params, "priority") ?? "normal";
  if (!MESSAGE_PRIORITIES.includes(priorityRaw as MessagePriority)) {
    return jsonResult({ ok: false, reason: `Invalid priority: ${priorityRaw}. Must be one of: ${MESSAGE_PRIORITIES.join(", ")}` });
  }
  const priority = priorityRaw as MessagePriority;

  const msg = createMessage({
    fromAgent: actor,
    toAgent: to,
    projectId,
    type,
    priority,
    content,
  });

  notifyMessage(msg).catch(() => {});

  try {
    ingestEvent(projectId, "message_sent", "tool", {
      messageId: msg.id, fromAgent: actor, toAgent: to, type, priority,
    });
  } catch { /* best effort */ }

  return jsonResult({
    ok: true,
    message: { id: msg.id, to: msg.toAgent, type: msg.type, priority: msg.priority, createdAt: msg.createdAt },
  });
}

function handleList(
  projectId: string,
  actor: string,
  params: Record<string, unknown>,
): ToolResult {
  const statusFilter = readStringParam(params, "status") as import("../types.js").MessageStatus | undefined;
  const typeFilter = readStringParam(params, "filter_type") as MessageType | undefined;
  const limit = readNumberParam(params, "limit") ?? 20;

  const messages = listMessages(projectId, actor, {
    status: statusFilter,
    type: typeFilter,
    limit,
  });

  return jsonResult({
    ok: true,
    messages: messages.map((m) => ({
      id: m.id,
      from: m.fromAgent,
      type: m.type,
      priority: m.priority,
      status: m.status,
      preview: m.content.length > 100 ? m.content.slice(0, 97) + "..." : m.content,
      createdAt: m.createdAt,
      parentMessageId: m.parentMessageId,
      protocolStatus: m.protocolStatus,
    })),
    count: messages.length,
  });
}

function handleRead(
  projectId: string,
  params: Record<string, unknown>,
): ToolResult {
  const messageId = readStringParam(params, "message_id", { required: true });
  if (!messageId) return jsonResult({ ok: false, reason: "Missing required parameter: message_id" });

  const msg = getMessage(projectId, messageId);
  if (!msg) return jsonResult({ ok: false, reason: `Message not found: ${messageId}` });

  markRead(projectId, messageId);

  const thread = msg.parentMessageId ? getThread(projectId, msg.parentMessageId) : [];

  return jsonResult({
    ok: true,
    message: {
      id: msg.id,
      from: msg.fromAgent,
      to: msg.toAgent,
      type: msg.type,
      priority: msg.priority,
      content: msg.content,
      status: "read",
      createdAt: msg.createdAt,
      parentMessageId: msg.parentMessageId,
      protocolStatus: msg.protocolStatus,
      responseDeadline: msg.responseDeadline,
      metadata: msg.metadata,
    },
    thread: thread.length > 0
      ? thread.map((t) => ({
          id: t.id, from: t.fromAgent, content: t.content, createdAt: t.createdAt,
        }))
      : undefined,
  });
}

function handleReply(
  projectId: string,
  actor: string,
  params: Record<string, unknown>,
): ToolResult {
  const messageId = readStringParam(params, "message_id", { required: true });
  if (!messageId) return jsonResult({ ok: false, reason: "Missing required parameter: message_id" });
  const content = readStringParam(params, "content", { required: true });
  if (!content) return jsonResult({ ok: false, reason: "Missing required parameter: content" });

  const original = getMessage(projectId, messageId);
  if (!original) return jsonResult({ ok: false, reason: `Original message not found: ${messageId}` });

  const reply = createMessage({
    fromAgent: actor,
    toAgent: original.fromAgent,
    projectId,
    type: original.type,
    priority: original.priority,
    content,
    parentMessageId: messageId,
  });

  notifyMessage(reply).catch(() => {});

  try {
    ingestEvent(projectId, "message_sent", "tool", {
      messageId: reply.id, fromAgent: actor, toAgent: original.fromAgent,
      type: reply.type, priority: reply.priority, inReplyTo: messageId,
    });
  } catch { /* best effort */ }

  return jsonResult({
    ok: true,
    message: { id: reply.id, to: reply.toAgent, type: reply.type, inReplyTo: messageId, createdAt: reply.createdAt },
  });
}

// --- Protocol handlers ---

function parsePriority(params: Record<string, unknown>): MessagePriority | null {
  const raw = readStringParam(params, "priority");
  if (!raw) return null;
  if (!MESSAGE_PRIORITIES.includes(raw as MessagePriority)) return null;
  return raw as MessagePriority;
}

function handleRequest(
  projectId: string,
  actor: string,
  params: Record<string, unknown>,
): ToolResult {
  const to = readStringParam(params, "to");
  if (!to) return jsonResult({ ok: false, reason: "Missing required parameter: to" });
  const content = readStringParam(params, "content");
  if (!content) return jsonResult({ ok: false, reason: "Missing required parameter: content" });

  const deadlineMinutes = readNumberParam(params, "deadline");
  const deadlineMs = deadlineMinutes ? deadlineMinutes * 60 * 1000 : undefined;
  const priority = parsePriority(params) ?? undefined;

  const msg = initiateRequest({
    fromAgent: actor, toAgent: to, projectId, content, priority, deadlineMs,
  });

  notifyMessage(msg).catch(() => {});
  try {
    ingestEvent(projectId, "protocol_started", "tool", {
      messageId: msg.id, protocolType: "request", fromAgent: actor, toAgent: to,
    });
  } catch { /* best effort */ }

  return jsonResult({
    ok: true,
    message: {
      id: msg.id, to: msg.toAgent, type: "request",
      protocolStatus: msg.protocolStatus,
      responseDeadline: msg.responseDeadline,
      createdAt: msg.createdAt,
    },
  });
}

function handleDelegate(
  projectId: string,
  actor: string,
  params: Record<string, unknown>,
): ToolResult {
  const to = readStringParam(params, "to");
  if (!to) return jsonResult({ ok: false, reason: "Missing required parameter: to" });
  const content = readStringParam(params, "content");
  if (!content) return jsonResult({ ok: false, reason: "Missing required parameter: content" });

  const deadlineMinutes = readNumberParam(params, "deadline");
  const deadlineMs = deadlineMinutes ? deadlineMinutes * 60 * 1000 : undefined;
  const taskId = readStringParam(params, "task_id") ?? undefined;
  const priority = parsePriority(params) ?? undefined;

  const msg = initiateDelegation({
    fromAgent: actor, toAgent: to, projectId, content, priority, deadlineMs, taskId,
  });

  notifyMessage(msg).catch(() => {});
  try {
    ingestEvent(projectId, "protocol_started", "tool", {
      messageId: msg.id, protocolType: "delegation", fromAgent: actor, toAgent: to,
    });
  } catch { /* best effort */ }

  return jsonResult({
    ok: true,
    message: {
      id: msg.id, to: msg.toAgent, type: "delegation",
      protocolStatus: msg.protocolStatus,
      responseDeadline: msg.responseDeadline,
      createdAt: msg.createdAt,
    },
  });
}

function handleRequestFeedback(
  projectId: string,
  actor: string,
  params: Record<string, unknown>,
): ToolResult {
  const to = readStringParam(params, "to");
  if (!to) return jsonResult({ ok: false, reason: "Missing required parameter: to" });
  const content = readStringParam(params, "content");
  if (!content) return jsonResult({ ok: false, reason: "Missing required parameter: content" });
  const artifact = readStringParam(params, "artifact");
  if (!artifact) return jsonResult({ ok: false, reason: "Missing required parameter: artifact" });

  const deadlineMinutes = readNumberParam(params, "deadline");
  const deadlineMs = deadlineMinutes ? deadlineMinutes * 60 * 1000 : undefined;
  const reviewCriteria = readStringParam(params, "review_criteria") ?? undefined;
  const priority = parsePriority(params) ?? undefined;

  const msg = initiateFeedback({
    fromAgent: actor, toAgent: to, projectId, content, priority, deadlineMs,
    artifact, reviewCriteria,
  });

  notifyMessage(msg).catch(() => {});
  try {
    ingestEvent(projectId, "protocol_started", "tool", {
      messageId: msg.id, protocolType: "feedback", fromAgent: actor, toAgent: to,
    });
  } catch { /* best effort */ }

  return jsonResult({
    ok: true,
    message: {
      id: msg.id, to: msg.toAgent, type: "feedback",
      protocolStatus: msg.protocolStatus,
      responseDeadline: msg.responseDeadline,
      createdAt: msg.createdAt,
    },
  });
}

function handleRespond(
  projectId: string,
  actor: string,
  params: Record<string, unknown>,
): ToolResult {
  const messageId = readStringParam(params, "message_id");
  if (!messageId) return jsonResult({ ok: false, reason: "Missing required parameter: message_id" });
  const content = readStringParam(params, "content");
  if (!content) return jsonResult({ ok: false, reason: "Missing required parameter: content" });

  try {
    const { original, response } = respondToRequest({
      projectId, originalMessageId: messageId, responderAgent: actor, content,
    });

    notifyMessage(response).catch(() => {});
    try {
      ingestEvent(projectId, "protocol_responded", "tool", {
        messageId: original.id, responseMessageId: response.id,
        protocolType: "request", fromAgent: actor, toAgent: original.fromAgent,
      });
    } catch { /* best effort */ }

    return jsonResult({
      ok: true,
      message: { id: response.id, to: response.toAgent, protocolStatus: "resolved", inReplyTo: messageId },
    });
  } catch (err) {
    return jsonResult({ ok: false, reason: (err as Error).message });
  }
}

function handleAccept(
  projectId: string,
  actor: string,
  params: Record<string, unknown>,
): ToolResult {
  const messageId = readStringParam(params, "message_id");
  if (!messageId) return jsonResult({ ok: false, reason: "Missing required parameter: message_id" });
  const note = readStringParam(params, "note") ?? undefined;

  try {
    const updated = acceptDelegation({
      projectId, originalMessageId: messageId, accepterAgent: actor, note,
    });

    try {
      ingestEvent(projectId, "protocol_responded", "tool", {
        messageId, protocolType: "delegation", protocolStatus: "in_progress",
        fromAgent: actor, toAgent: updated.fromAgent,
      });
    } catch { /* best effort */ }

    return jsonResult({
      ok: true,
      message: { id: messageId, protocolStatus: "in_progress" },
    });
  } catch (err) {
    return jsonResult({ ok: false, reason: (err as Error).message });
  }
}

function handleReject(
  projectId: string,
  actor: string,
  params: Record<string, unknown>,
): ToolResult {
  const messageId = readStringParam(params, "message_id");
  if (!messageId) return jsonResult({ ok: false, reason: "Missing required parameter: message_id" });
  const reason = readStringParam(params, "reason");
  if (!reason) return jsonResult({ ok: false, reason: "Missing required parameter: reason" });

  try {
    const { original, rejection } = rejectDelegation({
      projectId, originalMessageId: messageId, rejecterAgent: actor, reason,
    });

    notifyMessage(rejection).catch(() => {});
    try {
      ingestEvent(projectId, "protocol_responded", "tool", {
        messageId, protocolType: "delegation", protocolStatus: "rejected",
        fromAgent: actor, toAgent: original.fromAgent,
      });
    } catch { /* best effort */ }

    return jsonResult({
      ok: true,
      message: { id: messageId, protocolStatus: "rejected", rejectionId: rejection.id },
    });
  } catch (err) {
    return jsonResult({ ok: false, reason: (err as Error).message });
  }
}

function handleComplete(
  projectId: string,
  actor: string,
  params: Record<string, unknown>,
): ToolResult {
  const messageId = readStringParam(params, "message_id");
  if (!messageId) return jsonResult({ ok: false, reason: "Missing required parameter: message_id" });
  const content = readStringParam(params, "content");
  if (!content) return jsonResult({ ok: false, reason: "Missing required parameter: content" });

  try {
    const { original, completion } = completeDelegation({
      projectId, originalMessageId: messageId, completerAgent: actor, content,
    });

    notifyMessage(completion).catch(() => {});
    try {
      ingestEvent(projectId, "protocol_completed", "tool", {
        messageId, completionMessageId: completion.id,
        protocolType: "delegation", fromAgent: actor, toAgent: original.fromAgent,
      });
    } catch { /* best effort */ }

    return jsonResult({
      ok: true,
      message: { id: messageId, protocolStatus: "completed", completionId: completion.id },
    });
  } catch (err) {
    return jsonResult({ ok: false, reason: (err as Error).message });
  }
}

function handleSubmitReview(
  projectId: string,
  actor: string,
  params: Record<string, unknown>,
): ToolResult {
  const messageId = readStringParam(params, "message_id");
  if (!messageId) return jsonResult({ ok: false, reason: "Missing required parameter: message_id" });
  const content = readStringParam(params, "content");
  if (!content) return jsonResult({ ok: false, reason: "Missing required parameter: content" });
  const verdict = readStringParam(params, "verdict");
  if (!verdict || !["approve", "revise", "reject"].includes(verdict)) {
    return jsonResult({ ok: false, reason: "Invalid or missing verdict. Must be: approve, revise, reject" });
  }

  try {
    const { original, review } = submitFeedback({
      projectId, originalMessageId: messageId, reviewerAgent: actor,
      content, verdict: verdict as "approve" | "revise" | "reject",
    });

    notifyMessage(review).catch(() => {});
    try {
      ingestEvent(projectId, "protocol_completed", "tool", {
        messageId, reviewMessageId: review.id,
        protocolType: "feedback", verdict, fromAgent: actor, toAgent: original.fromAgent,
      });
    } catch { /* best effort */ }

    return jsonResult({
      ok: true,
      message: { id: messageId, protocolStatus: original.protocolStatus, verdict, reviewId: review.id },
    });
  } catch (err) {
    return jsonResult({ ok: false, reason: (err as Error).message });
  }
}

function handleListProtocols(
  projectId: string,
  actor: string,
): ToolResult {
  const protocols = getActiveProtocols(projectId, actor);

  return jsonResult({
    ok: true,
    protocols: protocols.map((m) => ({
      id: m.id,
      type: m.type,
      from: m.fromAgent,
      to: m.toAgent,
      protocolStatus: m.protocolStatus,
      responseDeadline: m.responseDeadline,
      preview: m.content.length > 100 ? m.content.slice(0, 97) + "..." : m.content,
      createdAt: m.createdAt,
    })),
    count: protocols.length,
  });
}
