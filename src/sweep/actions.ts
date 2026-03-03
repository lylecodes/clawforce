/**
 * Clawforce — Background sweep service
 *
 * Runs periodically to:
 * - Detect stale tasks → emits sweep_finding events (advisory)
 * - Enforce deadlines → directly fails tasks (safety-critical)
 * - Advance workflow phases when gates are satisfied
 * - Escalate max-retries-exhausted tasks → emits sweep_finding events
 * - Expire stale proposals
 * - Enforce worker compliance
 * - Detect and kill stuck agents
 * - Reclaim expired dispatch queue leases
 * - Process events + drain dispatch queue (backstop)
 */

import type { DatabaseSync } from "node:sqlite";
import { killAllStuckAgents } from "../audit/auto-kill.js";
import { detectStuckAgents } from "../audit/stuck-detector.js";
import { resetDailyBudgets } from "../budget.js";
import { getDb } from "../db.js";
import { transitionTask } from "../tasks/ops.js";
import type { Task, TaskState } from "../types.js";
import { enforceWorkerCompliance, getIncompliantWorkers } from "../tasks/compliance.js";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";
import { advanceWorkflow, getPhaseStatus, listWorkflows } from "../workflow.js";
import { ingestEvent } from "../events/store.js";
import { reclaimExpiredLeases } from "../dispatch/queue.js";
import { processAndDispatch } from "../dispatch/dispatcher.js";

export type SweepResult = {
  stale: number;
  autoBlocked: number;
  deadlineExpired: number;
  workflowsAdvanced: number;
  escalated: number;
  complianceBlocked: number;
  stuckKilled: number;
  proposalsExpired: number;
  leasesReclaimed: number;
  eventsProcessed: number;
  dispatched: number;
  budgetsReset: number;
  sloChecked: number;
  sloBreach: number;
  alertsFired: number;
  anomaliesDetected: number;
};

export type SweepOptions = {
  projectId: string;
  staleThresholdMs?: number;
  stuckTimeoutMs?: number;
  proposalTtlMs?: number;
  dbOverride?: DatabaseSync;
};

const DEFAULT_STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
const DEFAULT_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Dedup window for sweep events (1 hour). Allows re-detection of recurring conditions. */
const SWEEP_DEDUP_WINDOW_MS = 60 * 60 * 1000;

/** Generate a dedup key with a time bucket so events can recur across sweep windows. */
function sweepDedupKey(prefix: string, id: string, now: number): string {
  const bucket = Math.floor(now / SWEEP_DEDUP_WINDOW_MS);
  return `${prefix}:${id}:${bucket}`;
}

export async function sweep(options: SweepOptions): Promise<SweepResult> {
  const { projectId, dbOverride } = options;
  const db = dbOverride ?? getDb(projectId);
  const staleThreshold = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const proposalTtl = options.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS;
  const now = Date.now();

  let stale = 0;
  let autoBlocked = 0;
  let deadlineExpired = 0;
  let workflowsAdvanced = 0;
  let escalated = 0;
  let complianceBlocked = 0;
  let proposalsExpired = 0;
  let leasesReclaimed = 0;
  let budgetsReset = 0;

  // Wrap all DB-mutating operations in a transaction for atomicity.
  // If the process crashes mid-sweep, all changes roll back together.
  try {
    db.exec("BEGIN");

    // 1. Find stale tasks — emit events instead of directly mutating
    const activeStates: TaskState[] = ["ASSIGNED", "IN_PROGRESS"];
    for (const state of activeStates) {
      const rows = db
        .prepare("SELECT * FROM tasks WHERE project_id = ? AND state = ?")
        .all(projectId, state) as Record<string, unknown>[];

      for (const row of rows) {
        const taskId = row.id as string;
        const updatedAt = row.updated_at as number;

        if (now - updatedAt > staleThreshold) {
          // Check if there's a recent transition
          const lastTransition = db
            .prepare("SELECT created_at FROM transitions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
            .get(taskId) as Record<string, unknown> | undefined;

          const lastActivity = lastTransition
            ? (lastTransition.created_at as number)
            : updatedAt;

          if (now - lastActivity > staleThreshold) {
            stale++;
            // Mark as stale via metadata update (don't transition — just flag)
            db.prepare("UPDATE tasks SET updated_at = ?, metadata = json_set(COALESCE(metadata, '{}'), '$.stale', true, '$.stale_since', ?) WHERE id = ?")
              .run(now, lastActivity, taskId);

            emitDiagnosticEvent({ type: "task_stale", taskId, projectId, staleSinceMs: now - lastActivity });

            // Emit event for stale detection (advisory — router decides policy)
            ingestEvent(projectId, "sweep_finding", "cron", {
              finding: "stale",
              taskId,
              staleSinceMs: now - lastActivity,
            }, sweepDedupKey("stale", taskId, now), db);

            // Auto-block severely stale tasks (2x threshold) — stays direct (safety-critical)
            const meta = row.metadata ? JSON.parse(row.metadata as string) : null;
            const staleSince = meta?.stale_since as number | undefined;
            if (staleSince && now - staleSince > staleThreshold) {
              const blockResult = transitionTask(
                { projectId, taskId, toState: "BLOCKED", actor: "system:sweep", reason: `Auto-blocked: no activity for ${Math.round((now - lastActivity) / 3_600_000)}h`, verificationRequired: false },
                db,
              );
              if (blockResult.ok) autoBlocked++;
            }
          }
        }
      }
    }

    // 2. Enforce deadlines — stays direct (safety-critical, no delay acceptable)
    const overdue = db
      .prepare("SELECT id, project_id FROM tasks WHERE project_id = ? AND deadline IS NOT NULL AND deadline < ? AND state NOT IN ('DONE', 'FAILED', 'CANCELLED')")
      .all(projectId, now) as Record<string, unknown>[];

    for (const row of overdue) {
      const taskId = row.id as string;
      const result = transitionTask(
        {
          projectId,
          taskId,
          toState: "FAILED",
          actor: "system:sweep",
          reason: "Deadline exceeded",
          verificationRequired: false,
        },
        db,
      );
      if (result.ok) deadlineExpired++;
    }

    // 3. Advance workflows
    const workflows = listWorkflows(projectId, db);
    for (const workflow of workflows) {
      if (workflow.state !== "active") continue;
      const advanced = advanceWorkflow(projectId, workflow.id, db);
      if (advanced !== null) {
        workflowsAdvanced++;
      } else {
        // Stall detection for all gate types
        const phaseStatus = getPhaseStatus(projectId, workflow.id, workflow.currentPhase, db);
        if (phaseStatus) {
          let stalled = false;
          let hint = "";

          // Empty phases stall forever
          if (phaseStatus.total === 0) {
            stalled = true;
            hint = "Phase has 0 tasks — add tasks or skip this phase";
          } else {
            switch (phaseStatus.gateCondition) {
              case "all_done":
                if (phaseStatus.failed > 0) {
                  stalled = true;
                  hint = "Consider using gate_condition: 'all_resolved'";
                }
                break;
              case "any_done":
                // Stalled if all tasks resolved but none completed
                if (phaseStatus.resolved === phaseStatus.total && phaseStatus.completed === 0) {
                  stalled = true;
                  hint = "All tasks failed/resolved but none completed — gate requires at least one DONE";
                }
                break;
              case "all_resolved":
                // Stalled if some tasks are stuck in non-terminal states and won't resolve
                if (phaseStatus.resolved === phaseStatus.total && phaseStatus.completed === 0) {
                  stalled = true;
                  hint = "All tasks resolved but none completed — gate requires at least one DONE";
                }
                break;
              case "any_resolved":
                // Stalled if all tasks resolved but none completed
                if (phaseStatus.resolved === phaseStatus.total && phaseStatus.completed === 0) {
                  stalled = true;
                  hint = "All tasks resolved but none completed — gate requires at least one DONE";
                }
                break;
            }
          }

          if (stalled) {
            emitDiagnosticEvent({
              type: "workflow_phase_stalled",
              workflowId: workflow.id,
              phase: workflow.currentPhase,
              gateCondition: phaseStatus.gateCondition,
              failedTasks: phaseStatus.failed,
              totalTasks: phaseStatus.total,
              hint,
            });
          }
        }
      }
    }

    // 4. Escalate exhausted FAILED tasks — emit events instead of direct mutation
    const exhausted = db
      .prepare("SELECT id FROM tasks WHERE project_id = ? AND state = 'FAILED' AND retry_count >= max_retries AND COALESCE(json_extract(metadata, '$.escalated'), false) = false")
      .all(projectId) as Record<string, unknown>[];

    for (const row of exhausted) {
      const taskId = row.id as string;
      // Mark as escalated
      db.prepare("UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.escalated', true, '$.escalated_at', ?) WHERE id = ?")
        .run(now, taskId);
      escalated++;
      emitDiagnosticEvent({ type: "task_escalated", taskId, projectId });

      // Emit event for escalation
      ingestEvent(projectId, "sweep_finding", "cron", {
        finding: "retry_exhausted",
        taskId,
      }, sweepDedupKey("escalated", taskId, now), db);
    }

    // 5. Expire stale proposals past TTL — stays direct (low-risk, no dispatch)
    const ttlCutoff = now - proposalTtl;
    const staleProposals = db
      .prepare("SELECT id FROM proposals WHERE project_id = ? AND status = 'pending' AND created_at < ?")
      .all(projectId, ttlCutoff) as Record<string, unknown>[];

    for (const row of staleProposals) {
      const proposalId = row.id as string;
      db.prepare(
        "UPDATE proposals SET status = 'rejected', user_feedback = ?, resolved_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'",
      ).run("Auto-expired: exceeded TTL", now, proposalId, projectId);
      proposalsExpired++;
      emitDiagnosticEvent({ type: "proposal_expired", proposalId, projectId });
    }

    // 6. Enforce worker compliance — stays direct (enforcement, not dispatch)
    const incompliant = getIncompliantWorkers().filter((w) => w.projectId === projectId);
    const staleComplianceThreshold = 30 * 60_000; // 30 min — give workers time to finish
    for (const worker of incompliant) {
      if (now - worker.trackedAt > staleComplianceThreshold) {
        if (enforceWorkerCompliance(worker.sessionKey, db)) {
          complianceBlocked++;
        }
      }
    }

    // 7. Reclaim expired dispatch queue leases
    leasesReclaimed = reclaimExpiredLeases(projectId, db);

    db.exec("COMMIT");

    // 7.5 Reset daily budgets (outside transaction — idempotent)
    try {
      budgetsReset = resetDailyBudgets(projectId, db);
    } catch (err) {
      safeLog("sweep.budgetReset", err);
    }
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back or no transaction */ }
    throw err;
  }

  // 8. Detect and kill stuck agents (external operation — outside transaction)
  const stuck = detectStuckAgents({
    stuckTimeoutMs: options.stuckTimeoutMs,
  });
  // Filter to agents belonging to this project
  const projectStuck = stuck.filter((s) => s.projectId === projectId);
  const stuckKilled = await killAllStuckAgents(projectStuck);

  // 9. Backstop: process pending events + drain dispatch queue
  let eventsProcessed = 0;
  let dispatched = 0;
  try {
    const result = await processAndDispatch(projectId, db);
    eventsProcessed = result.eventsProcessed;
    dispatched = result.dispatched;
  } catch (err) {
    safeLog("sweep.processAndDispatch", err);
  }

  // 10. Monitoring feedback loops (SLOs, anomaly detection, alert rules)
  let sloChecked = 0;
  let sloBreach = 0;
  let alertsFired = 0;
  let anomaliesDetected = 0;
  try {
    // Lazy import to avoid circular deps
    const { runMonitoringSweep } = await import("../monitoring/sweep-step.js");
    const monResult = runMonitoringSweep(projectId, db);
    sloChecked = monResult.sloChecked;
    sloBreach = monResult.sloBreach;
    alertsFired = monResult.alertsFired;
    anomaliesDetected = monResult.anomaliesDetected;
  } catch (err) {
    safeLog("sweep.monitoring", err);
  }

  return {
    stale, autoBlocked, deadlineExpired, workflowsAdvanced, escalated,
    complianceBlocked, stuckKilled, proposalsExpired, leasesReclaimed,
    eventsProcessed, dispatched, budgetsReset,
    sloChecked, sloBreach, alertsFired, anomaliesDetected,
  };
}
