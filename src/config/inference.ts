/**
 * Clawforce — Role inference from org structure
 *
 * Scans the agent map to determine preset when none is specified.
 * If any other agent has reports_to pointing at this agent → manager.
 * If this agent has reports_to set → employee.
 * Default → employee.
 */

import type { GlobalAgentDef } from "./schema.js";
import { getDefaultRuntimeState } from "../runtime/default-runtime.js";

/** Track which agents had their preset inferred (not injected into config). */
type ConfigInferenceRuntimeState = {
  inferredAgents: Map<string, boolean>;
};

const runtime = getDefaultRuntimeState();

function getInferredAgents(): ConfigInferenceRuntimeState["inferredAgents"] {
  return (runtime.configInference as ConfigInferenceRuntimeState).inferredAgents;
}

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
  getInferredAgents().set(agentId, true);
}
