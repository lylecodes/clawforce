/**
 * Clawforce — Auto-kill
 *
 * Terminates stuck agents via gateway RPC.
 * The actual kill mechanism depends on the gateway API available to the plugin.
 */

import { safeLog } from "../diagnostics.js";
import { killPersistedSessionProcess } from "../enforcement/tracker.js";
import {
  getAgentKillPort,
  setAgentKillPort,
} from "../runtime/integrations.js";
import type { StuckAgent } from "./stuck-detector.js";

type KillableAgent = {
  sessionKey: string;
  reason: string;
  [key: string]: unknown;
};

/**
 * Callback type for killing an agent session.
 * Provided by the gateway at init time.
 */
export type AgentKillFn = (sessionKey: string, reason: string) => Promise<boolean>;

/**
 * Register the kill function (provided by the plugin API / gateway).
 */
export function registerKillFunction(fn: AgentKillFn): void {
  setAgentKillPort(fn);
}

/**
 * Attempt to kill a stuck agent.
 * Returns true if the kill was dispatched, false if no kill function is registered.
 */
export async function killStuckAgent(agent: KillableAgent): Promise<boolean> {
  const killFn = getAgentKillPort();
  const reason = `Clawforce auto-kill: ${agent.reason}`;
  if (killFn) {
    try {
      const killed = await killFn(agent.sessionKey, reason);
      if (killed) return true;
    } catch (err) {
      safeLog("auto-kill.kill", err);
    }
  }

  if (typeof agent.projectId === "string" && agent.projectId) {
    return killPersistedSessionProcess(agent.projectId, agent.sessionKey, reason);
  }

  return false;
}

/**
 * Kill all stuck agents.
 * Returns the count of agents where kill was dispatched.
 */
export async function killAllStuckAgents(agents: KillableAgent[]): Promise<number> {
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
  setAgentKillPort(null);
}
