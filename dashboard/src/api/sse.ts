/**
 * SSE connection manager for the Clawforce dashboard.
 *
 * Connects to /api/sse?domain=<id> and dispatches typed events.
 */
import type { SSEEventType } from "./types";

export type SSEEventHandler = (event: SSEEventType, data: unknown) => void;

const EVENT_TYPES: SSEEventType[] = [
  "budget:update",
  "task:update",
  "agent:status",
  "approval:new",
  "approval:resolved",
  "message:new",
  "plan:update",
  "escalation:new",
  "meeting:started",
  "meeting:turn",
  "meeting:ended",
  "config:changed",
];

/**
 * Open an SSE connection for the given domain.
 * Returns a cleanup function that closes the connection.
 */
export function connectSSE(
  domain: string,
  onEvent: SSEEventHandler,
): () => void {
  const url = `/api/sse?domain=${encodeURIComponent(domain)}`;
  let es: EventSource | null = new EventSource(url);
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function attach(source: EventSource) {
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (e: MessageEvent) => {
        try {
          onEvent(type, JSON.parse(e.data));
        } catch {
          // Ignore parse errors
        }
      });
    }

    source.onerror = () => {
      if (closed) return;
      source.close();
      // Reconnect after 3 seconds
      reconnectTimeout = setTimeout(() => {
        if (closed) return;
        es = new EventSource(url);
        attach(es);
      }, 3000);
    };
  }

  attach(es);

  return () => {
    closed = true;
    es?.close();
    es = null;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
  };
}
