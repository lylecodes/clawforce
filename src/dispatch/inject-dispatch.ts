/**
 * Clawforce — CLI-based dispatch
 *
 * Dispatches agents by spawning `openclaw agent` as a detached child process.
 * Fire-and-forget: the spawned process connects to the gateway independently
 * via WebSocket, so this works from sweep, cron, or any non-request context.
 */

import { spawn } from "node:child_process";
import { safeLog } from "../diagnostics.js";

type InjectFn = (params: { sessionKey: string; message: string }) => Promise<{ runId?: string }>;

let injector: InjectFn | null = null;

export function setDispatchInjector(fn: InjectFn): void {
  injector = fn;
}

export function getDispatchInjector(): InjectFn | null {
  return injector;
}

export type InjectDispatchResult = {
  ok: boolean;
  sessionKey?: string;
  error?: string;
};

/**
 * Dispatch a task by injecting a message into an isolated agent session.
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
    const child = spawn("openclaw", [
      "agent",
      "--agent", options.agentId,
      "--session-id", sessionKey,
      "--message", taggedPrompt,
    ], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
    return { ok: true, sessionKey };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    safeLog("inject-dispatch.dispatchViaInject", err);
    return { ok: false, error: msg };
  }
}
