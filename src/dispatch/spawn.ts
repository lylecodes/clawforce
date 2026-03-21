/**
 * Clawforce — Task prompt builder
 *
 * Builds structured prompts for dispatched agent sessions.
 * Wraps task metadata in XML delimiters for injection resistance.
 */

import type { Task } from "../types.js";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function buildTaskPrompt(task: Task, userPrompt: string): string {
  const parts: string[] = [
    `# Task: ${task.id}`,
    `\n<task-metadata title="${escapeXml(task.title)}">`,
  ];

  if (task.description) {
    parts.push(`## Description\n${task.description}`);
  }

  if (task.tags && task.tags.length > 0) {
    parts.push(`Tags: ${task.tags.join(", ")}`);
  }

  parts.push(`</task-metadata>`);
  parts.push(`\n## Instructions\n${userPrompt}`);

  // ClawForce tool lifecycle — agents must follow this
  parts.push(`\n## Required: ClawForce Task Lifecycle

IMPORTANT: You have ClawForce MCP tools. Follow this lifecycle:

1. FIRST: Call clawforce_task with action=transition, task_id=${task.id}, project_id=${task.projectId}, new_state=IN_PROGRESS
2. Execute the task instructions above
3. Call clawforce_log with action=write, project_id=${task.projectId}, category=outcome, content=(brief summary of what you did)
4. Call clawforce_task with action=transition, task_id=${task.id}, project_id=${task.projectId}, new_state=REVIEW

Do not skip these steps.`);

  return parts.join("\n");
}
