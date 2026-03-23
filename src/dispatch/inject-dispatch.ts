/**
 * Clawforce — CLI-based dispatch
 *
 * Dispatches agents via `openclaw agent` CLI with isolated session keys.
 * The CLI connects to the gateway via WebSocket (30s handshake timeout patched),
 * creating sessions with full plugin hook lifecycle.
 *
 * DO NOT CHANGE THIS MECHANISM without Lyle's approval. See POLICIES.md.
 */

import { execFile } from "node:child_process";
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
 * Dispatch a task by launching an agent session via the OpenClaw CLI.
 * The message embeds a `[clawforce:dispatch=...]` tag so the
 * `before_prompt_build` hook can link the session to the dispatch queue item.
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
    await new Promise<void>((resolve, reject) => {
      execFile("openclaw", [
        "agent",
        "--agent", options.agentId,
        "--session-id", sessionKey,
        "--message", taggedPrompt,
      ], { timeout: 600_000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return { ok: true, sessionKey };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    safeLog("inject-dispatch.dispatchViaInject", err);
    return { ok: false, error: msg };
  }
}
