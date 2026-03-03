/**
 * Clawforce skill topic — Risk Tiers
 *
 * Documents risk classification and gate actions.
 */

import { DEFAULT_RISK_CONFIG } from "../../risk/config.js";

export function generate(): string {
  // Risk tiers from RiskTier type: "low" | "medium" | "high" | "critical"
  // Gate actions from RiskGateAction type: "none" | "delay" | "approval" | "human_approval"

  const tiers = Object.entries(DEFAULT_RISK_CONFIG.policies) as Array<[string, { gate: string; delayMs?: number }]>;

  const sections: string[] = [
    "# Risk Tiers",
    "",
    "Clawforce classifies actions by risk tier and applies gate policies to control execution of risky operations.",
    "",

    "## Risk Tiers",
    "",
    "| Tier | Description |",
    "| --- | --- |",
    "| `low` | Routine operations, no restrictions |",
    "| `medium` | Operations that warrant a brief delay for review |",
    "| `high` | Significant actions requiring approval before execution |",
    "| `critical` | Highest risk — requires human approval (not just manager approval) |",
    "",

    "## Gate Actions",
    "",
    "| Gate | Behavior |",
    "| --- | --- |",
    "| `none` | Action proceeds immediately |",
    "| `delay` | Action is delayed by a configurable duration (default 30s) |",
    "| `approval` | Action requires a proposal to be approved by a manager |",
    "| `human_approval` | Action requires explicit human approval |",
    "",

    "## Default Policies Per Tier",
    "",
    "| Tier | Default Gate | Delay |",
    "| --- | --- | --- |",
  ];

  for (const [tier, policy] of tiers) {
    const delay = policy.delayMs ? `${policy.delayMs / 1000}s` : "—";
    sections.push(`| \`${tier}\` | \`${policy.gate}\` | ${delay} |`);
  }

  sections.push("");
  sections.push(`Default tier when risk tiers are disabled: \`${DEFAULT_RISK_CONFIG.defaultTier}\``);
  sections.push("");

  sections.push("## Risk Patterns");
  sections.push("");
  sections.push("Risk patterns are match rules that classify actions into tiers based on their properties. Patterns are evaluated in order, and the highest matching tier wins.");
  sections.push("");
  sections.push("Pattern match fields:");
  sections.push("");
  sections.push("| Field | Description |");
  sections.push("| --- | --- |");
  sections.push("| `action_type` | The type of action being performed |");
  sections.push("| `tool_name` | The tool being invoked |");
  sections.push("| `tool_action` | The specific action on the tool |");
  sections.push("| `to_state` | Target task state (for transitions) |");
  sections.push("| `from_state` | Source task state (for transitions) |");
  sections.push("| `task_priority` | Priority of the affected task |");
  sections.push("");
  sections.push("### P0 Priority Escalation");
  sections.push("");
  sections.push("P0 (critical) tasks automatically get their risk tier bumped by one level — a `low` action on a P0 task becomes `medium`, `medium` becomes `high`, etc. This ensures critical work gets extra scrutiny.");
  sections.push("");

  sections.push("## Configuring Risk Tiers");
  sections.push("");
  sections.push("```yaml");
  sections.push("risk_tiers:");
  sections.push("  enabled: true");
  sections.push("  default_tier: low");
  sections.push("  policies:");
  sections.push("    low:");
  sections.push("      gate: none");
  sections.push("    medium:");
  sections.push("      gate: delay");
  sections.push("      delay_ms: 30000");
  sections.push("    high:");
  sections.push("      gate: approval");
  sections.push("    critical:");
  sections.push("      gate: human_approval");
  sections.push("  patterns:");
  sections.push("    - match:");
  sections.push("        tool_name: clawforce_ops");
  sections.push("        tool_action: kill_agent");
  sections.push("      tier: critical");
  sections.push("    - match:");
  sections.push("        to_state: CANCELLED");
  sections.push("      tier: high");
  sections.push("```");
  sections.push("");
  sections.push("System actors (prefixed with `system:`) bypass risk classification entirely and always receive `low` tier.");
  sections.push("");

  return sections.join("\n");
}
