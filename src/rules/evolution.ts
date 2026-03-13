/**
 * Clawforce — Evolution Pipeline
 *
 * Provides the evolution prompt injected into orchestrator ghost turns,
 * encouraging them to flag repeated decisions for rule codification.
 */

/**
 * Format the evolution prompt for orchestrator agents.
 * This gets injected into ghost turns alongside expectations reminders.
 */
export function formatEvolutionPrompt(): string {
  return [
    "## System Evolution",
    "",
    "When you make a judgment call not covered by existing rules, document your reasoning clearly.",
    "If you notice yourself making the same type of decision repeatedly, flag it as a rule candidate",
    "using the ops-tool `flag_knowledge` action with `source_type: \"decision_pattern\"`.",
    "",
    "Rules are pre-built prompt templates with trigger conditions. Converting repeated decisions",
    "into rules makes the system faster and cheaper — no LLM cost for the routing decision.",
    "",
    "Good rule candidates look like:",
    "- \"Every time a deploy task completes, I assign a reviewer\" → deploy-review rule",
    "- \"When budget exceeds 80%, I always alert the admin\" → budget-alert rule",
    "- \"Whenever a new task has the security tag, I route to the security agent\" → security-routing rule",
  ].join("\n");
}
