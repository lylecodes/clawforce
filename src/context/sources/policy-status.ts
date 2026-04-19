/**
 * Clawforce — Policy status context source
 *
 * Renders active policy constraints for the agent so they understand their boundaries.
 */

import type { DatabaseSync } from "../../sqlite-driver.js";
import { getDb } from "../../db.js";
import { getPolicies } from "../../policy/registry.js";

/**
 * Build policy status markdown for an agent.
 */
export function buildPolicyStatus(
  projectId: string,
  agentId?: string,
  dbOverride?: DatabaseSync,
): string | null {
  const policies = getPolicies(projectId, agentId);
  if (policies.length === 0) return null;

  const lines = ["## Active Policies\n"];

  for (const policy of policies) {
    const target = policy.targetAgent ? ` (target: ${policy.targetAgent})` : " (all agents)";
    lines.push(`### ${policy.name}${target}`);
    lines.push(`Type: \`${policy.type}\``);

    switch (policy.type) {
      case "action_scope": {
        const allowed = policy.config.allowed_tools as string[] | undefined;
        const denied = policy.config.denied_tools as string[] | undefined;
        if (allowed) lines.push(`Allowed tools: ${allowed.join(", ")}`);
        if (denied) lines.push(`Denied tools: ${denied.join(", ")}`);
        break;
      }
      case "transition_gate": {
        const transitions = policy.config.transitions as Array<Record<string, unknown>> | undefined;
        if (transitions) {
          for (const t of transitions) {
            lines.push(`- Gate: ${t.from ?? "*"} -> ${t.to ?? "*"}`);
          }
        }
        break;
      }
      case "spend_limit":
        lines.push("Budget limits are enforced on dispatches.");
        break;
      case "approval_required": {
        const tools = policy.config.tools as string[] | undefined;
        const actions = policy.config.actions as string[] | undefined;
        if (tools) lines.push(`Approval required for tools: ${tools.join(", ")}`);
        if (actions) lines.push(`Approval required for actions: ${actions.join(", ")}`);
        break;
      }
    }

    lines.push("");
  }

  // Recent violations summary
  if (agentId) {
    try {
      const db = dbOverride ?? getDb(projectId);
      const violations = db.prepare(
        "SELECT COUNT(*) as cnt FROM policy_violations WHERE project_id = ? AND agent_id = ? AND created_at > ?",
      ).get(projectId, agentId, Date.now() - 3600000) as Record<string, unknown>;
      const count = violations.cnt as number;
      if (count > 0) {
        lines.push(`**Recent violations (last hour):** ${count}`);
      }
    } catch {
      // Non-fatal
    }
  }

  return lines.join("\n");
}
