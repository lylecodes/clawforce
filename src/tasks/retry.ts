/**
 * Clawforce — Retry context builder
 *
 * Gathers previous attempts and failure reasons for retry prompts.
 * Used when a task is sent back from REVIEW or retried from FAILED.
 */

import { getTask, getTaskEvidence, getTaskTransitions } from "./ops.js";
import type { Evidence, Transition } from "../types.js";

export type RetryContext = {
  taskId: string;
  attemptNumber: number;
  maxRetries: number;
  previousAttempts: PreviousAttempt[];
  summary: string;
};

export type PreviousAttempt = {
  attemptNumber: number;
  evidence: Evidence[];
  failureReason?: string;
  failedAt: number;
};

export function buildRetryContext(projectId: string, taskId: string): RetryContext | null {
  const task = getTask(projectId, taskId);
  if (!task) return null;

  const transitions = getTaskTransitions(projectId, taskId);
  const evidence = getTaskEvidence(projectId, taskId);

  // Find review rejection transitions (REVIEW → IN_PROGRESS or REVIEW → FAILED)
  const rejections = transitions.filter(
    (t) => t.fromState === "REVIEW" && (t.toState === "IN_PROGRESS" || t.toState === "FAILED"),
  );

  // Find failure transitions (any → FAILED)
  const failures = transitions.filter((t) => t.toState === "FAILED");

  // Build previous attempts from rejections and failures
  const attempts: PreviousAttempt[] = [];
  const allFailEvents = [...rejections, ...failures];

  // Sort by creation time
  allFailEvents.sort((a, b) => a.createdAt - b.createdAt);

  // Deduplicate by timestamp window (within 1 second = same event)
  const deduped: Transition[] = [];
  for (const t of allFailEvents) {
    const last = deduped[deduped.length - 1];
    if (!last || Math.abs(t.createdAt - last.createdAt) > 1000) {
      deduped.push(t);
    }
  }

  for (let i = 0; i < deduped.length; i++) {
    const failTransition = deduped[i]!;

    // Find evidence attached before this failure
    const attemptEvidence = evidence.filter((e) => e.attachedAt <= failTransition.createdAt);

    // For subsequent attempts, only include evidence after the previous failure
    const prevFail = i > 0 ? deduped[i - 1]! : null;
    const relevantEvidence = prevFail
      ? attemptEvidence.filter((e) => e.attachedAt > prevFail.createdAt)
      : attemptEvidence;

    attempts.push({
      attemptNumber: i + 1,
      evidence: relevantEvidence,
      failureReason: failTransition.reason,
      failedAt: failTransition.createdAt,
    });
  }

  const attemptNumber = attempts.length + 1;

  const summary = buildRetrySummary(attempts, task.title);

  return {
    taskId,
    attemptNumber,
    maxRetries: task.maxRetries,
    previousAttempts: attempts,
    summary,
  };
}

function buildRetrySummary(attempts: PreviousAttempt[], title: string): string {
  if (attempts.length === 0) {
    return `This is the first attempt for "${title}".`;
  }

  const parts: string[] = [
    `# Retry Context for "${title}"`,
    `This is attempt #${attempts.length + 1}.`,
    ``,
  ];

  for (const attempt of attempts) {
    parts.push(`## Attempt #${attempt.attemptNumber}`);
    if (attempt.failureReason) {
      parts.push(`**Failure reason:** ${attempt.failureReason}`);
    }
    if (attempt.evidence.length > 0) {
      parts.push(`**Evidence from this attempt:**`);
      for (const e of attempt.evidence) {
        const preview = e.content.slice(0, 200) + (e.content.length > 200 ? "..." : "");
        parts.push(`- [${e.type}] ${preview}`);
      }
    }
    parts.push("");
  }

  parts.push("**Please address the issues from previous attempts and try a different approach if needed.**");

  return parts.join("\n");
}

/**
 * Build a retry-aware dispatch prompt that includes context from previous failures.
 */
export function buildRetryPrompt(projectId: string, taskId: string, basePrompt: string): string {
  const ctx = buildRetryContext(projectId, taskId);
  if (!ctx || ctx.previousAttempts.length === 0) {
    return basePrompt;
  }

  return `${ctx.summary}\n\n---\n\n${basePrompt}`;
}
