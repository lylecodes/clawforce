/**
 * Clawforce — Frequency scheduler
 *
 * Sweep-cycle function that checks all frequency-based jobs and
 * returns which ones should be dispatched based on shouldRunNow logic.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import { parseFrequency, shouldRunNow } from "./frequency.js";
import { getRegisteredAgentIds, getAgentConfig, getExtendedProjectConfig } from "../project.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";

export type FrequencyDispatch = {
  agentId: string;
  jobName: string;
  reason: string;
};

/**
 * Check all frequency-based jobs for a project and return any that should run.
 *
 * For each agent with frequency-based jobs:
 * 1. Parse the frequency string
 * 2. Look up the last run time from audit_runs
 * 3. Check current queue depth and pending reviews
 * 4. Apply shouldRunNow logic
 */
export function checkFrequencyJobs(
  projectId: string,
  dbOverride?: DatabaseSync,
): FrequencyDispatch[] {
  const db = dbOverride ?? getDb(projectId);
  const toDispatch: FrequencyDispatch[] = [];

  for (const agentId of getRegisteredAgentIds(projectId)) {
    const entry = getAgentConfig(agentId, projectId);
    if (!entry) continue;
    if (!entry.config.jobs) continue;

    for (const [jobName, jobDef] of Object.entries(entry.config.jobs)) {
      if (!jobDef.frequency) continue;

      const freq = parseFrequency(jobDef.frequency);
      if (!freq) {
        safeLog("scheduler.invalidFrequency", new Error(
          `Invalid frequency "${jobDef.frequency}" for job "${jobName}" on agent "${agentId}"`,
        ));
        continue;
      }

      // Get last run time from audit_runs
      let lastRunAt: number | null = null;
      try {
        const lastRun = db.prepare(
          "SELECT MAX(ended_at) as last_run FROM audit_runs WHERE project_id = ? AND agent_id = ? AND summary LIKE ?",
        ).get(projectId, agentId, `%${jobName}%`) as { last_run: number | null } | undefined;
        lastRunAt = lastRun?.last_run ?? null;
      } catch {
        // Table may not exist — treat as never run
      }

      // Get current queue depth
      let queueDepth = 0;
      try {
        const queueRow = db.prepare(
          "SELECT COUNT(*) as depth FROM dispatch_queue WHERE project_id = ? AND status IN ('queued', 'leased')",
        ).get(projectId) as { depth: number };
        queueDepth = queueRow.depth;
      } catch {
        // Table may not exist
      }

      // Get pending reviews
      let pendingReviews = 0;
      try {
        const reviewRow = db.prepare(
          "SELECT COUNT(*) as pending FROM tasks WHERE project_id = ? AND state = 'REVIEW'",
        ).get(projectId) as { pending: number };
        pendingReviews = reviewRow.pending;
      } catch {
        // Table may not exist
      }

      const check = shouldRunNow(freq, lastRunAt, queueDepth, pendingReviews);
      if (check.shouldRun) {
        toDispatch.push({ agentId, jobName, reason: check.reason! });
      }
    }
  }

  return toDispatch;
}
