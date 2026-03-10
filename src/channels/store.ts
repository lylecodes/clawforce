/**
 * Clawforce — Channel store
 *
 * CRUD for the channels table. Channels are persistent group
 * communication surfaces — topic-based or meeting-mode.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import type { Channel, ChannelStatus, ChannelType, Message } from "../types.js";

function rowToChannel(row: Record<string, unknown>): Channel {
  let members: string[] = [];
  if (row.members) {
    try { members = JSON.parse(row.members as string); } catch { /* invalid JSON */ }
  }
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata as string); } catch { /* invalid JSON */ }
  }

  return {
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    type: row.type as ChannelType,
    members,
    status: row.status as ChannelStatus,
    createdBy: row.created_by as string,
    createdAt: row.created_at as number,
    concludedAt: (row.concluded_at as number) ?? undefined,
    metadata,
  };
}

export function createChannel(
  params: {
    projectId: string;
    name: string;
    type?: ChannelType;
    members?: string[];
    createdBy: string;
    metadata?: Record<string, unknown>;
  },
  dbOverride?: DatabaseSync,
): Channel {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const now = Date.now();
  const type = params.type ?? "topic";
  const members = params.members ?? [];
  const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;

  // Ensure creator is a member
  if (!members.includes(params.createdBy)) {
    members.push(params.createdBy);
  }

  db.prepare(`
    INSERT INTO channels (id, project_id, name, type, members, status, created_by, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(id, params.projectId, params.name, type, JSON.stringify(members), params.createdBy, now, metadataJson);

  return {
    id,
    projectId: params.projectId,
    name: params.name,
    type,
    members,
    status: "active",
    createdBy: params.createdBy,
    createdAt: now,
    metadata: params.metadata,
  };
}

export function getChannel(projectId: string, channelId: string, dbOverride?: DatabaseSync): Channel | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare("SELECT * FROM channels WHERE id = ? AND project_id = ?").get(channelId, projectId) as Record<string, unknown> | undefined;
  return row ? rowToChannel(row) : null;
}

export function getChannelByName(projectId: string, name: string, dbOverride?: DatabaseSync): Channel | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare("SELECT * FROM channels WHERE project_id = ? AND name = ?").get(projectId, name) as Record<string, unknown> | undefined;
  return row ? rowToChannel(row) : null;
}

export function listChannels(
  projectId: string,
  filter?: {
    type?: ChannelType;
    status?: ChannelStatus;
    memberAgent?: string;
    limit?: number;
  },
  dbOverride?: DatabaseSync,
): Channel[] {
  const db = dbOverride ?? getDb(projectId);
  const conditions = ["project_id = ?"];
  const values: (string | number)[] = [projectId];

  if (filter?.type) {
    conditions.push("type = ?");
    values.push(filter.type);
  }
  if (filter?.status) {
    conditions.push("status = ?");
    values.push(filter.status);
  }

  const limit = filter?.limit ?? 50;
  const sql = `SELECT * FROM channels WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;
  values.push(limit);

  const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];
  let channels = rows.map(rowToChannel);

  // Filter by member in JS (members is a JSON array column)
  if (filter?.memberAgent) {
    channels = channels.filter(ch => ch.members.includes(filter.memberAgent!));
  }

  return channels;
}

export function addMember(projectId: string, channelId: string, agentId: string, dbOverride?: DatabaseSync): Channel {
  const db = dbOverride ?? getDb(projectId);
  const channel = getChannel(projectId, channelId, db);
  if (!channel) throw new Error(`Channel ${channelId} not found`);
  if (channel.members.includes(agentId)) return channel;

  const updated = [...channel.members, agentId];
  db.prepare("UPDATE channels SET members = ? WHERE id = ?").run(JSON.stringify(updated), channelId);
  return { ...channel, members: updated };
}

export function removeMember(projectId: string, channelId: string, agentId: string, dbOverride?: DatabaseSync): Channel {
  const db = dbOverride ?? getDb(projectId);
  const channel = getChannel(projectId, channelId, db);
  if (!channel) throw new Error(`Channel ${channelId} not found`);

  const updated = channel.members.filter(m => m !== agentId);
  db.prepare("UPDATE channels SET members = ? WHERE id = ?").run(JSON.stringify(updated), channelId);
  return { ...channel, members: updated };
}

export function updateChannelMetadata(
  projectId: string,
  channelId: string,
  metadata: Record<string, unknown>,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare("UPDATE channels SET metadata = ? WHERE id = ?").run(JSON.stringify(metadata), channelId);
}

export function concludeChannel(projectId: string, channelId: string, dbOverride?: DatabaseSync): Channel {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  db.prepare("UPDATE channels SET status = 'concluded', concluded_at = ? WHERE id = ? AND project_id = ?").run(now, channelId, projectId);
  const channel = getChannel(projectId, channelId, db);
  if (!channel) throw new Error(`Channel ${channelId} not found`);
  return channel;
}

export function archiveChannel(projectId: string, channelId: string, dbOverride?: DatabaseSync): Channel {
  const db = dbOverride ?? getDb(projectId);
  db.prepare("UPDATE channels SET status = 'archived' WHERE id = ? AND project_id = ?").run(channelId, projectId);
  const channel = getChannel(projectId, channelId, db);
  if (!channel) throw new Error(`Channel ${channelId} not found`);
  return channel;
}

export function getChannelMessages(
  projectId: string,
  channelId: string,
  filter?: { limit?: number; since?: number },
  dbOverride?: DatabaseSync,
): Message[] {
  const db = dbOverride ?? getDb(projectId);
  const conditions = ["channel_id = ?", "project_id = ?"];
  const values: (string | number)[] = [channelId, projectId];

  if (filter?.since) {
    conditions.push("created_at > ?");
    values.push(filter.since);
  }

  const limit = filter?.limit ?? 100;
  const sql = `SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC LIMIT ?`;
  values.push(limit);

  const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];

  // Map rows inline (avoid circular import issues with rowToMessage)
  return rows.map(row => ({
    id: row.id as string,
    fromAgent: row.from_agent as string,
    toAgent: row.to_agent as string,
    projectId: row.project_id as string,
    channelId: (row.channel_id as string) ?? null,
    type: row.type as Message["type"],
    priority: row.priority as Message["priority"],
    content: row.content as string,
    status: row.status as Message["status"],
    parentMessageId: (row.parent_message_id as string) ?? null,
    createdAt: row.created_at as number,
    deliveredAt: (row.delivered_at as number) ?? null,
    readAt: (row.read_at as number) ?? null,
    protocolStatus: (row.protocol_status as Message["protocolStatus"]) ?? null,
    responseDeadline: (row.response_deadline as number) ?? null,
    metadata: row.metadata ? (() => { try { return JSON.parse(row.metadata as string); } catch { return null; } })() : null,
  }));
}
