/**
 * Clawforce — Worker completion enforcement
 *
 * Tracks whether worker sessions properly transition their assigned tasks
 * before completing. Non-compliant workers (those that finish without
 * transitioning) get their tasks auto-moved to BLOCKED so the manager
 * can re-dispatch or escalate on its next sweep.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import { transitionTask } from "./ops.js";
import { getTask } from "./ops.js";
import { getExtendedProjectConfig } from "../project.js";
import { getDefaultRuntimeState } from "../runtime/default-runtime.js";

type TrackedWorker = {
  projectId: string;
  taskId: string;
  trackedAt: number;
  compliant: boolean;
};

type WorkerComplianceRuntimeState = {
  trackedWorkers: Map<string, TrackedWorker>;
};

const runtime = getDefaultRuntimeState();

function getTrackedWorkers(): WorkerComplianceRuntimeState["trackedWorkers"] {
  return (runtime.taskCompliance as WorkerComplianceRuntimeState).trackedWorkers;
}

/**
 * Register that a worker session is expected to transition a task.
 * Called when the manager dispatches a worker with a task assignment.
 */
export function trackWorkerSession(sessionKey: string, projectId: string, taskId: string): void {
  getTrackedWorkers().set(sessionKey, {
    projectId,
    taskId,
    trackedAt: Date.now(),
    compliant: false,
  });
}

/**
 * Mark a worker session as compliant (it called transition on its task).
 * Called from the clawforce_task tool when a transition action succeeds.
 */
export function markWorkerCompliant(sessionKey: string): void {
  const entry = getTrackedWorkers().get(sessionKey);
  if (entry) {
    entry.compliant = true;
  }
}

/**
 * Get tracked worker entry (for session-end handler).
 */
export function getTrackedWorker(sessionKey: string): TrackedWorker | null {
  return getTrackedWorkers().get(sessionKey) ?? null;
}

/**
 * Check if a specific worker session is compliant.
 */
export function isWorkerCompliant(sessionKey: string): boolean {
  const entry = getTrackedWorkers().get(sessionKey);
  return entry?.compliant ?? true; // untracked sessions are considered compliant
}

/**
 * Get all tracked workers that haven't transitioned their tasks.
 * Used by the sweep to catch stragglers.
 */
export function getIncompliantWorkers(): Array<{
  sessionKey: string;
  projectId: string;
  taskId: string;
  trackedAt: number;
}> {
  const result: Array<{
    sessionKey: string;
    projectId: string;
    taskId: string;
    trackedAt: number;
  }> = [];

  for (const [sessionKey, entry] of getTrackedWorkers()) {
    if (!entry.compliant) {
      result.push({
        sessionKey,
        projectId: entry.projectId,
        taskId: entry.taskId,
        trackedAt: entry.trackedAt,
      });
    }
  }

  return result;
}

/**
 * Enforce compliance for a completed worker session.
 * If the worker didn't transition its task, move it to BLOCKED.
 * Returns true if enforcement action was taken.
 */
export function enforceWorkerCompliance(
  sessionKey: string,
  dbOverride?: DatabaseSync,
  options?: { withinTransaction?: boolean },
): boolean {
  const entry = getTrackedWorkers().get(sessionKey);
  if (!entry || entry.compliant) return false;

  const task = getTask(entry.projectId, entry.taskId, dbOverride);
  if (!task) {
    getTrackedWorkers().delete(sessionKey);
    return false;
  }

  // Only block tasks still in active states (worker should have transitioned these)
  if (task.state !== "ASSIGNED" && task.state !== "IN_PROGRESS") {
    getTrackedWorkers().delete(sessionKey);
    return false;
  }

  // Read non-compliance action from config, default to BLOCKED
  let nonComplianceAction: "BLOCKED" | "REVIEW" | "FAILED" | "alert_only" = "BLOCKED";
  try {
    const extConfig = getExtendedProjectConfig(entry.projectId);
    if (extConfig?.lifecycle?.workerNonComplianceAction) {
      nonComplianceAction = extConfig.lifecycle.workerNonComplianceAction;
    }
  } catch { /* project module may not be available */ }

  if (nonComplianceAction === "alert_only") {
    // Just clean up tracking — no state transition
    getTrackedWorkers().delete(sessionKey);
    return true;
  }

  const result = transitionTask(
    {
      projectId: entry.projectId,
      taskId: entry.taskId,
      toState: nonComplianceAction,
      actor: "system:compliance",
      reason: `Worker completed without transitioning task (action: ${nonComplianceAction})`,
      verificationRequired: false,
      withinTransaction: options?.withinTransaction,
    },
    dbOverride,
  );

  getTrackedWorkers().delete(sessionKey);
  return result.ok;
}

/**
 * Remove tracking for a session (cleanup after enforcement or manual removal).
 */
export function untrackWorkerSession(sessionKey: string): void {
  getTrackedWorkers().delete(sessionKey);
}

/**
 * Clear all tracking (for testing).
 */
export function resetWorkerComplianceForTest(): void {
  getTrackedWorkers().clear();
}
