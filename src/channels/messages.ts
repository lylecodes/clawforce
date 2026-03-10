/**
 * Clawforce — Channel message helpers
 *
 * Convenience functions for sending messages to channels
 * and building transcripts for context injection.
 */

import type { DatabaseSync } from "node:sqlite";
import { createMessage } from "../messaging/store.js";
import type { Message, MessageType } from "../types.js";
import { getChannel, getChannelMessages } from "./store.js";

/**
 * Send a message to a channel.
 * Uses the unified messages table with channel_id set.
 * toAgent is set to "channel:<name>" for broadcast semantics.
 */
export function sendChannelMessage(
  params: {
    fromAgent: string;
    channelId: string;
    projectId: string;
    content: string;
    type?: MessageType;
    metadata?: Record<string, unknown>;
  },
  dbOverride?: DatabaseSync,
): Message {
  const channel = getChannel(params.projectId, params.channelId, dbOverride);
  const channelName = channel?.name ?? params.channelId;
  const type = params.type ?? (channel?.type === "meeting" ? "meeting" : "direct");

  return createMessage({
    fromAgent: params.fromAgent,
    toAgent: `channel:${channelName}`,
    projectId: params.projectId,
    channelId: params.channelId,
    type,
    content: params.content,
    metadata: params.metadata,
  }, dbOverride);
}

/**
 * Build a formatted markdown transcript of channel messages.
 * Used for context injection into agent sessions.
 */
export function buildChannelTranscript(
  projectId: string,
  channelId: string,
  opts?: { maxChars?: number; since?: number; limit?: number },
  dbOverride?: DatabaseSync,
): string {
  const maxChars = opts?.maxChars ?? 5000;
  const messages = getChannelMessages(projectId, channelId, {
    limit: opts?.limit ?? 100,
    since: opts?.since,
  }, dbOverride);

  if (messages.length === 0) return "";

  const lines: string[] = [];
  let totalChars = 0;

  for (const msg of messages) {
    const timestamp = new Date(msg.createdAt).toISOString().slice(0, 16).replace("T", " ");
    const line = `[${timestamp}] **${msg.fromAgent}**: ${msg.content}`;

    if (totalChars + line.length > maxChars) {
      lines.unshift(`_...${messages.length - lines.length} earlier message(s) truncated..._`);
      break;
    }

    lines.push(line);
    totalChars += line.length;
  }

  return lines.join("\n");
}
