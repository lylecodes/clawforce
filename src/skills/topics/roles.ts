/**
 * Clawforce skill topic — Presets & Roles
 *
 * Generated from actual preset constants.
 */

import { BUILTIN_AGENT_PRESETS, BUILTIN_JOB_PRESETS } from "../../presets.js";
import { DEFAULT_ACTION_SCOPES } from "../../profiles.js";

export function generate(): string {
  const sections: string[] = [
    "# Agent Presets",
    "",
    "Clawforce defines built-in presets that provide sensible defaults for agents. Each agent uses `extends: <preset>` to inherit a preset's defaults for briefing, expectations, performance policy, compaction, and coordination. Agents only need to specify what's different from their preset.",
    "",

    "## How Inheritance Works",
    "",
    "Set `extends:` on an agent to inherit from a preset:",
    "",
    "```yaml",
    "agents:",
    "  my-agent:",
    "    extends: employee",
    "    title: Frontend Developer",
    "    # ... only override what's different",
    "```",
    "",
    "The preset's defaults are deep-merged with the agent's config. Arrays support merge operators:",
    "",
    "- `+item` — add to the inherited list",
    "- `-item` — remove from the inherited list",
    "",
    "If no `extends` is specified, the agent gets no preset defaults and must define all fields explicitly.",
    "",
  ];

  // Agent presets
  sections.push("## Agent Presets");
  sections.push("");

  for (const [name, preset] of Object.entries(BUILTIN_AGENT_PRESETS)) {
    const title = (preset.title as string) ?? name;
    const persona = preset.persona as string | undefined;
    const briefing = (preset.briefing ?? []) as string[];
    const expectations = (preset.expectations ?? []) as Array<{ tool: string; action: string | string[]; min_calls: number }>;
    const performancePolicy = (preset.performance_policy ?? { action: "alert" }) as { action: string; max_retries?: number; then?: string };
    const compaction = preset.compaction as boolean | undefined;
    const coordination = preset.coordination as { enabled: boolean; schedule?: string } | undefined;

    sections.push(`### ${title} (\`${name}\`)`);
    sections.push("");
    if (persona) {
      sections.push(`**Default persona:** ${persona}`);
      sections.push("");
    }

    // Briefing sources
    sections.push("**Default briefing sources:**");
    sections.push("");
    if (briefing.length === 0) {
      sections.push("_(none — the `instructions` source is always auto-injected regardless of preset)_");
    } else {
      sections.push("The `instructions` source is always auto-injected in addition to these:");
      sections.push("");
      for (const source of briefing) {
        sections.push(`- \`${source}\``);
      }
    }
    sections.push("");

    // Expectations
    sections.push("**Default expectations:**");
    sections.push("");
    if (expectations.length === 0) {
      sections.push("_(none)_");
    } else {
      for (const exp of expectations) {
        const action = Array.isArray(exp.action) ? exp.action.join("` or `") : exp.action;
        sections.push(`- \`${exp.tool}\` action \`${action}\` — at least ${exp.min_calls} call(s)`);
      }
    }
    sections.push("");

    // Performance policy
    sections.push("**Default performance policy:**");
    sections.push("");
    let policyDesc = `- **action:** \`${performancePolicy.action}\``;
    if (performancePolicy.max_retries !== undefined) {
      policyDesc += `\n- **max_retries:** ${performancePolicy.max_retries}`;
    }
    if (performancePolicy.then) {
      policyDesc += `\n- **then:** \`${performancePolicy.then}\``;
    }
    sections.push(policyDesc);
    sections.push("");

    // Compaction
    if (compaction !== undefined) {
      sections.push(`**Compaction:** ${compaction ? "enabled" : "disabled"}`);
      sections.push("");
    }

    // Coordination
    if (coordination) {
      sections.push(`**Coordination:** ${coordination.enabled ? `enabled (schedule: \`${coordination.schedule ?? "default"}\`)` : "disabled"}`);
      sections.push("");
    }

    // Allowed tools (action scopes)
    const scopes = DEFAULT_ACTION_SCOPES[name];
    if (scopes) {
      sections.push("**Default allowed tools:**");
      sections.push("");
      for (const [tool, actions] of Object.entries(scopes)) {
        if (actions === "*") {
          sections.push(`- \`${tool}\` — all actions`);
        } else if (Array.isArray(actions)) {
          sections.push(`- \`${tool}\` — ${actions.join(", ")}`);
        } else if (typeof actions === "object" && "actions" in actions) {
          const constraint = actions as { actions: string[] | "*" };
          if (constraint.actions === "*") {
            sections.push(`- \`${tool}\` — all actions (with constraints)`);
          } else {
            sections.push(`- \`${tool}\` — ${constraint.actions.join(", ")} (with constraints)`);
          }
        }
      }
      sections.push("");
    }
  }

  // Job presets
  sections.push("## Job Presets");
  sections.push("");
  sections.push("Job presets define defaults for scoped sessions (cron jobs). An agent's `jobs:` entries can use `extends:` to inherit from a job preset.");
  sections.push("");

  for (const [name, preset] of Object.entries(BUILTIN_JOB_PRESETS)) {
    const cron = preset.cron as string | undefined;
    const briefing = (preset.briefing ?? []) as string[];
    const nudge = preset.nudge as string | undefined;
    const performancePolicy = (preset.performance_policy ?? { action: "alert" }) as { action: string };

    sections.push(`### \`${name}\``);
    sections.push("");
    if (cron) {
      sections.push(`**Schedule:** \`${cron}\``);
      sections.push("");
    }
    if (briefing.length > 0) {
      sections.push(`**Briefing:** ${briefing.map((s) => `\`${s}\``).join(", ")}`);
      sections.push("");
    }
    if (nudge) {
      sections.push(`**Nudge:** ${nudge}`);
      sections.push("");
    }
    sections.push(`**Performance policy:** \`${performancePolicy.action}\``);
    sections.push("");
  }

  return sections.join("\n");
}
