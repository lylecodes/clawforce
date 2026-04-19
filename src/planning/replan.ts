/**
 * Clawforce — Adaptive re-planning
 *
 * When a task exhausts retries, instead of just escalating,
 * gather failure evidence and trigger structured re-planning.
 *
 * Strategies:
 * - manager: high-priority nudge to manager with failure analysis (default)
 * - escalate_human: create proposal for human intervention
 *
 * Re-plan history is tracked to prevent infinite loops.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { writeAuditEntry } from "../audit.js";

export type FailureAnalysis = {
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  priority: string;
  totalAttempts: number;
  maxRetries: number;
  assignedTo?: string;
  failureEvidence: FailureEvidence[];
  replanCount: number;
  goalId?: string;
  workflowId?: string;
};

export type FailureEvidence = {
  attempt: number;
  reason?: string;
  actor: string;
  at: number;
  evidence: Array<{ type: string; content: string }>;
};

/**
 * Gather all failure evidence for a task that has exhausted retries.
 * Collects evidence from each failed attempt for structured analysis.
 */
export function gatherFailureAnalysis(
  projectId: string,
  taskId: string,
  dbOverride?: DatabaseSync,
): FailureAnalysis | null {
  const db = dbOverride ?? getDb(projectId);

  // Get task details
  const task = db.prepare(
    "SELECT id, title, description, priority, retry_count, max_retries, assigned_to, goal_id, workflow_id, metadata FROM tasks WHERE id = ? AND project_id = ?",
  ).get(taskId, projectId) as Record<string, unknown> | undefined;

  if (!task) return null;

  // Get replan count from metadata
  let replanCount = 0;
  try {
    const metadata = task.metadata ? JSON.parse(task.metadata as string) : {};
    replanCount = metadata.replan_count ?? 0;
  } catch { /* */ }

  // Get all FAILED transitions with reasons
  const failedTransitions = db.prepare(`
    SELECT from_state, to_state, actor, reason, created_at
    FROM transitions
    WHERE task_id = ? AND to_state = 'FAILED'
    ORDER BY created_at ASC
  `).all(taskId) as Record<string, unknown>[];

  // Get all evidence attached to the task
  const allEvidence = db.prepare(
    "SELECT type, content, attached_by, attached_at FROM evidence WHERE task_id = ? ORDER BY attached_at ASC",
  ).all(taskId) as Record<string, unknown>[];

  // Build per-attempt failure evidence
  const failureEvidence: FailureEvidence[] = failedTransitions.map((tr, idx) => {
    const failedAt = tr.created_at as number;
    // Find evidence attached around this failure (within 5 minutes before)
    const relevantEvidence = allEvidence.filter((e) => {
      const attachedAt = e.attached_at as number;
      return attachedAt <= failedAt && attachedAt > failedAt - 300_000;
    });

    return {
      attempt: idx + 1,
      reason: (tr.reason as string) ?? undefined,
      actor: tr.actor as string,
      at: failedAt,
      evidence: relevantEvidence.map((e) => ({
        type: e.type as string,
        content: (e.content as string).slice(0, 1000), // Cap evidence length
      })),
    };
  });

  return {
    taskId,
    taskTitle: task.title as string,
    taskDescription: (task.description as string) ?? undefined,
    priority: task.priority as string,
    totalAttempts: task.retry_count as number,
    maxRetries: task.max_retries as number,
    assignedTo: (task.assigned_to as string) ?? undefined,
    failureEvidence,
    replanCount,
    goalId: (task.goal_id as string) ?? undefined,
    workflowId: (task.workflow_id as string) ?? undefined,
  };
}

/**
 * Format failure analysis as a structured markdown report
 * for injection into manager context.
 */
export function formatFailureAnalysis(analysis: FailureAnalysis): string {
  const lines: string[] = [
    `### Re-plan Required: ${analysis.taskTitle}`,
    "",
    `**Task:** \`${analysis.taskId}\` | **Priority:** ${analysis.priority} | **Attempts:** ${analysis.totalAttempts}/${analysis.maxRetries}`,
  ];

  if (analysis.assignedTo) lines.push(`**Last assigned to:** ${analysis.assignedTo}`);
  if (analysis.replanCount > 0) lines.push(`**Previous re-plans:** ${analysis.replanCount}`);
  if (analysis.taskDescription) lines.push("", analysis.taskDescription);

  lines.push("", "**Failure history:**");
  for (const fe of analysis.failureEvidence) {
    lines.push(`- **Attempt ${fe.attempt}:** ${fe.reason ?? "No reason given"} (${fe.actor})`);
    for (const e of fe.evidence.slice(0, 3)) {
      lines.push(`  - ${e.type}: ${e.content.slice(0, 200)}${e.content.length > 200 ? "…" : ""}`);
    }
  }

  lines.push("");
  lines.push("**Options:** decompose differently, reassign to another agent, simplify scope, or escalate to human.");

  return lines.join("\n");
}

/**
 * Increment the replan counter on a task and record the replan to audit.
 * Returns false if the max replan limit has been hit.
 */
export function recordReplanAttempt(
  projectId: string,
  taskId: string,
  maxReplans: number = 3,
  dbOverride?: DatabaseSync,
): { ok: true; replanCount: number } | { ok: false; reason: string } {
  const db = dbOverride ?? getDb(projectId);

  // Get current replan count
  const task = db.prepare(
    "SELECT metadata FROM tasks WHERE id = ? AND project_id = ?",
  ).get(taskId, projectId) as Record<string, unknown> | undefined;

  if (!task) return { ok: false, reason: "Task not found" };

  let metadata: Record<string, unknown> = {};
  try {
    metadata = task.metadata ? JSON.parse(task.metadata as string) : {};
  } catch { /* */ }

  const currentCount = (metadata.replan_count as number) ?? 0;

  if (currentCount >= maxReplans) {
    return { ok: false, reason: `Max re-plans (${maxReplans}) exhausted. Requires human intervention.` };
  }

  const newCount = currentCount + 1;

  // Update metadata
  db.prepare(
    "UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.replan_count', ?, '$.last_replan_at', ?) WHERE id = ? AND project_id = ?",
  ).run(newCount, Date.now(), taskId, projectId);

  // Audit
  writeAuditEntry({
    projectId,
    actor: "system:replan",
    action: "replan_attempt",
    targetType: "task",
    targetId: taskId,
    detail: JSON.stringify({ replanCount: newCount, maxReplans }),
  }, db);

  return { ok: true, replanCount: newCount };
}

/**
 * Build a replan context message for the manager.
 * Includes failure analysis and suggested actions.
 */
export function buildReplanContext(
  analyses: FailureAnalysis[],
): string | null {
  if (analyses.length === 0) return null;

  const lines: string[] = [
    "## Re-planning Required",
    "",
    `${analyses.length} task(s) have exhausted retries and need re-planning:`,
    "",
  ];

  for (const analysis of analyses.slice(0, 5)) {
    lines.push(formatFailureAnalysis(analysis));
    lines.push("");
  }

  if (analyses.length > 5) {
    lines.push(`…and ${analyses.length - 5} more tasks requiring re-planning.`);
  }

  lines.push("Use OODA to analyze each failure: **Observe** the evidence → **Orient** against goals → **Decide** on a new approach → **Act** (create new tasks, reassign, or escalate).");

  return lines.join("\n");
}
