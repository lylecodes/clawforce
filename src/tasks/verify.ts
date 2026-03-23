/**
 * Clawforce — Verification
 *
 * Enqueues a verifier session to check task output via the dispatch queue.
 * Enforces different-actor requirement for the verifier gate.
 */

import type { DatabaseSync } from "node:sqlite";
import { getTask, getTaskEvidence, transitionTask } from "./ops.js";
import { enqueue } from "../dispatch/queue.js";
import { recordReview } from "../telemetry/review-store.js";
import { safeLog } from "../diagnostics.js";
import type { TransitionResult } from "../types.js";

export type VerificationRequest = {
  projectId: string;
  taskId: string;
  projectDir: string;
  verifierProfile?: string;
  verifierModel?: string;
  verificationPrompt?: string;
  timeoutMs?: number;
};

export type VerificationResult = {
  ok: boolean;
  queued: boolean;
  reason: string;
  queueItemId?: string;
};

/**
 * Enqueue a verification request through the dispatch queue.
 * Returns immediately — verification runs asynchronously via the dispatch loop.
 */
export function requestVerification(request: VerificationRequest): VerificationResult {
  const { projectId, taskId, projectDir, verifierProfile, verifierModel, timeoutMs } = request;

  const task = getTask(projectId, taskId);
  if (!task) {
    return { ok: false, queued: false, reason: "Task not found" };
  }

  if (task.state !== "REVIEW") {
    return { ok: false, queued: false, reason: `Task is in ${task.state}, expected REVIEW` };
  }

  const evidence = getTaskEvidence(projectId, taskId);
  const evidenceSummary = evidence
    .map((e) => `[${e.type}] ${e.content.slice(0, 500)}${e.content.length > 500 ? "..." : ""}`)
    .join("\n\n---\n\n");

  const prompt = request.verificationPrompt ?? buildVerificationPrompt(task.title, task.description, evidenceSummary);

  const payload: Record<string, unknown> = { prompt, projectDir };
  if (verifierProfile) payload.profile = verifierProfile;
  if (verifierModel) payload.model = verifierModel;
  if (timeoutMs) payload.timeoutMs = timeoutMs;

  // skipStateCheck=true: REVIEW tasks are normally blocked from dispatch,
  // but verification dispatches are the intended consumer of REVIEW tasks.
  const queueItem = enqueue(projectId, taskId, payload, undefined, undefined, undefined, true);
  if (!queueItem) {
    return { ok: true, queued: false, reason: "Verification already queued (dedup)" };
  }

  return { ok: true, queued: true, reason: "Verification enqueued", queueItemId: queueItem.id };
}

/**
 * Submit a verification verdict and transition the task.
 */
export function submitVerdict(params: {
  projectId: string;
  taskId: string;
  verifier: string;
  passed: boolean;
  reason?: string;
  sessionKey?: string;
}, dbOverride?: DatabaseSync): TransitionResult {
  const { projectId, taskId, verifier, passed, reason, sessionKey } = params;

  // Record the manager review for telemetry (P2 data flow)
  try {
    recordReview({
      projectId,
      taskId,
      reviewerAgentId: verifier,
      sessionKey,
      verdict: passed ? "approved" : "rejected",
      reasoning: reason,
    }, dbOverride);
  } catch (err) {
    safeLog("verify.recordReview", err);
  }

  if (passed) {
    return transitionTask({
      projectId,
      taskId,
      toState: "DONE",
      actor: verifier,
      reason: reason ?? "Verification passed",
    }, dbOverride);
  }

  // Failed — send back to IN_PROGRESS for rework
  return transitionTask({
    projectId,
    taskId,
    toState: "IN_PROGRESS",
    actor: verifier,
    reason: reason ?? "Verification failed — rework needed",
  }, dbOverride);
}

function buildVerificationPrompt(title: string, description: string | undefined, evidenceSummary: string): string {
  return [
    `# Verification Task`,
    ``,
    `You are verifying the output of another agent's work.`,
    ``,
    `## Task: ${title}`,
    description ? `\n## Description\n${description}` : "",
    ``,
    `## Evidence/Output`,
    evidenceSummary,
    ``,
    `## Instructions`,
    `Review the evidence above. Determine if the work meets the task requirements.`,
    ``,
    `Respond with one of:`,
    `- VERDICT: PASS — if the work is acceptable`,
    `- VERDICT: FAIL — if the work needs revision`,
    ``,
    `Include a brief explanation of your reasoning.`,
  ].join("\n");
}
