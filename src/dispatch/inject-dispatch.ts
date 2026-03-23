/**
 * Clawforce — Gateway RPC dispatch
 *
 * Dispatches agents by calling the `clawforce.dispatch` gateway method
 * via WebSocket RPC. This creates a one-shot cron job that triggers a
 * full agent session through the gateway with all plugin hooks.
 *
 * No CLI subprocess. No file writes. No shared state pollution.
 * DO NOT CHANGE THIS MECHANISM without Lyle's approval. See POLICIES.md.
 */

import { safeLog } from "../diagnostics.js";

// Keep injector for meeting dispatch and tests
type InjectFn = (params: { sessionKey: string; message: string }) => Promise<{ runId?: string }>;
let injector: InjectFn | null = null;
export function setDispatchInjector(fn: InjectFn): void { injector = fn; }
export function getDispatchInjector(): InjectFn | null { return injector; }

export type InjectDispatchResult = {
  ok: boolean;
  sessionKey?: string;
  error?: string;
};

/**
 * Call a gateway RPC method via WebSocket.
 * Connects, completes challenge handshake, sends request, waits for response.
 */
async function callGatewayRpc(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
  const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT ?? "18789";
  const url = `ws://127.0.0.1:${gatewayPort}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let WS: any;
  try {
    WS = require("ws").WebSocket ?? require("ws");
  } catch {
    throw new Error("WebSocket (ws) module not available");
  }

  return new Promise((resolve, reject) => {
    const ws = new WS(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`Gateway RPC timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const requestId = `cf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    ws.on("message", (data: Buffer | string) => {
      try {
        const frame = JSON.parse(typeof data === "string" ? data : data.toString());

        // Handle connect challenge — respond with handshake
        if (frame.method === "connect.challenge" || (frame.type === "event" && frame.event === "connect.challenge")) {
          const nonce = frame.params?.nonce ?? frame.data?.nonce;
          ws.send(JSON.stringify({
            type: "request",
            id: "connect",
            method: "connect",
            params: { nonce, version: 1, client: "clawforce-dispatch" },
          }));
          return;
        }

        // Handle connect response — now send our RPC
        if (frame.id === "connect" && frame.ok !== false) {
          ws.send(JSON.stringify({
            type: "request",
            id: requestId,
            method,
            params,
          }));
          return;
        }

        // Handle our RPC response
        if (frame.id === requestId) {
          clearTimeout(timer);
          try { ws.close(); } catch { /* ignore */ }
          if (frame.ok !== false) {
            resolve(frame.result);
          } else {
            reject(new Error(frame.error?.message ?? "RPC failed"));
          }
        }
      } catch { /* ignore parse errors */ }
    });

    ws.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.on("close", () => {
      clearTimeout(timer);
    });
  });
}

/**
 * Dispatch a task by calling the clawforce.dispatch gateway method.
 * Creates a one-shot cron job that triggers a full agent session.
 */
export async function dispatchViaInject(options: {
  queueItemId: string;
  taskId: string;
  projectId: string;
  prompt: string;
  agentId: string;
}): Promise<InjectDispatchResult> {
  const sessionKey = `agent:${options.agentId}:dispatch:${options.queueItemId}`;
  const taggedPrompt = `[clawforce:dispatch=${options.queueItemId}:${options.taskId}]\n\n${options.prompt}`;

  try {
    await callGatewayRpc("clawforce.dispatch", {
      agentId: options.agentId,
      message: taggedPrompt,
    });
    return { ok: true, sessionKey };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    safeLog("inject-dispatch.dispatchViaInject", err);
    return { ok: false, error: msg };
  }
}
