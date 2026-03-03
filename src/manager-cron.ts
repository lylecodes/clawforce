/**
 * Clawforce — Manager cron job builder + auto-registration
 *
 * Builds a cron job definition that periodically nudges the manager.
 * The real context comes from bootstrap injection — the cron just triggers
 * the session so the manager wakes up and reviews its state.
 */

import { safeLog } from "./diagnostics.js";
import { getDb } from "./db.js";
import type { CronRegistrar, CronRegistrarInput } from "./types.js";

export type ManagerCronJob = {
  name: string;
  schedule: string;
  agentId: string;
  payload: string;
};

/** @deprecated Use ManagerCronJob instead. */
export type OrchestratorCronJob = ManagerCronJob;

// Module-level registrar callback, set during initClawforce
let cronRegistrar: CronRegistrar | null = null;

/**
 * Store the cron registrar callback provided by the gateway.
 * Called once during initClawforce().
 */
export function setManagerCronRegistrar(registrar: CronRegistrar | undefined): void {
  cronRegistrar = registrar ?? null;
}

/** @deprecated Use setManagerCronRegistrar instead. */
export const setOrchestratorCronRegistrar = setManagerCronRegistrar;

/**
 * Parse a schedule string into milliseconds.
 * Supported formats:
 * - Duration shorthand: "30s", "5m", "1h", "1d"
 * - Raw milliseconds: "300000"
 * - Every prefix: "every:300000"
 * Falls back to 300_000 (5 min) for unrecognized formats.
 */
export function parseScheduleMs(schedule: string): number {
  // Raw milliseconds: "300000"
  if (/^\d+$/.test(schedule)) return parseInt(schedule, 10);
  // "every:N" format: "every:300000"
  const everyMatch = schedule.match(/^every:(\d+)$/);
  if (everyMatch) return parseInt(everyMatch[1]!, 10);
  // Duration shorthand: Ns, Nm, Nh, Nd
  const match = schedule.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 300_000;
  const value = parseInt(match[1]!, 10);
  switch (match[2]) {
    case "s": return value * 1000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    case "d": return value * 86_400_000;
    default: return 300_000;
  }
}

/**
 * Convert our ManagerCronJob to a CronJobCreate-compatible input.
 */
export function toCronJobCreate(job: ManagerCronJob): CronRegistrarInput {
  return {
    name: job.name,
    agentId: job.agentId,
    enabled: true,
    schedule: { kind: "every", everyMs: parseScheduleMs(job.schedule) },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: job.payload },
  };
}

/**
 * Register a manager cron job via the gateway's cron service.
 * Idempotent — logs a warning and returns if no registrar is available.
 */
export async function registerManagerCron(
  projectId: string,
  agentId: string,
  schedule: string,
): Promise<void> {
  if (!cronRegistrar) return;

  const job = buildManagerCronJob(projectId, agentId, schedule);
  const input = toCronJobCreate(job);

  try {
    await cronRegistrar(input);
  } catch (err) {
    safeLog("manager-cron.register", err);
  }
}

/** @deprecated Use registerManagerCron instead. */
export const registerOrchestratorCron = registerManagerCron;

/**
 * Build a cron job config for a manager agent.
 * The payload is a nudge message — actual context is injected via bootstrap hook.
 * Payload is dynamic: includes a summary of project state to focus attention.
 */
export function buildManagerCronJob(
  projectId: string,
  agentId: string,
  schedule: string,
): ManagerCronJob {
  // Query project summary for state-aware nudging
  const hints: string[] = [];
  try {
    const db = getDb(projectId);
    const stateRows = db.prepare(
      "SELECT state, COUNT(*) as cnt FROM tasks WHERE project_id = ? GROUP BY state",
    ).all(projectId) as Record<string, unknown>[];

    const counts: Record<string, number> = {};
    for (const r of stateRows) {
      counts[r.state as string] = r.cnt as number;
    }

    const escalatedRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND state = 'FAILED' AND retry_count >= max_retries AND COALESCE(json_extract(metadata, '$.escalated'), false) = true",
    ).get(projectId) as Record<string, unknown> | undefined;
    const escalations = (escalatedRow?.cnt as number) ?? 0;

    const pendingProposals = db.prepare(
      "SELECT COUNT(*) as cnt FROM proposals WHERE project_id = ? AND status = 'pending'",
    ).get(projectId) as Record<string, unknown> | undefined;
    const proposals = (pendingProposals?.cnt as number) ?? 0;

    if (escalations > 0) hints.push(`${escalations} escalation(s) need your attention`);
    if (proposals > 0) hints.push(`${proposals} pending proposal(s) awaiting decision`);
    if ((counts["OPEN"] ?? 0) > 0) hints.push(`${counts["OPEN"]} OPEN task(s) need assignment`);
    if ((counts["BLOCKED"] ?? 0) > 0) hints.push(`${counts["BLOCKED"]} BLOCKED task(s) need unblocking`);
    if ((counts["REVIEW"] ?? 0) > 0) hints.push(`${counts["REVIEW"]} task(s) in REVIEW`);

    // Event/queue status hints
    try {
      const pendingEvents = db.prepare(
        "SELECT COUNT(*) as cnt FROM events WHERE project_id = ? AND status = 'pending'",
      ).get(projectId) as Record<string, unknown> | undefined;
      const eventCount = (pendingEvents?.cnt as number) ?? 0;
      if (eventCount > 0) hints.push(`${eventCount} pending event(s) awaiting processing`);
    } catch { /* events table may not exist yet */ }

    try {
      const queuedItems = db.prepare(
        "SELECT COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? AND status = 'queued'",
      ).get(projectId) as Record<string, unknown> | undefined;
      const queueCount = (queuedItems?.cnt as number) ?? 0;
      if (queueCount > 0) hints.push(`${queueCount} queued dispatch item(s)`);
    } catch { /* dispatch_queue table may not exist yet */ }

    const totalActive = (counts["OPEN"] ?? 0) + (counts["ASSIGNED"] ?? 0) + (counts["IN_PROGRESS"] ?? 0) +
      (counts["REVIEW"] ?? 0) + (counts["BLOCKED"] ?? 0);
    if (totalActive === 0) hints.push("No active tasks — consider creating new tasks or reviewing project goals");
  } catch {
    // DB query failure is non-fatal — fall back to generic payload
  }

  const stateHints = hints.length > 0
    ? ["", "**Current state:**", ...hints.map((h) => `- ${h}`), ""]
    : [""];

  return {
    name: `manager-${projectId}`,
    schedule,
    agentId,
    payload: [
      `You are the manager for project "${projectId}".`,
      "Review your context and take action:",
      ...stateHints,
      "1. Process pending events (clawforce_ops process_events) — handles event routing + queue dispatch",
      "2. Handle pending escalations (FAILED tasks that exhausted retries)",
      "3. Dispatch REVIEW tasks for cross-agent verification",
      "4. Check stale tasks (no progress in 2+ hours)",
      "5. Assign OPEN tasks to appropriate workers",
      "6. Enqueue work for dispatch (clawforce_ops enqueue_work) or dispatch directly (dispatch_worker)",
      "7. Advance workflows where phase gates are satisfied",
      "8. Create new tasks for any identified gaps",
      "",
      "Prioritize P0 > P1 > P2 > P3. Use the clawforce_task tool for all task operations.",
      "Use clawforce_ops enqueue_work to queue tasks for dispatch, or dispatch_worker for immediate dispatch.",
      "Use clawforce_ops queue_status to check dispatch queue depth.",
      "Use clawforce_ops refresh_context to get fresh state mid-session.",
    ].join("\n"),
  };
}

/** @deprecated Use buildManagerCronJob instead. */
export const buildOrchestratorCronJob = buildManagerCronJob;
