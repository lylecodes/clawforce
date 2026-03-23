/**
 * Clawforce — Gateway API dispatch
 *
 * Dispatches agents by calling the gateway's `chat.send` RPC method via
 * the plugin SDK's `callGatewayTool`. This sends a message to an agent
 * session through the gateway, triggering a full agent run with all
 * plugin hooks (before_prompt_build, after_tool_call, agent_end).
 *
 * The dispatch tag `[clawforce:dispatch=queueItemId:taskId]` is embedded
 * in the message so the before_prompt_build hook can link the session
 * to the dispatch queue item.
 */

import { safeLog } from "../diagnostics.js";

// Lazy import — callGatewayTool is in a subpath of the OpenClaw plugin SDK
let _callGatewayTool: ((method: string, opts: { timeoutMs?: number }, params?: unknown) => Promise<unknown>) | null = null;

async function getCallGatewayTool() {
  if (!_callGatewayTool) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import("openclaw/plugin-sdk") as any;
    // callGatewayTool may be re-exported from the main plugin-sdk or available via subpath
    if (typeof mod.callGatewayTool === "function") {
      _callGatewayTool = mod.callGatewayTool;
    } else {
      // Fallback: dynamic require of the specific file
      const gatewayMod = require("openclaw/dist/plugin-sdk/agents/tools/gateway.js");
      _callGatewayTool = gatewayMod.callGatewayTool;
    }
  }
  return _callGatewayTool!;
}

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
 * Dispatch a task by sending a message to the agent's session via the
 * gateway's chat.send RPC. The message goes through the gateway's full
 * lifecycle — before_prompt_build fires, hooks run, agent processes.
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
    const callGateway = await getCallGatewayTool();
    await callGateway("chat.send", { timeoutMs: 600_000 }, {
      sessionKey,
      message: taggedPrompt,
    });
    return { ok: true, sessionKey };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    safeLog("inject-dispatch.dispatchViaInject", err);
    return { ok: false, error: msg };
  }
}
