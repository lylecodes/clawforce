/**
 * Clawforce — Notification integrations
 *
 * Thin wrappers that emit notifications for key system events.
 * These are called from event points throughout the codebase to produce
 * persistent operator-facing notification records.
 */

import type { DatabaseSync } from "node:sqlite";
import { emitNotification } from "./emitter.js";
import { safeLog } from "../diagnostics.js";

/**
 * Emit a notification when a new approval proposal is created.
 */
export function notifyApprovalCreated(
  projectId: string,
  proposalId: string,
  title: string,
  proposedBy: string,
  dbOverride?: DatabaseSync,
): void {
  try {
    emitNotification(
      projectId,
      {
        category: "approval",
        severity: "warning",
        actionability: "action-required",
        title: `Approval required: ${title}`,
        body: `${proposedBy} is requesting approval for: ${title}`,
        destination: `/clawforce/approvals`,
        focusContext: { proposalId },
      },
      dbOverride,
    );
  } catch (err) {
    safeLog("notification.approval.created", err);
  }
}

/**
 * Emit a notification when a task transitions to the failed state.
 */
export function notifyTaskFailed(
  projectId: string,
  taskId: string,
  taskTitle: string,
  assignedTo: string | null | undefined,
  dbOverride?: DatabaseSync,
): void {
  try {
    emitNotification(
      projectId,
      {
        category: "task",
        severity: "warning",
        actionability: "dismissible",
        title: `Task failed: ${taskTitle}`,
        body: assignedTo
          ? `Task "${taskTitle}" assigned to ${assignedTo} has failed.`
          : `Task "${taskTitle}" has failed.`,
        destination: `/clawforce/tasks`,
        focusContext: { taskId },
      },
      dbOverride,
    );
  } catch (err) {
    safeLog("notification.task.failed", err);
  }
}

/**
 * Emit a notification when a budget limit is exceeded.
 */
export function notifyBudgetExceeded(
  projectId: string,
  window: string,
  spentCents: number,
  limitCents: number,
  dbOverride?: DatabaseSync,
): void {
  try {
    const spent = (spentCents / 100).toFixed(2);
    const limit = (limitCents / 100).toFixed(2);
    emitNotification(
      projectId,
      {
        category: "budget",
        severity: "critical",
        actionability: "action-required",
        title: `Budget exceeded: ${window} limit`,
        body: `${window} budget exceeded — $${spent} spent of $${limit} limit.`,
        destination: `/clawforce/budget`,
        focusContext: { window },
      },
      dbOverride,
    );
  } catch (err) {
    safeLog("notification.budget.exceeded", err);
  }
}

/**
 * Emit a notification when the kill switch (emergency stop) is activated.
 */
export function notifyKillSwitchActivated(
  projectId: string,
  reason: string,
  actor: string,
  dbOverride?: DatabaseSync,
): void {
  try {
    emitNotification(
      projectId,
      {
        category: "system",
        severity: "critical",
        actionability: "action-required",
        title: "Kill switch activated",
        body: `Emergency stop activated by ${actor}. Reason: ${reason}. All agent tool calls are blocked.`,
        destination: `/clawforce/dashboard`,
        focusContext: { actor },
      },
      dbOverride,
    );
  } catch (err) {
    safeLog("notification.killswitch.activated", err);
  }
}

/**
 * Emit a notification when a health alert fires.
 */
export function notifyHealthAlert(
  projectId: string,
  alertName: string,
  reason: string,
  severity: "critical" | "warning" | "info" = "warning",
  dbOverride?: DatabaseSync,
): void {
  try {
    emitNotification(
      projectId,
      {
        category: "health",
        severity,
        actionability: severity === "critical" ? "action-required" : "dismissible",
        title: `Health alert: ${alertName}`,
        body: reason,
        destination: `/clawforce/health`,
        focusContext: { alertName },
      },
      dbOverride,
    );
  } catch (err) {
    safeLog("notification.health.alert", err);
  }
}
