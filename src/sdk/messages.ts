/**
 * Clawforce SDK — Messages Namespace
 *
 * Wraps internal message store operations with the public SDK vocabulary:
 *   from → fromAgent  (internal)
 *   to   → toAgent    (internal)
 *
 * Internal Message objects use fromAgent/toAgent; the public Message type
 * defined in sdk/types.ts uses from/to.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import {
  createMessage as internalCreateMessage,
  getMessage as internalGetMessage,
  listMessages as internalListMessages,
  searchMessages as internalSearchMessages,
  getPendingMessages as internalGetPendingMessages,
  markDelivered as internalMarkDelivered,
  markRead as internalMarkRead,
  getThread as internalGetThread,
} from "../messaging/store.js";
import type { Message as InternalMessage, MessageType, MessageStatus } from "../types.js";
import type { Message, MessageParams } from "./types.js";

/** Map internal Message (fromAgent/toAgent) to public SDK Message (from/to). */
function toPublicMessage(m: InternalMessage): Message {
  return {
    id: m.id,
    from: m.fromAgent,
    to: m.toAgent,
    content: m.content,
    type: m.type,
    status: m.status,
    createdAt: m.createdAt,
  };
}

export class MessagesNamespace {
  constructor(readonly domain: string) {}

  /**
   * Send a message. Maps `from` → `fromAgent`, `to` → `toAgent`.
   *
   * @param params - Public MessageParams (uses from/to vocabulary)
   * @param opts.db - Optional DB override for testing
   */
  send(params: MessageParams, opts?: { db?: DatabaseSync }): Message {
    const internal = internalCreateMessage(
      {
        fromAgent: params.from,
        toAgent: params.to,
        projectId: this.domain,
        content: params.content,
        type: params.type as MessageType | undefined,
        priority: params.priority as any,
        channelId: params.channelId,
        parentMessageId: params.parentMessageId,
        metadata: params.metadata,
      },
      opts?.db,
    );
    return toPublicMessage(internal);
  }

  /**
   * Get a single message by ID. Returns undefined if not found.
   *
   * @param messageId - The message ID to look up
   * @param opts.db   - Optional DB override for testing
   */
  get(messageId: string, opts?: { db?: DatabaseSync }): Message | undefined {
    const internal = internalGetMessage(this.domain, messageId, opts?.db);
    return internal ? toPublicMessage(internal) : undefined;
  }

  /**
   * List messages with optional filters.
   *
   * When `to` is provided, uses the optimised recipient index (listMessages).
   * When only `from` is provided, falls back to searchMessages filtering by agentId
   * and post-filters to only sent messages.
   *
   * @param filters.from   - Filter by sender agent ID
   * @param filters.to     - Filter by recipient agent ID
   * @param filters.type   - Filter by message type
   * @param filters.status - Filter by message status
   * @param filters.limit  - Maximum number of results (default: 50)
   * @param opts.db        - Optional DB override for testing
   */
  list(
    filters?: {
      from?: string;
      to?: string;
      type?: string;
      status?: string;
      limit?: number;
    },
    opts?: { db?: DatabaseSync },
  ): Message[] {
    if (filters?.to) {
      // Use recipient-optimised query
      const internal = internalListMessages(
        this.domain,
        filters.to,
        {
          status: filters.status as MessageStatus | undefined,
          type: filters.type as MessageType | undefined,
          limit: filters.limit,
        },
        opts?.db,
      );
      // Post-filter by from if provided
      const results = filters.from
        ? internal.filter((m) => m.fromAgent === filters.from)
        : internal;
      return results.map(toPublicMessage);
    }

    // No `to` specified — use searchMessages (scans all messages in project)
    const agentId = filters?.from;
    const { messages } = internalSearchMessages(
      this.domain,
      {
        agentId,
        type: filters?.type as MessageType | undefined,
        status: filters?.status as MessageStatus | undefined,
        limit: filters?.limit,
      },
      opts?.db,
    );

    // If filtering by from only, keep only messages where from_agent matches
    const results = agentId
      ? messages.filter((m) => m.fromAgent === agentId)
      : messages;
    return results.map(toPublicMessage);
  }

  /**
   * Search messages across all agents in the project.
   *
   * @param query     - Agent ID to search around (messages sent or received)
   * @param limit     - Maximum number of results (default: 50)
   * @param opts.db   - Optional DB override for testing
   */
  search(query: string, limit?: number, opts?: { db?: DatabaseSync }): Message[] {
    const { messages } = internalSearchMessages(
      this.domain,
      { agentId: query, limit },
      opts?.db,
    );
    return messages.map(toPublicMessage);
  }

  /**
   * Get pending (queued) messages for an agent.
   *
   * @param agentId - The recipient agent ID
   * @param opts.db - Optional DB override for testing
   */
  pending(agentId: string, opts?: { db?: DatabaseSync }): Message[] {
    const internal = internalGetPendingMessages(this.domain, agentId, opts?.db);
    return internal.map(toPublicMessage);
  }

  /**
   * Mark a message as delivered.
   *
   * Note: the internal markDelivered requires a dbOverride to function
   * (it is a no-op without one, as it has no way to resolve the project DB by
   * message ID alone). Always pass opts.db in production code.
   *
   * @param messageId - The message ID to mark delivered
   * @param opts.db   - DB override (required for the update to take effect)
   */
  markDelivered(messageId: string, opts?: { db?: DatabaseSync }): void {
    internalMarkDelivered(messageId, opts?.db);
  }

  /**
   * Mark a message as read.
   *
   * @param messageId - The message ID to mark read
   * @param opts.db   - Optional DB override for testing
   */
  markRead(messageId: string, opts?: { db?: DatabaseSync }): void {
    internalMarkRead(this.domain, messageId, opts?.db);
  }

  /**
   * Get the reply thread for a parent message.
   *
   * @param parentMessageId - The parent message ID
   * @param opts.db         - Optional DB override for testing
   */
  thread(parentMessageId: string, opts?: { db?: DatabaseSync }): Message[] {
    const internal = internalGetThread(this.domain, parentMessageId, opts?.db);
    return internal.map(toPublicMessage);
  }
}
