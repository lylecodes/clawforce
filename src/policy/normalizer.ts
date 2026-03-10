/**
 * Clawforce — Policy config normalizer
 *
 * Parse and validate policy configs from YAML.
 */

import type { PolicyType } from "../types.js";

const VALID_POLICY_TYPES: PolicyType[] = ["action_scope", "transition_gate", "spend_limit", "approval_required"];

export type PolicyConfigError = {
  name: string;
  message: string;
};

/**
 * Validate a set of policy configs. Returns errors for invalid configs.
 */
export function validatePolicyConfigs(
  policies: Array<{ name: string; type: string; target?: string; config: Record<string, unknown> }>,
  validTools: string[],
): PolicyConfigError[] {
  const errors: PolicyConfigError[] = [];

  for (const policy of policies) {
    if (!policy.name) {
      errors.push({ name: "(unnamed)", message: "Policy has no name" });
      continue;
    }

    if (!VALID_POLICY_TYPES.includes(policy.type as PolicyType)) {
      errors.push({ name: policy.name, message: `Unknown policy type: "${policy.type}"` });
      continue;
    }

    switch (policy.type) {
      case "action_scope": {
        const rawAllowed = policy.config.allowed_tools;
        const denied = policy.config.denied_tools as string[] | undefined;
        if (!rawAllowed && !denied) {
          errors.push({ name: policy.name, message: "action_scope policy must have allowed_tools or denied_tools" });
        }

        // Extract tool names from allowed_tools (supports both legacy string[] and ActionScope object)
        let allowedToolNames: string[] = [];
        if (Array.isArray(rawAllowed)) {
          // Legacy format: string[]
          allowedToolNames = rawAllowed as string[];
        } else if (rawAllowed && typeof rawAllowed === "object") {
          // New ActionScope format: Record<string, string[] | "*" | ActionConstraint>
          const scope = rawAllowed as Record<string, unknown>;
          allowedToolNames = Object.keys(scope);
          // Validate action values
          for (const [toolName, actions] of Object.entries(scope)) {
            if (actions !== "*" && !Array.isArray(actions)) {
              // Check for ActionConstraint shape: { actions: ..., constraints?: ... }
              if (typeof actions === "object" && actions !== null && "actions" in (actions as Record<string, unknown>)) {
                const ac = actions as { actions: unknown };
                if (ac.actions !== "*" && !Array.isArray(ac.actions)) {
                  errors.push({ name: policy.name, message: `Invalid actions value in ActionConstraint for tool "${toolName}": must be "*" or string[]` });
                }
              } else {
                errors.push({ name: policy.name, message: `Invalid action value for tool "${toolName}": must be "*", string[], or ActionConstraint` });
              }
            }
          }
        }

        // Validate tool names against known tools
        if (validTools.length > 0) {
          for (const t of allowedToolNames) {
            if (!validTools.includes(t)) {
              errors.push({ name: policy.name, message: `Unknown tool in allowed_tools: "${t}"` });
            }
          }
          for (const t of denied ?? []) {
            if (!validTools.includes(t)) {
              errors.push({ name: policy.name, message: `Unknown tool in denied_tools: "${t}"` });
            }
          }
        }
        // Check for conflicting allow/deny on same tool
        if (allowedToolNames.length > 0 && denied) {
          const overlap = allowedToolNames.filter((t) => denied.includes(t));
          if (overlap.length > 0) {
            errors.push({ name: policy.name, message: `Tools in both allow and deny lists: ${overlap.join(", ")}` });
          }
        }
        break;
      }
      case "transition_gate": {
        const transitions = policy.config.transitions;
        if (!Array.isArray(transitions) || transitions.length === 0) {
          errors.push({ name: policy.name, message: "transition_gate policy must have at least one transition" });
        }
        break;
      }
      case "spend_limit":
        // Validated via budget system — no additional validation needed
        break;
      case "approval_required": {
        const tools = policy.config.tools;
        const actions = policy.config.actions;
        if (!tools && !actions) {
          errors.push({ name: policy.name, message: "approval_required policy must specify tools or actions" });
        }
        break;
      }
    }
  }

  return errors;
}
