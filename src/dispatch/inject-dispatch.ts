/**
 * Clawforce — Inject-based dispatch
 *
 * Dispatches agents via api.injectAgentMessage() — direct session injection
 * without any cron service dependency. The injector function is captured
 * from the OpenClaw plugin API during adapter registration.
 */

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
  if (!injector) {
    return { ok: false, error: "Dispatch injector not set" };
  }

  const sessionKey = `agent:${options.agentId}:dispatch:${options.queueItemId}`;
  const taggedPrompt = `[clawforce:dispatch=${options.queueItemId}:${options.taskId}]\n\n${options.prompt}`;

  try {
    await injector({ sessionKey, message: taggedPrompt });
    return { ok: true, sessionKey };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    safeLog("inject-dispatch.dispatchViaInject", err);
    return { ok: false, error: msg };
  }
}
