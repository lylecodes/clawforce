/**
 * Clawforce — Effective scope resolution
 *
 * Resolves the effective ActionScope for an agent by checking:
 * 1. Custom action_scope policies (highest priority)
 * 2. DEFAULT_ACTION_SCOPES[extends] (fallback)
 *
 * Extracted from the adapter so context assemblers and tools can
 * use the same logic without depending on the adapter layer.
 */

import type { ActionScope } from "./types.js";
import { DEFAULT_ACTION_SCOPES } from "./profiles.js";
import { getAgentConfig } from "./project.js";
import { getPolicies } from "./policy/registry.js";

/**
 * Minimal scope for agents not registered in any project config.
 * Default-deny: only allow read-only setup actions for bootstrapping.
 */
export const UNREGISTERED_SCOPE: ActionScope = {
  clawforce_setup: ["explain", "status"],
};

/**
 * Resolve the effective ActionScope for an agent.
 * Returns `UNREGISTERED_SCOPE` for unregistered agents (default-deny).
 * Checks loaded policies first (respects custom action_scope overrides),
 * falls back to DEFAULT_ACTION_SCOPES[extends].
 */
export function resolveEffectiveScope(agentId: string): ActionScope {
  const entry = getAgentConfig(agentId);
  if (!entry) return UNREGISTERED_SCOPE; // unregistered → minimal access

  return resolveEffectiveScopeForProject(entry.projectId, agentId, entry.config.extends);
}

/**
 * Resolve the effective ActionScope when caller already has project context.
 * Useful for context assemblers that already know the projectId and preset.
 */
export function resolveEffectiveScopeForProject(
  projectId: string,
  agentId: string,
  extendsPreset: string | undefined,
): ActionScope {
  // Check if there's a custom action_scope policy for this agent
  const policies = getPolicies(projectId, agentId);
  for (const p of policies) {
    if (p.type === "action_scope" && p.enabled) {
      const raw = p.config.allowed_tools;
      if (raw) {
        // Legacy string[] → convert to ActionScope with "*" per tool
        if (Array.isArray(raw)) {
          const scope: ActionScope = {};
          for (const t of raw as string[]) {
            scope[t] = "*";
          }
          return scope;
        }
        // Already an ActionScope object
        if (typeof raw === "object") {
          return raw as ActionScope;
        }
      }
    }
  }

  // Fall back to preset defaults
  return DEFAULT_ACTION_SCOPES[extendsPreset ?? "employee"] ?? UNREGISTERED_SCOPE;
}
