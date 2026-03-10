/**
 * Clawforce skill topic — Accountability
 *
 * Generated from preset constants and types.
 */

import { BUILTIN_AGENT_PRESETS } from "../../presets.js";

export function generate(): string {
  const sections: string[] = [
    "# Accountability",
    "",
    "Clawforce enforces agent accountability through two mechanisms: **expectations** (what agents must do) and **performance policies** (what happens when they don't).",
    "",

    "## Expectations",
    "",
    "Each agent has a list of expectations — minimum tool call requirements that must be met during a session.",
    "",
    "An expectation has three fields:",
    "",
    "| Field | Type | Description |",
    "| --- | --- | --- |",
    "| `tool` | string | The tool name (e.g. `clawforce_task`) |",
    "| `action` | string or string[] | The action(s) that satisfy the expectation |",
    "| `min_calls` | number | Minimum number of matching calls required |",
    "",
    "When `action` is an array, a call to **any** of the listed actions counts toward the requirement.",
    "",
    "### Compliance",
    "",
    "An agent is **compliant** when all its expectations have been met — every expectation has at least `min_calls` matching tool invocations in the session.",
    "",
    "An agent is **non-compliant** when one or more expectations have not been met by the time the session ends.",
    "",

    "## Performance Policies",
    "",
    "A performance policy defines what happens when an agent is non-compliant at session end.",
    "",
    "| Action | Behavior |",
    "| --- | --- |",
    "| `retry` | Re-run the agent session (up to `max_retries` times) |",
    "| `alert` | Send an alert to the manager / escalation target |",
    "| `terminate_and_alert` | Kill the agent session and send an alert |",
    "",
    "### The Retry Chain",
    "",
    "When the policy action is `retry`, the system will:",
    "",
    "1. Re-run the agent session",
    "2. After each retry, check compliance again",
    "3. If still non-compliant after `max_retries`, execute the `then` action",
    "",
    "The `then` field is the escalation action after retries are exhausted. It can be `alert` or `terminate_and_alert`.",
    "",
    "```",
    "action: retry",
    "max_retries: 3",
    "then: alert",
    "```",
    "",
    "This means: retry up to 3 times, then alert the manager if still non-compliant.",
    "",
  ];

  // Per-preset defaults
  sections.push("## Preset Defaults");
  sections.push("");

  for (const [name, preset] of Object.entries(BUILTIN_AGENT_PRESETS)) {
    const title = (preset.title as string) ?? name;
    const expectations = (preset.expectations ?? []) as Array<{ tool: string; action: string | string[]; min_calls: number }>;
    const policy = (preset.performance_policy ?? { action: "alert" }) as { action: string; max_retries?: number; then?: string };

    sections.push(`### ${title} (\`${name}\`)`);
    sections.push("");

    sections.push("**Expectations:**");
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

    sections.push("**Performance policy:**");
    sections.push("");
    sections.push(`- action: \`${policy.action}\``);
    if (policy.max_retries !== undefined) {
      sections.push(`- max_retries: ${policy.max_retries}`);
    }
    if (policy.then) {
      sections.push(`- then: \`${policy.then}\``);
    }
    sections.push("");

    // Explain what this means in plain language
    switch (name) {
      case "manager":
        sections.push("The manager must write at least one journal entry and update compaction docs. If non-compliant, an alert is sent (no retries — managers are trusted to self-correct).");
        break;
      case "employee":
        sections.push("Employees must transition (or fail) at least one task and write a journal entry. If non-compliant, the session is retried up to 3 times. After 3 failures, an alert is sent to the manager.");
        break;
    }
    sections.push("");
  }

  return sections.join("\n");
}
