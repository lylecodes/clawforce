/**
 * Clawforce — Worker context builder
 *
 * Builds a narrow, focused prompt for dispatched workers.
 * Workers get only their task details, relevant evidence from prior attempts,
 * and the specific instructions — not the full task board.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { getTask, getTaskEvidence } from "../tasks/ops.js";
import { buildRetryContext } from "../tasks/retry.js";
import type { Evidence, Task } from "../types.js";

export type WorkerContextResult = {
  prompt: string;
  task: Task;
  evidence: Evidence[];
};

/**
 * Build a focused context for a worker dispatched to execute a specific task.
 * Returns null if the task doesn't exist.
 */
export function buildWorkerContext(options: {
  projectId: string;
  taskId: string;
  instructions: string;
  maxEvidenceChars?: number;
  dbOverride?: DatabaseSync;
}): WorkerContextResult | null {
  const { projectId, taskId, instructions, maxEvidenceChars = 5000 } = options;
  const db = options.dbOverride ?? getDb(projectId);

  const task = getTask(projectId, taskId, db);
  if (!task) return null;

  const evidence = getTaskEvidence(projectId, taskId, db);
  const lines: string[] = [];

  // Header
  lines.push(`# Task: ${task.title}`);
  lines.push(`**ID:** ${task.id} | **Priority:** ${task.priority} | **State:** ${task.state}`);
  if (task.assignedTo) lines.push(`**Assigned to:** ${task.assignedTo}`);
  if (task.deadline) {
    const remaining = task.deadline - Date.now();
    if (remaining > 0) {
      const hours = Math.floor(remaining / 3_600_000);
      const mins = Math.floor((remaining % 3_600_000) / 60_000);
      lines.push(`**Deadline:** ${hours}h ${mins}m remaining`);
    } else {
      lines.push(`**Deadline:** OVERDUE`);
    }
  }
  lines.push("");

  // Description
  if (task.description) {
    lines.push("## Description", "", task.description, "");
  }

  // Tags
  if (task.tags && task.tags.length > 0) {
    lines.push(`**Tags:** ${task.tags.join(", ")}`, "");
  }

  // Retry context if this is a retry
  if (task.retryCount > 0) {
    const retryCtx = buildRetryContext(projectId, taskId);
    if (retryCtx && retryCtx.previousAttempts.length > 0) {
      lines.push("## Previous Attempts", "");
      lines.push(`This is retry ${task.retryCount}/${task.maxRetries}.`, "");
      for (const attempt of retryCtx.previousAttempts) {
        lines.push(`### Attempt ${attempt.attemptNumber}`);
        if (attempt.failureReason) {
          lines.push(`**Failure:** ${attempt.failureReason}`);
        }
        if (attempt.evidence.length > 0) {
          lines.push("**Evidence from attempt:**");
          let evidenceChars = 0;
          for (const ev of attempt.evidence) {
            if (evidenceChars >= maxEvidenceChars) {
              lines.push("  [further evidence truncated]");
              break;
            }
            const content = ev.content.slice(0, maxEvidenceChars - evidenceChars);
            evidenceChars += content.length;
            lines.push(`  - [${ev.type}] ${content}`);
          }
        }
        lines.push("");
      }
    }
  } else if (evidence.length > 0) {
    // Show relevant evidence even on first attempt (e.g., attached context)
    lines.push("## Attached Evidence", "");
    let evidenceChars = 0;
    for (const ev of evidence) {
      if (evidenceChars >= maxEvidenceChars) {
        lines.push("[further evidence truncated]");
        break;
      }
      const content = ev.content.slice(0, maxEvidenceChars - evidenceChars);
      evidenceChars += content.length;
      lines.push(`### ${ev.type} (by ${ev.attachedBy})`, "", content, "");
    }
  }

  // Instructions
  lines.push("## Instructions", "", instructions, "");

  // Completion requirements
  lines.push(
    "## Deliverables",
    "",
    "When done, attach evidence of your work using the clawforce_task tool:",
    "1. Use action `attach_evidence` with your output/results",
    "2. Use action `transition` to move the task to REVIEW",
    "",
    "If you encounter a blocker, transition the task to BLOCKED with a reason.",
    "If the task cannot be completed, transition to FAILED with a reason.",
  );

  return {
    prompt: lines.join("\n"),
    task,
    evidence,
  };
}
