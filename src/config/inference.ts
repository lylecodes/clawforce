/**
 * Clawforce — Role inference from org structure
 *
 * Scans the agent map to determine preset when none is specified.
 * If any other agent has reports_to pointing at this agent → manager.
 * If this agent has reports_to set → employee.
 * Default → employee.
 */

import type { GlobalAgentDef } from "./schema.js";

/** Track which agents had their preset inferred (not injected into config). */
const inferredAgents = new Map<string, boolean>();

export function inferPreset(
  agentId: string,
  allAgents: Record<string, GlobalAgentDef>,
): "manager" | "employee" {
  // Check if any other agent reports to this one
  for (const [otherId, otherDef] of Object.entries(allAgents)) {
    if (otherId === agentId) continue;
    if (otherDef.reports_to === agentId) {
      return "manager";
    }
  }

  return "employee";
}

export function markInferred(agentId: string): void {
  inferredAgents.set(agentId, true);
}

