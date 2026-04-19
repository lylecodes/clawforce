/**
 * Clawforce — Message store
 *
 * Pure CRUD for the unified messages table.
 * All agent communication (DMs, escalations, delegation, notifications)
 * flows through this store.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { checkMessageRate } from "../safety.js";
import type { Message, MessagePriority, MessageStatus, MessageType, ProtocolStatus } from "../types.js";

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
    status: row.status as MessageStatus,
    parentMessageId: (row.parent_message_id as string) ?? null,
    createdAt: row.created_at as number,
    deliveredAt: (row.delivered_at as number) ?? null,
    readAt: (row.read_at as number) ?? null,
    protocolStatus: (row.protocol_status as ProtocolStatus) ?? null,
    responseDeadline: (row.response_deadline as number) ?? null,
    metadata,
  };
}

/**
 * Create a new message.
 */
export function createMessage(
  params: {
    fromAgent: string;
    toAgent: string;
    projectId: string;
    type?: MessageType;
    priority?: MessagePriority;
    content: string;
    channelId?: string;
    parentMessageId?: string;
    protocolStatus?: ProtocolStatus;
    responseDeadline?: number;
    metadata?: Record<string, unknown>;
  },
  dbOverride?: DatabaseSync,
): Message {
  const db = dbOverride ?? getDb(params.projectId);

  // Rate limit channel messages
  if (params.channelId) {
    const rateCheck = checkMessageRate(params.projectId, params.channelId);
    if (!rateCheck.ok) {
      throw new Error(rateCheck.reason);
    }
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const type = params.type ?? "direct";
  const priority = params.priority ?? "normal";
  const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;

  db.prepare(`
    INSERT INTO messages (id, from_agent, to_agent, project_id, channel_id, type, priority, content, status, parent_message_id, created_at, protocol_status, response_deadline, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
  `).run(id, params.fromAgent, params.toAgent, params.projectId, params.channelId ?? null, type, priority, params.content, params.parentMessageId ?? null, now, params.protocolStatus ?? null, params.responseDeadline ?? null, metadataJson);

  return {
    id,
    fromAgent: params.fromAgent,
    toAgent: params.toAgent,
    projectId: params.projectId,
    channelId: params.channelId ?? null,
    type,
    priority,
    content: params.content,
    status: "queued",
    parentMessageId: params.parentMessageId ?? null,
    createdAt: now,
    deliveredAt: null,
    readAt: null,
    protocolStatus: params.protocolStatus ?? null,
    responseDeadline: params.responseDeadline ?? null,
    metadata: params.metadata ?? null,
  };
}

/**
 * Get a single message by ID.
 */
export function getMessage(
  projectId: string,
  id: string,
  dbOverride?: DatabaseSync,
): Message | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare("SELECT * FROM messages WHERE id = ? AND project_id = ?").get(id, projectId) as Record<string, unknown> | undefined;
  return row ? rowToMessage(row) : null;
}

/**
 * Get pending (queued) messages for an agent.
 */
export function getPendingMessages(
  projectId: string,
  toAgent: string,
  dbOverride?: DatabaseSync,
): Message[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM messages WHERE project_id = ? AND to_agent = ? AND status = 'queued' ORDER BY created_at ASC",
  ).all(projectId, toAgent) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

/**
 * List messages for a recipient with optional filters.
 */
export function listMessages(
  projectId: string,
  toAgent: string,
  filter?: { status?: MessageStatus; type?: MessageType; limit?: number; since?: number },
  dbOverride?: DatabaseSync,
): Message[] {
  const db = dbOverride ?? getDb(projectId);
  let sql = "SELECT * FROM messages WHERE project_id = ? AND to_agent = ?";
  const params: (string | number)[] = [projectId, toAgent];

  if (filter?.status) {
    sql += " AND status = ?";
    params.push(filter.status);
  }
  if (filter?.type) {
    sql += " AND type = ?";
    params.push(filter.type);
  }
  if (filter?.since) {
    sql += " AND created_at > ?";
    params.push(filter.since);
  }

  sql += " ORDER BY created_at DESC";

  const limit = filter?.limit ?? 50;
  sql += " LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

/**
 * List sent messages from an agent.
 */
export function listSentMessages(
  projectId: string,
  fromAgent: string,
  filter?: { limit?: number; since?: number },
  dbOverride?: DatabaseSync,
): Message[] {
  const db = dbOverride ?? getDb(projectId);
  let sql = "SELECT * FROM messages WHERE project_id = ? AND from_agent = ?";
  const params: (string | number)[] = [projectId, fromAgent];

  if (filter?.since) {
    sql += " AND created_at > ?";
    params.push(filter.since);
  }

  sql += " ORDER BY created_at DESC";

  const limit = filter?.limit ?? 50;
  sql += " LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

/**
 * Mark a message as delivered.
 */
export function markDelivered(
  id: string,
  dbOverride?: DatabaseSync,
): void {
  // We need the projectId to get the right DB, but for simplicity when called
  // from context injection (which already has the DB), use dbOverride.
  // When dbOverride is not provided, scan all project DBs (not ideal, but
  // the typical call site always provides dbOverride).
  if (!dbOverride) return;
  dbOverride.prepare(
    "UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ?",
  ).run(Date.now(), id);
}

/**
 * Mark multiple messages as delivered in bulk.
 */
export function markBulkDelivered(
  ids: string[],
  dbOverride?: DatabaseSync,
): void {
  if (!dbOverride || ids.length === 0) return;
  const now = Date.now();
  const stmt = dbOverride.prepare(
    "UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ?",
  );
  for (const id of ids) {
    stmt.run(now, id);
  }
}

/**
 * Mark a message as read (read receipt).
 */
export function markRead(
  projectId: string,
  id: string,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare(
    "UPDATE messages SET status = 'read', read_at = ? WHERE id = ? AND project_id = ?",
  ).run(Date.now(), id, projectId);
}

/**
 * Get conversation thread (message + all replies).
 */
export function getThread(
  projectId: string,
  parentMessageId: string,
  dbOverride?: DatabaseSync,
): Message[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM messages WHERE project_id = ? AND parent_message_id = ? ORDER BY created_at ASC",
  ).all(projectId, parentMessageId) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

/**
 * Search messages across agents (for dashboard).
 */
export function searchMessages(
  projectId: string,
  filter?: {
    agentId?: string;
    type?: MessageType;
    status?: MessageStatus;
    since?: number;
    limit?: number;
  },
  dbOverride?: DatabaseSync,
): { messages: Message[]; hasMore: boolean } {
  const db = dbOverride ?? getDb(projectId);
  let sql = "SELECT * FROM messages WHERE project_id = ?";
  const params: (string | number)[] = [projectId];

  if (filter?.agentId) {
    sql += " AND (from_agent = ? OR to_agent = ?)";
    params.push(filter.agentId, filter.agentId);
  }
  if (filter?.type) {
    sql += " AND type = ?";
    params.push(filter.type);
  }
  if (filter?.status) {
    sql += " AND status = ?";
    params.push(filter.status);
  }
  if (filter?.since) {
    sql += " AND created_at > ?";
    params.push(filter.since);
  }

  sql += " ORDER BY created_at DESC";

  const limit = filter?.limit ?? 50;
  sql += " LIMIT ?";
  params.push(limit + 1);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  const hasMore = rows.length > limit;

  return {
    messages: rows.slice(0, limit).map(rowToMessage),
    hasMore,
  };
}

/**
 * Update the protocol status and optionally metadata on a message.
 */
export function updateProtocolStatus(
  messageId: string,
  protocolStatus: ProtocolStatus,
  metadata?: Record<string, unknown>,
  dbOverride?: DatabaseSync,
): void {
  if (!dbOverride) return;
  if (metadata) {
    dbOverride.prepare(
      "UPDATE messages SET protocol_status = ?, metadata = ? WHERE id = ?",
    ).run(protocolStatus, JSON.stringify(metadata), messageId);
  } else {
    dbOverride.prepare(
      "UPDATE messages SET protocol_status = ? WHERE id = ?",
    ).run(protocolStatus, messageId);
  }
}
