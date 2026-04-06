/**
 * Clawforce — Dashboard SSE (Server-Sent Events) infrastructure
 *
 * Manages connected SSE clients per domain and broadcasts typed events.
 */

import type { ServerResponse } from "node:http";

export type SSEEventType =
  | "budget:update"
  | "task:update"
  | "agent:status"
  | "domain:status"
  | "approval:new"
  | "approval:resolved"
  | "message:new"
  | "plan:update"
  | "escalation:new"
  | "meeting:started"
  | "meeting:turn"
  | "meeting:ended"
  | "config:changed";

type Client = {
  id: string;
  domain: string;
  res: ServerResponse;
};

export class SSEManager {
  private clients = new Map<string, Client[]>();
  private nextId = 0;

  addClient(domain: string, res: ServerResponse): string {
    const id = String(++this.nextId);
    const client: Client = { id, domain, res };

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ clientId: id })}\n\n`);

    // Track
    const clients = this.clients.get(domain) ?? [];
    clients.push(client);
    this.clients.set(domain, clients);

    // Clean up on close
    res.on("close", () => this.removeClient(domain, id));

    return id;
  }

  removeClient(domain: string, clientId: string): void {
    const clients = this.clients.get(domain);
    if (!clients) return;
    const filtered = clients.filter((c) => c.id !== clientId);
    if (filtered.length === 0) {
      this.clients.delete(domain);
    } else {
      this.clients.set(domain, filtered);
    }
  }

  broadcast(domain: string, event: SSEEventType, data: unknown): void {
    const clients = this.clients.get(domain);
    if (!clients) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      try {
        client.res.write(payload);
      } catch {
        this.removeClient(domain, client.id);
      }
    }
  }

  clientCount(domain: string): number {
    return this.clients.get(domain)?.length ?? 0;
  }
}

// Singleton instance
let _sseManager: SSEManager | null = null;

export function getSSEManager(): SSEManager {
  if (!_sseManager) _sseManager = new SSEManager();
  return _sseManager;
}

export function emitSSE(domain: string, event: SSEEventType, data: unknown): void {
  _sseManager?.broadcast(domain, event, data);
}
