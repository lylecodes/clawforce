/**
 * Clawforce — Verification
 *
 * Dispatches a verifier session to check task output.
 * Enforces different-actor requirement for the verifier gate.
 */

import { getTask, getTaskEvidence, transitionTask } from "./ops.js";
import { dispatchClaudeCode } from "../dispatch/spawn.js";
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
  passed: boolean;
  reason: string;
  verifierOutput?: string;
  transitionResult?: TransitionResult;
};

export async function requestVerification(request: VerificationRequest): Promise<VerificationResult> {
  const { projectId, taskId, projectDir, verifierProfile, verifierModel, timeoutMs } = request;

  const task = getTask(projectId, taskId);
  if (!task) {
    return { ok: false, passed: false, reason: "Task not found" };
  }

  if (task.state !== "REVIEW") {
    return { ok: false, passed: false, reason: `Task is in ${task.state}, expected REVIEW` };
  }

  const evidence = getTaskEvidence(projectId, taskId);
  const evidenceSummary = evidence
    .map((e) => `[${e.type}] ${e.content.slice(0, 500)}${e.content.length > 500 ? "..." : ""}`)
    .join("\n\n---\n\n");

  const prompt = request.verificationPrompt ?? buildVerificationPrompt(task.title, task.description, evidenceSummary);

  const result = await dispatchClaudeCode({
    task,
    projectDir,
    prompt,
    profile: verifierProfile,
    model: verifierModel,
    timeoutMs,
  });

  if (!result.ok) {
    return {
      ok: false,
      passed: false,
      reason: `Verifier dispatch failed: exit code ${result.exitCode}`,
      verifierOutput: result.stderr,
    };
  }

  // Parse verdict from output — look for PASS/FAIL markers
  const verdict = parseVerdict(result.stdout);

  return {
    ok: true,
    passed: verdict.passed,
    reason: verdict.reason,
    verifierOutput: result.stdout,
  };
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
}): TransitionResult {
  const { projectId, taskId, verifier, passed, reason } = params;

  if (passed) {
    return transitionTask({
      projectId,
      taskId,
      toState: "DONE",
      actor: verifier,
      reason: reason ?? "Verification passed",
    });
  }

  // Failed — send back to IN_PROGRESS for rework
  return transitionTask({
    projectId,
    taskId,
    toState: "IN_PROGRESS",
    actor: verifier,
    reason: reason ?? "Verification failed — rework needed",
  });
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

function parseVerdict(output: string): { passed: boolean; reason: string } {
  const lines = output.split("\n");
  for (const line of lines) {
    const trimmed = line.trim().toUpperCase();
    if (!trimmed.includes("VERDICT:")) continue;
    // Extract the portion after "VERDICT:" to avoid matching stray words before it
    const afterVerdict = trimmed.slice(trimmed.indexOf("VERDICT:") + "VERDICT:".length);
    // Check FAIL first since "PASS" could appear in words like "PASSED" alongside "FAIL"
    if (afterVerdict.includes("FAIL")) {
      return { passed: false, reason: extractReason(output) };
    }
    if (afterVerdict.includes("PASS")) {
      return { passed: true, reason: extractReason(output) };
    }
  }
  // Default to fail if no clear verdict
  return { passed: false, reason: "No clear PASS/FAIL verdict in verifier output" };
}

function extractReason(output: string): string {
  // Take the last paragraph as the reason summary
  const paragraphs = output.trim().split(/\n\n+/);
  return paragraphs[paragraphs.length - 1]?.trim().slice(0, 500) ?? "No reason provided";
}
