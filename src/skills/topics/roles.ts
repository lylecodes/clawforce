/**
 * Clawforce skill topic — Roles
 *
 * Generated from actual role profile constants.
 */

import { BUILTIN_PROFILES, ROLE_DEFAULTS, DEFAULT_ACTION_SCOPES } from "../../profiles.js";
import type { AgentRole } from "../../types.js";

const ROLES: AgentRole[] = ["manager", "employee", "scheduled"];

export function generate(): string {
  const sections: string[] = [
    "# Agent Roles",
    "",
    "Clawforce defines three built-in roles. Each role has a default profile that provides sensible defaults for briefing sources, expectations, performance policy, and allowed tools. Agents inherit from their role's profile and only need to specify what's different.",
    "",
  ];

  for (const role of ROLES) {
    const profile = BUILTIN_PROFILES[role];
    const defaults = ROLE_DEFAULTS[role];
    const scopes = DEFAULT_ACTION_SCOPES[role];

    sections.push(`## ${defaults.title} (\`${role}\`)`);
    sections.push("");
    sections.push(`**Default persona:** ${defaults.persona}`);
    sections.push("");

    // Briefing sources
    sections.push("### Default Briefing Sources");
    sections.push("");
    if (profile.briefing.length === 0) {
      sections.push("_(none — the `instructions` source is always auto-injected regardless of profile)_");
    } else {
      sections.push("The `instructions` source is always auto-injected in addition to these:");
      sections.push("");
      for (const source of profile.briefing) {
        let extra = "";
        if (source.filter) {
          const parts: string[] = [];
          if (source.filter.category) parts.push(`category: ${source.filter.category.join(", ")}`);
          if (source.filter.tags) parts.push(`tags: ${source.filter.tags.join(", ")}`);
          extra = ` (${parts.join("; ")})`;
        }
        sections.push(`- \`${source.source}\`${extra}`);
      }
    }
    sections.push("");

    // Expectations
    sections.push("### Default Expectations");
    sections.push("");
    if (profile.expectations.length === 0) {
      sections.push("_(none)_");
    } else {
      for (const exp of profile.expectations) {
        const action = Array.isArray(exp.action) ? exp.action.join("` or `") : exp.action;
        sections.push(`- \`${exp.tool}\` action \`${action}\` — at least ${exp.min_calls} call(s)`);
      }
    }
    sections.push("");

    // Performance policy
    sections.push("### Default Performance Policy");
    sections.push("");
    const policy = profile.performance_policy;
    let policyDesc = `- **action:** \`${policy.action}\``;
    if (policy.max_retries !== undefined) {
      policyDesc += `\n- **max_retries:** ${policy.max_retries}`;
    }
    if (policy.then) {
      policyDesc += `\n- **then:** \`${policy.then}\``;
    }
    sections.push(policyDesc);
    sections.push("");

    // Allowed tools (action scopes)
    sections.push("### Default Allowed Tools");
    sections.push("");
    for (const tool of scopes) {
      sections.push(`- \`${tool}\``);
    }
    sections.push("");
  }

  return sections.join("\n");
}
