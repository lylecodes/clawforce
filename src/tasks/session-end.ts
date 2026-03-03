/**
 * Clawforce — Worker session-end auto-capture
 *
 * When a tracked worker session ends (cron run or subagent completion),
 * automatically attaches whatever error/outcome context is available as
 * evidence and transitions the task to FAILED — so the orchestrator always
 * gets "last words" even if the worker never called the task tool.
 */

import type { DatabaseSync } from "node:sqlite";
import { attachEvidence, transitionTask } from "./ops.js";
import { getTask } from "./ops.js";
import type { EvidenceType } from "../types.js";
import {
  getTrackedWorker,
  untrackWorkerSession,
} from "./compliance.js";

export type SessionEndOutcome = {
  status: "ok" | "error" | "timeout" | "unknown";
  error?: string;
  summary?: string;
};

/**
 * Handle a worker session ending. If the worker didn't transition its task,
 * attach available failure context as evidence and move to FAILED.
 *
 * Returns true if enforcement action was taken.
 */
export function handleWorkerSessionEnd(params: {
  sessionKey: string;
  status: "ok" | "error" | "timeout" | "unknown";
  error?: string;
  summary?: string;
  dbOverride?: DatabaseSync;
}): boolean {
  const { sessionKey, status, error, summary, dbOverride } = params;

  const entry = getTrackedWorker(sessionKey);
  if (!entry || entry.compliant) return false;

  const task = getTask(entry.projectId, entry.taskId, dbOverride);
  if (!task) {
    untrackWorkerSession(sessionKey);
    return false;
  }

  // Only act on tasks still in active states
  if (task.state !== "ASSIGNED" && task.state !== "IN_PROGRESS") {
    untrackWorkerSession(sessionKey);
    return false;
  }

  // Build evidence from whatever context we have
  const evidenceLines: string[] = [`Session ended with status: ${status}`];
  if (error) evidenceLines.push(`Error: ${error}`);
  if (summary) evidenceLines.push(`Summary: ${summary}`);
  const evidenceContent = evidenceLines.join("\n");

  attachEvidence(
    {
      projectId: entry.projectId,
      taskId: entry.taskId,
      type: "log" as EvidenceType,
      content: evidenceContent,
      attachedBy: "system:session-end",
    },
    dbOverride,
  );

  // Derive reason from status
  const reasonMap: Record<string, string> = {
    error: "Worker session ended with error",
    timeout: "Worker session timed out",
    unknown: "Worker session ended without completing task",
    ok: "Worker session ended without transitioning task",
  };

  transitionTask(
    {
      projectId: entry.projectId,
      taskId: entry.taskId,
      toState: "FAILED",
      actor: "system:session-end",
      reason: reasonMap[status] ?? reasonMap.unknown!,
      verificationRequired: false,
    },
    dbOverride,
  );

  untrackWorkerSession(sessionKey);
  return true;
}

/**
 * Public API for callers (gateway cron completion, subagent ended hook).
 * Delegates to handleWorkerSessionEnd.
 */
export function notifyWorkerSessionEnd(
  sessionKey: string,
  outcome: SessionEndOutcome,
  dbOverride?: DatabaseSync,
): boolean {
  return handleWorkerSessionEnd({
    sessionKey,
    ...outcome,
    dbOverride,
  });
}
