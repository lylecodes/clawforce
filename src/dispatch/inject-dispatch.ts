/**
 * Clawforce — Gateway RPC + Cron dispatch
 *
 * `callGatewayRpc` — used ONCE at bootstrap to capture the cron service.
 * `dispatchViaInject` — delegates to `dispatchViaCron` for actual dispatch.
 *
 * DO NOT CHANGE THIS MECHANISM without Lyle's approval. See POLICIES.md.
 */

import { safeLog } from "../diagnostics.js";
import { dispatchViaCron } from "./cron-dispatch.js";

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
 * Call a gateway RPC method via WebSocket. Used for ONE-TIME bootstrap only.
 * All runtime dispatch uses getCronService().add() in-process after bootstrap.
 */
export async function callGatewayRpc(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 15_000,
  port = 18789,
  token = "",
): Promise<unknown> {
  const url = `ws://127.0.0.1:${port}`;

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

        // Handle connect challenge
        if (frame.event === "connect.challenge") {
          const nonce = frame.payload?.nonce;
          ws.send(JSON.stringify({
            type: "req",
            id: "connect",
            method: "connect",
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: { id: "cli", version: "1.0.0", platform: process.platform, mode: "cli" },
              ...(token ? { auth: { token } } : {}),
            },
          }));
          return;
        }

        // Handle connect response — send our RPC
        if (frame.id === "connect") {
          if (frame.ok === false) {
            clearTimeout(timer);
            try { ws.close(); } catch { /* ignore */ }
            reject(new Error(`Gateway connect failed: ${frame.error?.message ?? "unknown"}`));
            return;
          }
          ws.send(JSON.stringify({
            type: "req",
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
            resolve(frame.result ?? frame.payload);
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
 * Dispatch a task via the cron API (in-process after bootstrap).
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

  const result = await dispatchViaCron({
    ...options,
    prompt: taggedPrompt,
  });

  if (result.ok) {
    return { ok: true, sessionKey };
  }
  return { ok: false, error: result.error };
}
