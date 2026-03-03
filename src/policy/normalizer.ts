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
        const allowed = policy.config.allowed_tools as string[] | undefined;
        const denied = policy.config.denied_tools as string[] | undefined;
        if (!allowed && !denied) {
          errors.push({ name: policy.name, message: "action_scope policy must have allowed_tools or denied_tools" });
        }
        // Check for conflicting allow/deny on same tool
        if (allowed && denied) {
          const overlap = allowed.filter((t) => denied.includes(t));
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
