/**
 * Clawforce skill topic — Tasks
 *
 * Generated from task state machine constants.
 */

import { TASK_STATES, TASK_PRIORITIES, EVIDENCE_TYPES } from "../../types.js";
import { getValidNextStates } from "../../tasks/state-machine.js";

export function generate(): string {
  const sections: string[] = [
    "# Task Management",
    "",
    "Tasks are the atomic unit of work in Clawforce. Each task has a state, priority, optional assignee, and an evidence trail.",
    "",

    "## Task States",
    "",
    "| State | Valid Next States |",
    "| --- | --- |",
  ];

  for (const state of TASK_STATES) {
    const nextStates = getValidNextStates(state);
    const nextStr = nextStates.length > 0 ? nextStates.join(", ") : "_(terminal)_";
    sections.push(`| \`${state}\` | ${nextStr} |`);
  }
  sections.push("");

  // Happy path
  sections.push("## Happy Path");
  sections.push("");
  sections.push("`OPEN` -> `ASSIGNED` -> `IN_PROGRESS` -> `REVIEW` -> `DONE`");
  sections.push("");

  // State machine rules
  sections.push("## State Machine Rules");
  sections.push("");
  sections.push("### Evidence Required: IN_PROGRESS -> REVIEW");
  sections.push("");
  sections.push("Evidence must be attached before transitioning from `IN_PROGRESS` to `REVIEW`. Use `clawforce_task attach_evidence` to attach evidence of type: " + EVIDENCE_TYPES.map(t => `\`${t}\``).join(", ") + ".");
  sections.push("");

  sections.push("### Verifier Gate: REVIEW -> DONE / FAILED / IN_PROGRESS");
  sections.push("");
  sections.push("When verification is required, the actor performing the REVIEW transition must be a different agent than the task assignee. This prevents self-grading. The verifier can move the task to `DONE` (approved), `FAILED` (rejected), or back to `IN_PROGRESS` (rework needed).");
  sections.push("");

  sections.push("### Retry Limits: FAILED -> OPEN");
  sections.push("");
  sections.push("A failed task can be retried by transitioning back to `OPEN`, but only if `retryCount < maxRetries`. When max retries are exhausted, the transition is blocked with `RETRY_EXHAUSTED`.");
  sections.push("");

  sections.push("### Cancellation");
  sections.push("");
  sections.push("Any non-terminal state can be cancelled by transitioning to `CANCELLED`. Cancelled is a terminal state with no further transitions.");
  sections.push("");

  // Task priorities
  sections.push("## Task Priorities");
  sections.push("");
  for (const priority of TASK_PRIORITIES) {
    let description: string;
    switch (priority) {
      case "P0": description = "Critical — highest urgency"; break;
      case "P1": description = "High"; break;
      case "P2": description = "Medium (default)"; break;
      case "P3": description = "Low"; break;
    }
    sections.push(`- **${priority}**: ${description}`);
  }
  sections.push("");

  // Evidence types
  sections.push("## Evidence Types");
  sections.push("");
  for (const type of EVIDENCE_TYPES) {
    let description: string;
    switch (type) {
      case "output": description = "Command or tool output"; break;
      case "diff": description = "Code diff or patch"; break;
      case "test_result": description = "Test suite results"; break;
      case "screenshot": description = "Visual evidence"; break;
      case "log": description = "Log entries"; break;
      case "custom": description = "Free-form evidence"; break;
    }
    sections.push(`- **${type}**: ${description}`);
  }
  sections.push("");

  return sections.join("\n");
}
