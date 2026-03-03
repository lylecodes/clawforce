/**
 * Clawforce — Auto-kill
 *
 * Terminates stuck agents via gateway RPC.
 * The actual kill mechanism depends on the gateway API available to the plugin.
 */

import { safeLog } from "../diagnostics.js";
import type { StuckAgent } from "./stuck-detector.js";

/**
 * Callback type for killing an agent session.
 * Provided by the gateway at init time.
 */
export type AgentKillFn = (sessionKey: string, reason: string) => Promise<boolean>;

let killFn: AgentKillFn | null = null;

/**
 * Register the kill function (provided by the plugin API / gateway).
 */
export function registerKillFunction(fn: AgentKillFn): void {
  killFn = fn;
}

/**
 * Attempt to kill a stuck agent.
 * Returns true if the kill was dispatched, false if no kill function is registered.
 */
export async function killStuckAgent(agent: StuckAgent): Promise<boolean> {
  if (!killFn) return false;

  try {
    return await killFn(agent.sessionKey, `Clawforce auto-kill: ${agent.reason}`);
  } catch (err) {
    safeLog("auto-kill.kill", err);
    return false;
  }
}

/**
 * Kill all stuck agents.
 * Returns the count of agents where kill was dispatched.
 */
export async function killAllStuckAgents(agents: StuckAgent[]): Promise<number> {
  let killed = 0;
  for (const agent of agents) {
    const result = await killStuckAgent(agent);
    if (result) killed++;
  }
  return killed;
}

/**
 * Clear registered kill function (for testing).
 */
export function resetAutoKillForTest(): void {
  killFn = null;
}
