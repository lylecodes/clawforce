/**
 * Clawforce — Dispatch injection layer
 *
 * This module provides two dispatch mechanisms:
 *
 * 1. `dispatchViaInject` — Primary dispatch path used by the dispatch loop.
 *    Constructs a session key, tags the prompt with dispatch metadata, and
 *    delegates to cron-dispatch.ts for actual execution.
 *
 * 2. `setDispatchInjector` / `getDispatchInjector` — Session injector used
 *    by the meeting channel (channels/meeting.ts) and set up by the OpenClaw
 *    adapter (adapters/openclaw.ts) to inject messages into existing sessions.
 *    This is a SEPARATE mechanism from the cron-based dispatch path.
 *
 * DO NOT CHANGE THIS MECHANISM without Lyle's approval. See POLICIES.md.
 */

import { dispatchViaCron } from "./cron-dispatch.js";

// --- Session injector (used by meeting channel, set by openclaw adapter) ---

type InjectFn = (params: { sessionKey: string; message: string }) => Promise<{ runId?: string }>;
let injector: InjectFn | null = null;
export function setDispatchInjector(fn: InjectFn): void { injector = fn; }
export function getDispatchInjector(): InjectFn | null { return injector; }

// --- Cron-based dispatch (primary dispatch path) ---

export type InjectDispatchResult = {
  ok: boolean;
  sessionKey?: string;
  error?: string;
};

/**
 * Dispatch a task via the cron API.
 * Constructs a stable session key for tracking and tags the prompt
 * with dispatch metadata so the `before_prompt_build` hook can link
 * the session back to the dispatch queue item.
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
