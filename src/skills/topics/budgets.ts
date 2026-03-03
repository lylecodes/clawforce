/**
 * Clawforce skill topic — Budgets
 *
 * Documents budget configuration and enforcement.
 */

export function generate(): string {
  // Budget config fields from BudgetConfig type
  const budgetFields: Array<{ name: string; yamlKey: string; description: string }> = [
    { name: "dailyLimitCents", yamlKey: "daily_limit", description: "Maximum spend per day (in dollars in YAML, stored as cents). Resets at midnight UTC." },
    { name: "sessionLimitCents", yamlKey: "session_limit", description: "Maximum spend per agent session (in dollars in YAML, stored as cents)." },
    { name: "taskLimitCents", yamlKey: "task_limit", description: "Maximum spend per task (in dollars in YAML, stored as cents)." },
  ];

  const sections: string[] = [
    "# Budgets",
    "",
    "Budgets limit spending at the project and agent level. When a budget is exceeded, further actions are blocked until the budget resets or is adjusted.",
    "",

    "## Budget Config Structure",
    "",
    "| Field | YAML Key | Description |",
    "| --- | --- | --- |",
  ];

  for (const field of budgetFields) {
    sections.push(`| \`${field.name}\` | \`${field.yamlKey}\` | ${field.description} |`);
  }

  sections.push("");
  sections.push("All limits are specified in dollars in the YAML config and stored internally as cents.");
  sections.push("");

  sections.push("## Project-Level vs Agent-Level Budgets");
  sections.push("");
  sections.push("- **Project-level budget**: Applies to all spending across the entire project. Defined under `budgets.project`.");
  sections.push("- **Agent-level budget**: Applies to a specific agent's spending. Defined under `budgets.agents.<agent-id>`. Checked first (more specific).");
  sections.push("");
  sections.push("Both levels are checked independently. If either budget is exceeded, the action is blocked.");
  sections.push("");

  sections.push("## Defining Budgets in project.yaml");
  sections.push("");
  sections.push("```yaml");
  sections.push("budgets:");
  sections.push("  project:");
  sections.push("    daily_limit: 50.00    # $50/day for the whole project");
  sections.push("    session_limit: 10.00  # $10 per session");
  sections.push("");
  sections.push("  agents:");
  sections.push("    dev-1:");
  sections.push("      daily_limit: 20.00  # $20/day for this agent");
  sections.push("      task_limit: 5.00    # $5 per task");
  sections.push("    dev-2:");
  sections.push("      daily_limit: 15.00");
  sections.push("```");
  sections.push("");

  sections.push("## Budget Checks");
  sections.push("");
  sections.push("Budget checks happen through the `spend_limit` policy type. When a budget check fails, it returns:");
  sections.push("");
  sections.push("- `ok: false` with a reason describing which limit was exceeded");
  sections.push("- `remaining`: the amount remaining before the limit (0 if exceeded)");
  sections.push("");

  sections.push("## Daily Reset");
  sections.push("");
  sections.push("Daily budget counters reset at midnight UTC. The reset is handled automatically by the sweep service.");
  sections.push("");

  return sections.join("\n");
}
