/**
 * Clawforce skill topic — Policies
 *
 * Documents the policy enforcement system.
 */

export function generate(): string {
  // Policy types from PolicyType: "action_scope" | "transition_gate" | "spend_limit" | "approval_required"
  const policyTypes: Array<{ name: string; description: string; configFields: string }> = [
    {
      name: "action_scope",
      description: "Controls which tools an agent can use. Has `allowed_tools` (whitelist) and/or `denied_tools` (blacklist). Deny list takes precedence.",
      configFields: "`allowed_tools: string[]`, `denied_tools: string[]`",
    },
    {
      name: "transition_gate",
      description: "Controls task state transitions. Can require minimum priority or different actors for specific transitions.",
      configFields: "`transitions: Array<{ from?, to?, conditions? }>`",
    },
    {
      name: "spend_limit",
      description: "Enforces budget limits. Checks agent and project budgets before allowing actions.",
      configFields: "_(uses budget config — see Budgets topic)_",
    },
    {
      name: "approval_required",
      description: "Requires approval before certain tool/action combinations. Blocks the action and returns a policy violation.",
      configFields: "`tools: string[]`, `actions: string[]`",
    },
  ];

  const sections: string[] = [
    "# Policies",
    "",
    "Policies are rules that constrain agent behavior at runtime. They are checked before every tool call and can block actions that violate the rules.",
    "",

    "## Policy Types",
    "",
    "| Type | Description | Config Fields |",
    "| --- | --- | --- |",
  ];

  for (const pt of policyTypes) {
    sections.push(`| \`${pt.name}\` | ${pt.description} | ${pt.configFields} |`);
  }

  sections.push("");
  sections.push("## Defining Policies in Domain Config");
  sections.push("");
  sections.push("```yaml");
  sections.push("policies:");
  sections.push("  - name: restrict-junior-dev");
  sections.push("    type: action_scope");
  sections.push("    target: junior-dev");
  sections.push("    config:");
  sections.push("      allowed_tools:");
  sections.push("        - clawforce_task");
  sections.push("        - clawforce_log");
  sections.push("");
  sections.push("  - name: p0-transition-gate");
  sections.push("    type: transition_gate");
  sections.push("    config:");
  sections.push("      transitions:");
  sections.push("        - from: REVIEW");
  sections.push("          to: DONE");
  sections.push("          conditions:");
  sections.push("            min_priority: P0");
  sections.push("");
  sections.push("  - name: require-approval-for-ops");
  sections.push("    type: approval_required");
  sections.push("    target: dev-1");
  sections.push("    config:");
  sections.push("      tools: [clawforce_ops]");
  sections.push("      actions: [kill_agent, disable_agent]");
  sections.push("```");
  sections.push("");

  sections.push("## Auto-Generated Action Scope Policies");
  sections.push("");
  sections.push("When no explicit `action_scope` policy is defined for an agent, the system auto-generates one based on the agent's role. The default allowed tools per role are:");
  sections.push("");
  sections.push("- **manager**: `clawforce_task`, `clawforce_log`, `clawforce_verify`, `clawforce_compact`, `clawforce_workflow`, `clawforce_ops`, `clawforce_setup`");
  sections.push("- **employee**: `clawforce_task`, `clawforce_log`, `clawforce_verify`, `clawforce_compact`");
  sections.push("");
  sections.push("If you define an explicit `action_scope` policy targeting an agent, the auto-generated policy is skipped for that agent.");
  sections.push("");

  sections.push("## Policy Evaluation");
  sections.push("");
  sections.push("Policies are evaluated in priority order (highest priority first). The first violation found blocks the action. If no policies are violated, the action is allowed.");
  sections.push("");
  sections.push("Each policy has:");
  sections.push("");
  sections.push("| Field | Description |");
  sections.push("| --- | --- |");
  sections.push("| `name` | Human-readable policy name |");
  sections.push("| `type` | One of the policy types above |");
  sections.push("| `target` | Agent ID this policy applies to (optional — applies to all if omitted) |");
  sections.push("| `config` | Type-specific configuration |");
  sections.push("| `priority` | Evaluation order (higher = checked first) |");
  sections.push("| `enabled` | Whether the policy is active |");
  sections.push("");

  sections.push("## Policy Violations");
  sections.push("");
  sections.push("When an action is blocked by a policy, a violation record is created with:");
  sections.push("");
  sections.push("- The policy that was violated");
  sections.push("- The agent that attempted the action");
  sections.push("- The action that was attempted");
  sections.push("- The outcome (blocked)");
  sections.push("");
  sections.push("Violations are visible through the `policy_status` context source.");
  sections.push("");

  return sections.join("\n");
}
