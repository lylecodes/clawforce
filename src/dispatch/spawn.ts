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

function readEntityIssueMetadata(task: Task): Record<string, unknown> | null {
  const metadata = task.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const issueMeta = (metadata as Record<string, unknown>).entityIssue;
  if (!issueMeta || typeof issueMeta !== "object" || Array.isArray(issueMeta)) return null;
  return issueMeta as Record<string, unknown>;
}

function buildEntityIssueFocus(task: Task): string | null {
  const issueMeta = readEntityIssueMetadata(task);
  if (!issueMeta) return null;

  const lines = [
    "## Linked Entity Issue",
    typeof issueMeta.issueId === "string" ? `Issue id: ${issueMeta.issueId}` : undefined,
    typeof issueMeta.issueKey === "string" ? `Issue key: ${issueMeta.issueKey}` : undefined,
    typeof issueMeta.issueType === "string" ? `Issue type: ${issueMeta.issueType}` : undefined,
    typeof issueMeta.playbook === "string" ? `Playbook: ${issueMeta.playbook}` : undefined,
    "",
    "## Issue Focus",
    "- Treat the linked entity issue for this task as the primary source of truth.",
    "- Background board context, recurring sweeps, and old backlog notes are secondary. If they conflict with this issue, follow this issue.",
    "- Do not conclude that no action is needed unless you verify that the issue is already resolved or that another active governed task already owns this exact issue.",
    "- If the issue is still open and unowned, create or update the governed follow-on work needed to move it forward before you finish.",
  ].filter((line): line is string => Boolean(line));

  return lines.join("\n");
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
  const entityIssueFocus = buildEntityIssueFocus(task);
  if (entityIssueFocus) {
    parts.push(`\n${entityIssueFocus}`);
  }
  parts.push(`\n${getExecutionStandards()}`);
  parts.push(`\n## Instructions\n${userPrompt}`);

  return parts.join("\n");
}
