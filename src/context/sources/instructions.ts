/**
 * Clawforce — Instructions context source
 *
 * Auto-generates enforcement instructions from an agent's required_outputs config.
 * Tells the agent exactly what tools it MUST call before finishing.
 */

import type { Expectation } from "../../types.js";

/**
 * Build enforcement instructions markdown from required outputs.
 */
export function buildInstructions(expectations: Expectation[]): string {
  if (expectations.length === 0) return "";

  const lines: string[] = [
    "## Your Responsibilities",
    "",
    "You are responsible for the following deliverables this work session.",
    "These are required deliverables that are tracked automatically.",
    "",
  ];

  for (const req of expectations) {
    const actions = Array.isArray(req.action)
      ? req.action.join(" or ")
      : req.action;
    const callText = req.min_calls === 1
      ? "at least once"
      : `at least ${req.min_calls} times`;
    lines.push(`- Call \`${req.tool}\` with action \`${actions}\` ${callText}`);
  }

  lines.push("");
  lines.push("These are required deliverables for this work session.");

  return lines.join("\n");
}
