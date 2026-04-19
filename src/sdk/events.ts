/**
 * Clawforce SDK — Events Namespace
 *
 * Wraps internal event store operations and adds an in-process pub/sub layer
 * via on()/off(). The internal event store only persists events (no in-process
 * subscriptions); the listener map here is purely in-memory and exists only
 * for the lifetime of the EventsNamespace instance.
 *
 * Subscriber errors are isolated: a throwing handler will not crash emit() or
 * prevent other handlers from running.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import {
  ingestEvent,
  listEvents,
  countEvents,
} from "../events/store.js";
import type { EventSource, EventStatus } from "../types.js";
import type { ClawforceEvent, EventHandler } from "./types.js";

/** Map an internal ClawforceEvent (from src/types.ts) to the public SDK ClawforceEvent. */
function toPublicEvent(e: {
  id: string;
  type: string;
  source: EventSource;
  payload: Record<string, unknown>;
  status: EventStatus;
  createdAt: number;
  [key: string]: unknown;
}): ClawforceEvent {
  return {
    id: e.id,
    type: e.type,
    source: e.source,
    payload: e.payload,
    status: e.status,
    createdAt: e.createdAt,
  };
}

export class EventsNamespace {
  /** In-process subscriber registry. Keyed by event type (or "*" for wildcard). */
  private listeners = new Map<string, Set<EventHandler>>();

  constructor(readonly domain: string) {}

  /**
   * Emit an event: persists it to the store AND fires any in-process subscribers
   * registered for the event type or for the "*" wildcard.
   *
   * @param type       - Event type string (e.g. "task.completed", "agent.error")
   * @param payload    - Arbitrary payload object
   * @param opts.source   - Source tag for the event (defaults to "internal")
   * @param opts.dedupKey - Optional dedup key; a second emit with the same key is a no-op
   * @param opts.db       - Optional DB override for testing
   */
  emit(
    type: string,
    payload?: Record<string, unknown>,
    opts?: { source?: string; dedupKey?: string; db?: DatabaseSync },
  ): ClawforceEvent {
    const source = (opts?.source ?? "internal") as EventSource;
    const safePayload = payload ?? {};

    // 1. Persist via the internal event store
    const { id, deduplicated } = ingestEvent(
      this.domain,
      type,
      source,
      safePayload,
      opts?.dedupKey,
      opts?.db,
    );

    // 2. Build the public event object.
    //    For deduplicated events we still build and return the canonical event,
    //    but we do NOT fire listeners again (the event was already processed).
    const event: ClawforceEvent = {
      id,
      type,
      source,
      payload: safePayload,
      status: "pending",
      createdAt: Date.now(),
    };

    if (!deduplicated) {
      // 3. Fire in-process subscribers
      this.fireListeners(type, event);
    }

    return event;
  }

  /**
   * List events from the store with optional filters.
   *
   * @param filters.type   - Filter by event type
   * @param filters.status - Filter by event status
   * @param filters.limit  - Max results (default: 50)
   * @param filters.offset - Pagination offset (default: 0)
   * @param filters.db     - Optional DB override for testing
   */
  list(
    filters?: {
      type?: string;
      status?: string;
      limit?: number;
      offset?: number;
      db?: DatabaseSync;
    },
  ): ClawforceEvent[] {
    const internal = listEvents(
      this.domain,
      {
        type: filters?.type,
        status: filters?.status as EventStatus | undefined,
        limit: filters?.limit,
        offset: filters?.offset,
      },
      filters?.db,
    );
    return internal.map(toPublicEvent);
  }

  /**
   * Count events matching the given filters.
   *
   * @param filters.type   - Filter by event type
   * @param filters.status - Filter by event status
   * @param filters.db     - Optional DB override for testing
   */
  count(
    filters?: { type?: string; status?: string; db?: DatabaseSync },
  ): number {
    return countEvents(
      this.domain,
      {
        type: filters?.type,
        status: filters?.status as EventStatus | undefined,
      },
      filters?.db,
    );
  }

  /**
   * Subscribe to events (in-process only — not persisted, not SSE).
   *
   * @param type    - Event type to listen for, or "*" to receive all events
   * @param handler - Callback invoked with each matching ClawforceEvent
   */
  on(type: string, handler: EventHandler): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
  }

  /**
   * Unsubscribe a handler previously registered with on().
   *
   * @param type    - The event type the handler was registered for
   * @param handler - The exact handler reference passed to on()
   */
  off(type: string, handler: EventHandler): void {
    const set = this.listeners.get(type);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        this.listeners.delete(type);
      }
    }
  }

  /**
   * Fire all listeners registered for `type` and all wildcard ("*") listeners.
   * Each handler is called in a try/catch so that subscriber errors never
   * propagate back to the caller of emit().
   */
  private fireListeners(type: string, event: ClawforceEvent): void {
    // Collect the sets to iterate (type-specific + wildcard).
    // We snapshot both sets before iterating so that handlers calling
    // on()/off() mid-dispatch don't cause iteration hazards.
    const typedHandlers = this.listeners.get(type)
      ? [...this.listeners.get(type)!]
      : [];
    const wildcardHandlers =
      type !== "*" && this.listeners.get("*")
        ? [...this.listeners.get("*")!]
        : [];

    for (const handler of typedHandlers) {
      try {
        handler(event);
      } catch {
        // Subscriber errors are intentionally swallowed to protect emit() callers.
      }
    }

    for (const handler of wildcardHandlers) {
      try {
        handler(event);
      } catch {
        // Same isolation for wildcard subscribers.
      }
    }
  }
}
