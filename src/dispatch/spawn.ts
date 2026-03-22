/**
 * Clawforce — Task prompt builder
 *
 * Builds structured prompts for dispatched agent sessions.
 * Wraps task metadata in XML delimiters for injection resistance.
 * Includes execution standards for auto-lifecycle compliance.
 */

import type { Task } from "../types.js";
import { getExecutionStandards } from "../context/standards.js";

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
  parts.push(`\n${getExecutionStandards()}`);
  parts.push(`\n## Instructions\n${userPrompt}`);

  return parts.join("\n");
}
