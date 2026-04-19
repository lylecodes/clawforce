/**
 * Clawforce — Failure actions
 *
 * Executes performance-policy actions when agents don't comply.
 * Actions: retry, alert, terminate_and_alert.
 *
 * Retry counting is durable (SQLite-backed) so the counter
 * persists across session boundaries.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { getConsecutiveFailures, getSafetyConfig } from "../safety.js";
import { disableAgent } from "./disabled-store.js";
import type { PerformancePolicy } from "../types.js";
import type { ComplianceResult } from "./check.js";
import { buildRetryPrompt } from "./check.js";
import { countRecentRetries, recordRetryAttempt, resolveMaxRetries } from "./retry-store.js";
import type { SessionMetrics } from "./tracker.js";

export type FailureActionResult = {
  action: string;
  retryPrompt?: string;
  alertMessage?: string;
  disabled?: boolean;
};

/**
 * Execute the configured failure action for a non-compliant session.
 * Retry count is read from the durable store (not session-ephemeral).
 */
export function executeFailureAction(
  policyConfig: PerformancePolicy,
  result: ComplianceResult,
): FailureActionResult {
  // Record the audit run regardless of action
  recordAuditRun(result, "non_compliant");

  // After recording failure, check if agent should be auto-disabled
  try {
    const consecutiveFailures = getConsecutiveFailures(result.projectId, result.agentId);
    const safetyConfig = getSafetyConfig(result.projectId);
    const maxConsecutive = safetyConfig.maxConsecutiveFailures;
    if (consecutiveFailures >= maxConsecutive) {
      disableAgent(result.projectId, result.agentId, `Auto-disabled: ${consecutiveFailures} consecutive failures`);
      return {
        action: "terminate_and_alert",
        alertMessage: `Clawforce: ${result.agentId} auto-disabled after ${consecutiveFailures} consecutive failures (threshold: ${maxConsecutive})`,
        disabled: true,
      };
    }
  } catch (err) {
    safeLog("actions.consecutiveFailureCheck", err);
  }

  switch (policyConfig.action) {
    case "retry": {
      const maxRetries = resolveMaxRetries(policyConfig.max_retries);
      const retryCount = countRecentRetries(result.projectId, result.agentId);
      if (retryCount < maxRetries) {
        recordRetryAttempt(result.projectId, result.agentId, result.sessionKey, "retry");
        const retryPrompt = buildRetryPrompt(result);
        return { action: "retry", retryPrompt };
      }
      // Exhausted retries — fall through to "then" action
      recordRetryAttempt(result.projectId, result.agentId, result.sessionKey, "exhausted");
      if (policyConfig.then === "terminate_and_alert") {
        return {
          action: "terminate_and_alert",
          alertMessage: buildAlertMessage(result, `Exhausted ${maxRetries} retries`),
          disabled: true,
        };
      }
      return {
        action: "alert",
        alertMessage: buildAlertMessage(result, `Exhausted ${maxRetries} retries`),
      };
    }

    case "alert":
      return {
        action: "alert",
        alertMessage: buildAlertMessage(result, "Underperforming session"),
      };

    case "terminate_and_alert":
      return {
        action: "terminate_and_alert",
        alertMessage: buildAlertMessage(result, "Did not meet expectations — employment terminated"),
        disabled: true,
      };

    default:
      return { action: "alert", alertMessage: buildAlertMessage(result, "Unknown failure action") };
  }
}

/**
 * Execute failure action for a crashed session (no compliance check possible).
 * Retry count is read from the durable store.
 */
export function executeCrashAction(
  policyConfig: PerformancePolicy,
  projectId: string,
  agentId: string,
  sessionKey: string,
  error: string | undefined,
  metrics: SessionMetrics | null,
  jobName?: string,
): FailureActionResult {
  // Record crash in audit log
  recordCrashAuditRun(projectId, agentId, sessionKey, error, metrics, jobName);

  // After recording failure, check if agent should be auto-disabled
  try {
    const consecutiveFailures = getConsecutiveFailures(projectId, agentId);
    const safetyConfig = getSafetyConfig(projectId);
    const maxConsecutive = safetyConfig.maxConsecutiveFailures;
    if (consecutiveFailures >= maxConsecutive) {
      disableAgent(projectId, agentId, `Auto-disabled: ${consecutiveFailures} consecutive failures (crashed)`);
      return {
        action: "terminate_and_alert",
        alertMessage: `Clawforce: ${agentId} auto-disabled after ${consecutiveFailures} consecutive failures (threshold: ${maxConsecutive})`,
        disabled: true,
      };
    }
  } catch (err) {
    safeLog("actions.crashConsecutiveFailureCheck", err);
  }

  if (policyConfig.action === "retry") {
    const maxRetries = resolveMaxRetries(policyConfig.max_retries);
    const retryCount = countRecentRetries(projectId, agentId);
    if (retryCount < maxRetries) {
      recordRetryAttempt(projectId, agentId, sessionKey, "retry");
      const metricsInfo = metrics
        ? `\nTool calls made: ${metrics.toolCalls.length}. Last tool: ${metrics.toolCalls.length > 0 ? metrics.toolCalls[metrics.toolCalls.length - 1]!.toolName : "none"}.`
        : "";
      return {
        action: "retry",
        retryPrompt: `## Clawforce — Session Crashed\n\nYour previous session crashed${error ? `: ${error}` : ""}.${metricsInfo}\nPlease complete your required actions in this session.`,
      };
    }
    recordRetryAttempt(projectId, agentId, sessionKey, "exhausted");
    if (policyConfig.then === "terminate_and_alert") {
      return {
        action: "terminate_and_alert",
        alertMessage: `Employee ${agentId} is unresponsive after ${maxRetries} retries. Employment terminated.`,
        disabled: true,
      };
    }
    return {
      action: "alert",
      alertMessage: `Employee ${agentId} is unresponsive after ${maxRetries} retries.`,
    };
  }

  if (policyConfig.action === "terminate_and_alert") {
    return {
      action: "terminate_and_alert",
      alertMessage: `Employee ${agentId} is unresponsive. Employment terminated.`,
      disabled: true,
    };
  }

  return {
    action: "alert",
    alertMessage: `Employee ${agentId} is unresponsive${error ? `: ${error}` : ""}.`,
  };
}

// --- Helpers ---

function buildAlertMessage(result: ComplianceResult, reason: string): string {
  const violations = result.violations.join("; ");
  return `Clawforce: ${result.agentId} — ${reason}. Violations: ${violations}`;
}

function recordAuditRun(result: ComplianceResult, status: string): void {
  try {
    const db = getDb(result.projectId);
    const id = randomUUID();
    const now = Date.now();
    const duration = now - result.metrics.startedAt;

    const requirementsMet = JSON.stringify(
      result.requirements.map((r) => ({
        tool: r.tool,
        action: r.action,
        satisfied: r.satisfied,
        actual: r.actual_calls,
        required: r.min_calls,
      })),
    );

    db.prepare(`
      INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, summary, requirements_met, metrics, started_at, ended_at, duration_ms, job_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, result.projectId, result.agentId, result.sessionKey,
      status,
      result.violations.length > 0 ? result.violations.join("; ") : "Compliant",
      requirementsMet,
      JSON.stringify(result.metrics),
      result.metrics.startedAt, now, duration,
      result.jobName ?? null,
    );
  } catch (err) {
    safeLog("actions.recordAudit", err);
  }
}

function recordCrashAuditRun(
  projectId: string,
  agentId: string,
  sessionKey: string,
  error: string | undefined,
  metrics: SessionMetrics | null,
  jobName?: string,
): void {
  try {
    const db = getDb(projectId);
    const id = randomUUID();
    const now = Date.now();
    const startedAt = metrics?.startedAt ?? now;

    db.prepare(`
      INSERT INTO audit_runs (id, project_id, agent_id, session_key, status, summary, metrics, started_at, ended_at, duration_ms, job_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, projectId, agentId, sessionKey,
      "crashed",
      error ?? "Employee is unresponsive",
      metrics ? JSON.stringify(metrics) : null,
      startedAt, now, now - startedAt,
      jobName ?? null,
    );
  } catch (err) {
    safeLog("actions.recordCrashAudit", err);
  }
}

/**
 * Record a successful compliant session.
 */
export function recordCompliantRun(result: ComplianceResult): void {
  recordAuditRun(result, "success");
}
