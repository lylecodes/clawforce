/**
 * Clawforce — Protocol lifecycle
 *
 * Structured interaction patterns on top of the unified message store.
 * Protocols: request/response, delegation/report-back, feedback/review.
 * Each protocol type has a defined state machine on the originating
 * message's protocolStatus field.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import type { Message, MessagePriority, MessageType, ProtocolStatus } from "../types.js";
import { createMessage, getMessage, updateProtocolStatus } from "./store.js";

// --- Valid transitions per protocol type ---

const REQUEST_TRANSITIONS: Record<string, ProtocolStatus[]> = {
  awaiting_response: ["resolved", "expired", "cancelled"],
  expired: ["escalated"],
};

const DELEGATION_TRANSITIONS: Record<string, ProtocolStatus[]> = {
  pending_acceptance: ["in_progress", "rejected", "expired"],
  in_progress: ["completed", "expired"],
  expired: ["escalated"],
};

const FEEDBACK_TRANSITIONS: Record<string, ProtocolStatus[]> = {
  awaiting_review: ["approved", "revision_requested", "reviewed", "expired"],
  expired: ["escalated"],
};

const TRANSITIONS_BY_TYPE: Record<string, Record<string, ProtocolStatus[]>> = {
  request: REQUEST_TRANSITIONS,
  delegation: DELEGATION_TRANSITIONS,
  feedback: FEEDBACK_TRANSITIONS,
};

/** Terminal protocol statuses — no further transitions allowed (except expired → escalated). */
const TERMINAL_STATUSES: Set<ProtocolStatus> = new Set([
  "resolved", "completed", "rejected", "approved", "revision_requested", "reviewed",
  "escalated", "cancelled",
]);

// --- Validation ---

export function validateProtocolTransition(
  currentStatus: ProtocolStatus,
  targetStatus: ProtocolStatus,
  protocolType: MessageType,
): { valid: boolean; reason?: string } {
  const transitions = TRANSITIONS_BY_TYPE[protocolType];
  if (!transitions) {
    return { valid: false, reason: `Not a protocol type: ${protocolType}` };
  }

  const allowed = transitions[currentStatus];
  if (!allowed) {
    return { valid: false, reason: `No transitions from status: ${currentStatus}` };
  }

  if (!allowed.includes(targetStatus)) {
    return { valid: false, reason: `Cannot transition from ${currentStatus} to ${targetStatus}. Allowed: ${allowed.join(", ")}` };
  }

  return { valid: true };
}

// --- Initiation functions ---

export function initiateRequest(
  params: {
    fromAgent: string;
    toAgent: string;
    projectId: string;
    content: string;
    priority?: MessagePriority;
    deadlineMs?: number;
    metadata?: Record<string, unknown>;
  },
  dbOverride?: DatabaseSync,
): Message {
  const deadline = params.deadlineMs ? Date.now() + params.deadlineMs : undefined;

  return createMessage({
    fromAgent: params.fromAgent,
    toAgent: params.toAgent,
    projectId: params.projectId,
    type: "request",
    priority: params.priority,
    content: params.content,
    protocolStatus: "awaiting_response",
    responseDeadline: deadline,
    metadata: params.metadata,
  }, dbOverride);
}

export function initiateDelegation(
  params: {
    fromAgent: string;
    toAgent: string;
    projectId: string;
    content: string;
    priority?: MessagePriority;
    deadlineMs?: number;
    taskId?: string;
    metadata?: Record<string, unknown>;
  },
  dbOverride?: DatabaseSync,
): Message {
  const deadline = params.deadlineMs ? Date.now() + params.deadlineMs : undefined;

  return createMessage({
    fromAgent: params.fromAgent,
    toAgent: params.toAgent,
    projectId: params.projectId,
    type: "delegation",
    priority: params.priority,
    content: params.content,
    protocolStatus: "pending_acceptance",
    responseDeadline: deadline,
    metadata: { ...params.metadata, taskId: params.taskId ?? undefined },
  }, dbOverride);
}

export function initiateFeedback(
  params: {
    fromAgent: string;
    toAgent: string;
    projectId: string;
    content: string;
    artifact: string;
    reviewCriteria?: string;
    priority?: MessagePriority;
    deadlineMs?: number;
    metadata?: Record<string, unknown>;
  },
  dbOverride?: DatabaseSync,
): Message {
  const deadline = params.deadlineMs ? Date.now() + params.deadlineMs : undefined;

  return createMessage({
    fromAgent: params.fromAgent,
    toAgent: params.toAgent,
    projectId: params.projectId,
    type: "feedback",
    priority: params.priority,
    content: params.content,
    protocolStatus: "awaiting_review",
    responseDeadline: deadline,
    metadata: {
      ...params.metadata,
      artifact: params.artifact,
      reviewCriteria: params.reviewCriteria ?? undefined,
    },
  }, dbOverride);
}

// --- Response functions ---

export function respondToRequest(
  params: {
    projectId: string;
    originalMessageId: string;
    responderAgent: string;
    content: string;
  },
  dbOverride?: DatabaseSync,
): { original: Message; response: Message } {
  const db = dbOverride ?? getDb(params.projectId);
  const original = getMessage(params.projectId, params.originalMessageId, db);
  if (!original) throw new Error(`Message not found: ${params.originalMessageId}`);

  if (original.type !== "request") {
    throw new Error(`Cannot respond to non-request message (type: ${original.type})`);
  }

  const validation = validateProtocolTransition(original.protocolStatus!, "resolved", "request");
  if (!validation.valid) throw new Error(validation.reason!);

  // Create reply message
  const response = createMessage({
    fromAgent: params.responderAgent,
    toAgent: original.fromAgent,
    projectId: params.projectId,
    type: "request",
    priority: original.priority,
    content: params.content,
    parentMessageId: params.originalMessageId,
  }, db);

  // Transition original to resolved
  updateProtocolStatus(params.originalMessageId, "resolved", {
    ...original.metadata,
    responseSummary: params.content.slice(0, 200),
    responseMessageId: response.id,
  }, db);

  return {
    original: { ...original, protocolStatus: "resolved" },
    response,
  };
}

export function acceptDelegation(
  params: {
    projectId: string;
    originalMessageId: string;
    accepterAgent: string;
    note?: string;
  },
  dbOverride?: DatabaseSync,
): Message {
  const db = dbOverride ?? getDb(params.projectId);
  const original = getMessage(params.projectId, params.originalMessageId, db);
  if (!original) throw new Error(`Message not found: ${params.originalMessageId}`);

  if (original.type !== "delegation") {
    throw new Error(`Cannot accept non-delegation message (type: ${original.type})`);
  }

  const validation = validateProtocolTransition(original.protocolStatus!, "in_progress", "delegation");
  if (!validation.valid) throw new Error(validation.reason!);

  updateProtocolStatus(params.originalMessageId, "in_progress", {
    ...original.metadata,
    acceptanceNote: params.note,
  }, db);

  return { ...original, protocolStatus: "in_progress" };
}

export function rejectDelegation(
  params: {
    projectId: string;
    originalMessageId: string;
    rejecterAgent: string;
    reason: string;
  },
  dbOverride?: DatabaseSync,
): { original: Message; rejection: Message } {
  const db = dbOverride ?? getDb(params.projectId);
  const original = getMessage(params.projectId, params.originalMessageId, db);
  if (!original) throw new Error(`Message not found: ${params.originalMessageId}`);

  if (original.type !== "delegation") {
    throw new Error(`Cannot reject non-delegation message (type: ${original.type})`);
  }

  const validation = validateProtocolTransition(original.protocolStatus!, "rejected", "delegation");
  if (!validation.valid) throw new Error(validation.reason!);

  // Create reply with rejection reason
  const rejection = createMessage({
    fromAgent: params.rejecterAgent,
    toAgent: original.fromAgent,
    projectId: params.projectId,
    type: "delegation",
    priority: original.priority,
    content: params.reason,
    parentMessageId: params.originalMessageId,
  }, db);

  updateProtocolStatus(params.originalMessageId, "rejected", {
    ...original.metadata,
    rejectionReason: params.reason,
    rejectionMessageId: rejection.id,
  }, db);

  return {
    original: { ...original, protocolStatus: "rejected" },
    rejection,
  };
}

export function completeDelegation(
  params: {
    projectId: string;
    originalMessageId: string;
    completerAgent: string;
    content: string;
    resultSummary?: string;
  },
  dbOverride?: DatabaseSync,
): { original: Message; completion: Message } {
  const db = dbOverride ?? getDb(params.projectId);
  const original = getMessage(params.projectId, params.originalMessageId, db);
  if (!original) throw new Error(`Message not found: ${params.originalMessageId}`);

  if (original.type !== "delegation") {
    throw new Error(`Cannot complete non-delegation message (type: ${original.type})`);
  }

  const validation = validateProtocolTransition(original.protocolStatus!, "completed", "delegation");
  if (!validation.valid) throw new Error(validation.reason!);

  // Create completion reply
  const completion = createMessage({
    fromAgent: params.completerAgent,
    toAgent: original.fromAgent,
    projectId: params.projectId,
    type: "delegation",
    priority: original.priority,
    content: params.content,
    parentMessageId: params.originalMessageId,
  }, db);

  updateProtocolStatus(params.originalMessageId, "completed", {
    ...original.metadata,
    resultSummary: params.resultSummary ?? params.content.slice(0, 200),
    completionMessageId: completion.id,
  }, db);

  return {
    original: { ...original, protocolStatus: "completed" },
    completion,
  };
}

export function submitFeedback(
  params: {
    projectId: string;
    originalMessageId: string;
    reviewerAgent: string;
    content: string;
    verdict: "approve" | "revise" | "reject";
  },
  dbOverride?: DatabaseSync,
): { original: Message; review: Message } {
  const db = dbOverride ?? getDb(params.projectId);
  const original = getMessage(params.projectId, params.originalMessageId, db);
  if (!original) throw new Error(`Message not found: ${params.originalMessageId}`);

  if (original.type !== "feedback") {
    throw new Error(`Cannot submit feedback on non-feedback message (type: ${original.type})`);
  }

  const targetStatus: ProtocolStatus =
    params.verdict === "approve" ? "approved" :
    params.verdict === "revise" ? "revision_requested" :
    "reviewed"; // "reject" maps to "reviewed" with verdict in metadata

  const validation = validateProtocolTransition(original.protocolStatus!, targetStatus, "feedback");
  if (!validation.valid) throw new Error(validation.reason!);

  // Create review reply
  const review = createMessage({
    fromAgent: params.reviewerAgent,
    toAgent: original.fromAgent,
    projectId: params.projectId,
    type: "feedback",
    priority: original.priority,
    content: params.content,
    parentMessageId: params.originalMessageId,
  }, db);

  updateProtocolStatus(params.originalMessageId, targetStatus, {
    ...original.metadata,
    feedbackText: params.content.slice(0, 200),
    verdict: params.verdict,
    reviewMessageId: review.id,
  }, db);

  return {
    original: { ...original, protocolStatus: targetStatus },
    review,
  };
}

// --- Query functions ---

/**
 * Get active (non-terminal) protocols for an agent.
 * Returns protocols where agent is sender OR receiver.
 */
export function getActiveProtocols(
  projectId: string,
  agentId: string,
  dbOverride?: DatabaseSync,
): Message[] {
  const db = dbOverride ?? getDb(projectId);
  const terminalList = [...TERMINAL_STATUSES].map((s) => `'${s}'`).join(",");
  const rows = db.prepare(
    `SELECT * FROM messages
     WHERE project_id = ?
       AND protocol_status IS NOT NULL
       AND protocol_status NOT IN (${terminalList})
       AND (from_agent = ? OR to_agent = ?)
     ORDER BY response_deadline ASC, created_at DESC`,
  ).all(projectId, agentId, agentId) as Record<string, unknown>[];

  return rows.map(rowToMessage);
}

/**
 * Get protocols that have passed their deadline and are still in a non-terminal state.
 */
export function getExpiredProtocols(
  projectId: string,
  now?: number,
  dbOverride?: DatabaseSync,
): Message[] {
  const db = dbOverride ?? getDb(projectId);
  const currentTime = now ?? Date.now();
  const terminalList = [...TERMINAL_STATUSES].map((s) => `'${s}'`).join(",");
  const rows = db.prepare(
    `SELECT * FROM messages
     WHERE project_id = ?
       AND protocol_status IS NOT NULL
       AND protocol_status NOT IN (${terminalList})
       AND response_deadline IS NOT NULL
       AND response_deadline < ?
     ORDER BY response_deadline ASC`,
  ).all(projectId, currentTime) as Record<string, unknown>[];

  return rows.map(rowToMessage);
}

// --- Lifecycle functions ---

export function expireProtocol(
  messageId: string,
  dbOverride?: DatabaseSync,
): void {
  updateProtocolStatus(messageId, "expired", undefined, dbOverride);
}

export function escalateProtocol(
  messageId: string,
  escalationMessageId: string,
  dbOverride?: DatabaseSync,
): void {
  if (!dbOverride) return;
  // Read current metadata to merge
  const row = dbOverride.prepare("SELECT metadata FROM messages WHERE id = ?").get(messageId) as Record<string, unknown> | undefined;
  let metadata: Record<string, unknown> = {};
  if (row?.metadata) {
    try { metadata = JSON.parse(row.metadata as string); } catch { /* ignore */ }
  }
  metadata.escalationMessageId = escalationMessageId;
  updateProtocolStatus(messageId, "escalated", metadata, dbOverride);
}

// Re-export rowToMessage for internal use by query functions
function rowToMessage(row: Record<string, unknown>): Message {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata as string); } catch { /* invalid JSON */ }
  }

  return {
    id: row.id as string,
    fromAgent: row.from_agent as string,
    toAgent: row.to_agent as string,
    projectId: row.project_id as string,
    channelId: (row.channel_id as string) ?? null,
    type: row.type as MessageType,
    priority: row.priority as MessagePriority,
    content: row.content as string,
    status: row.status as import("../types.js").MessageStatus,
    parentMessageId: (row.parent_message_id as string) ?? null,
    createdAt: row.created_at as number,
    deliveredAt: (row.delivered_at as number) ?? null,
    readAt: (row.read_at as number) ?? null,
    protocolStatus: (row.protocol_status as ProtocolStatus) ?? null,
    responseDeadline: (row.response_deadline as number) ?? null,
    metadata,
  };
}
