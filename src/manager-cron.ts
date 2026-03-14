/**
 * Clawforce — Manager cron job builder + auto-registration
 *
 * Builds a cron job definition that periodically nudges the manager.
 * The real context comes from bootstrap injection — the cron just triggers
 * the session so the manager wakes up and reviews its state.
 */

import { safeLog } from "./diagnostics.js";
import { getDb } from "./db.js";
import { getExtendedProjectConfig } from "./project.js";
import { buildOodaPrompt } from "./planning/ooda.js";
import { computeVelocity, analyzeBlockerImpact, computeCostTrajectory } from "./planning/velocity.js";
import type { CronDelivery, CronFailureAlert, CronRegistrar, CronRegistrarInput, CronSchedule, JobDefinition } from "./types.js";

export type ManagerCronJob = {
  name: string;
  schedule: string;
  agentId: string;
  payload: string;
  sessionTarget?: "main" | "isolated";
  wakeMode?: "next-heartbeat" | "now";
  delivery?: CronDelivery;
  failureAlert?: CronFailureAlert;
  model?: string;
  timeoutSeconds?: number;
  lightContext?: boolean;
  deleteAfterRun?: boolean;
};

// Module-level registrar callback, set during initClawforce
let cronRegistrar: CronRegistrar | null = null;

/**
 * Store the cron registrar callback provided by the gateway.
 * Called once during initClawforce().
 */
export function setManagerCronRegistrar(registrar: CronRegistrar | undefined): void {
  cronRegistrar = registrar ?? null;
}

// --- Runtime cron service (for job management tooling) ---

/**
 * Cron job state as reported by OpenClaw.
 * Mirrors openclaw/dist/plugin-sdk/cron/types.d.ts CronJobState —
 * kept as a local subset to avoid deep import path coupling.
 */
export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  lastDeliveryStatus?: "delivered" | "not-delivered" | "unknown" | "not-requested";
  lastDeliveryError?: string;
};

/**
 * Full cron job record returned by list/getJob.
 * Mirrors a subset of OpenClaw's CronJob type (openclaw/dist/plugin-sdk/cron/types.d.ts).
 */
export type CronJobRecord = {
  id: string;
  name: string;
  agentId?: string;
  enabled: boolean;
  description?: string;
  schedule: CronSchedule;
  state: CronJobState;
};

/**
 * Cron service interface for runtime job management.
 * Mirrors OpenClaw's CronService (openclaw/dist/plugin-sdk/cron/service.d.ts).
 */
export type CronServiceLike = {
  list(opts?: { includeDisabled?: boolean }): Promise<CronJobRecord[]>;
  add(input: CronRegistrarInput): Promise<unknown>;
  update(id: string, patch: Record<string, unknown>): Promise<unknown>;
  remove?(id: string): Promise<unknown>;
  run?(id: string): Promise<unknown>;
};

let cronService: CronServiceLike | null = null;

/** Store the cron service for runtime management (called during init). */
export function setCronService(service: CronServiceLike | null): void {
  cronService = service;
}

/** Get the cron service for runtime cron management. */
export function getCronService(): CronServiceLike | null {
  return cronService;
}

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

/** Regex matching interval-only schedule formats handled by parseScheduleMs. */
const INTERVAL_RE = /^(\d+[smhd]|\d+|every:\d+)$/;

/**
 * Parse a schedule string into a CronSchedule.
 *
 * Supported formats:
 * - Duration shorthand: "30s", "5m", "1h", "1d" → { kind: "every" }
 * - Raw milliseconds: "300000" → { kind: "every" }
 * - Every prefix: "every:300000" → { kind: "every" }
 * - Cron expression: "0 9 * * MON-FRI" → { kind: "cron" }
 * - Cron with timezone: "cron:0 9 * * *|America/New_York" → { kind: "cron", tz }
 * - ISO datetime: "2025-12-31T23:59:00Z" or "at:..." → { kind: "at" }
 *
 * Falls back to { kind: "every", everyMs: 300_000 } for unrecognized formats.
 */
export function parseSchedule(schedule: string): CronSchedule {
  // Interval formats first (backward compat)
  if (INTERVAL_RE.test(schedule)) {
    return { kind: "every", everyMs: parseScheduleMs(schedule) };
  }

  // One-shot: "at:<ISO>" or bare ISO datetime
  if (schedule.startsWith("at:")) {
    return { kind: "at", at: schedule.slice(3).trim() };
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(schedule)) {
    return { kind: "at", at: schedule.trim() };
  }

  // Explicit cron: prefix
  if (schedule.startsWith("cron:")) {
    const rest = schedule.slice(5).trim();
    const pipeIdx = rest.indexOf("|");
    if (pipeIdx !== -1) {
      return { kind: "cron", expr: rest.slice(0, pipeIdx).trim(), tz: rest.slice(pipeIdx + 1).trim() };
    }
    return { kind: "cron", expr: rest };
  }

  // Auto-detect cron expressions (5+ space-separated fields)
  const parts = schedule.trim().split(/\s+/);
  if (parts.length >= 5) {
    // 6th field starting with uppercase could be a timezone
    if (parts.length === 6 && /^[A-Z]/.test(parts[5]!)) {
      return { kind: "cron", expr: parts.slice(0, 5).join(" "), tz: parts[5] };
    }
    return { kind: "cron", expr: schedule.trim() };
  }

  // Unrecognized → default interval
  return { kind: "every", everyMs: 300_000 };
}

/**
 * Convert our ManagerCronJob to a CronJobCreate-compatible input.
 */
export function toCronJobCreate(job: ManagerCronJob): CronRegistrarInput {
  const schedule = parseSchedule(job.schedule);
  const input: CronRegistrarInput = {
    name: job.name,
    agentId: job.agentId,
    enabled: true,
    schedule,
    sessionTarget: job.sessionTarget ?? "isolated",
    wakeMode: job.wakeMode ?? "now",
    payload: {
      kind: "agentTurn",
      message: job.payload,
      ...(job.model && { model: job.model }),
      ...(job.timeoutSeconds && { timeoutSeconds: job.timeoutSeconds }),
      ...(job.lightContext && { lightContext: job.lightContext }),
    },
  };
  if (job.delivery) input.delivery = job.delivery;
  if (job.failureAlert !== undefined) input.failureAlert = job.failureAlert;
  if (job.deleteAfterRun !== undefined) {
    input.deleteAfterRun = job.deleteAfterRun;
  } else if (schedule.kind === "at") {
    input.deleteAfterRun = true;
  }
  return input;
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
    if ((counts["REVIEW"] ?? 0) > 0) {
      const extConfig = getExtendedProjectConfig(projectId);
      const escalateHours = extConfig?.review?.autoEscalateAfterHours;
      if (escalateHours) {
        hints.push(`${counts["REVIEW"]} task(s) in REVIEW (auto-escalate after ${escalateHours}h)`);
      } else {
        hints.push(`${counts["REVIEW"]} task(s) in REVIEW`);
      }
    }

    // Event/queue status hints
    const pendingEvents = db.prepare(
      "SELECT COUNT(*) as cnt FROM events WHERE project_id = ? AND status = 'pending'",
    ).get(projectId) as Record<string, unknown> | undefined;
    const eventCount = (pendingEvents?.cnt as number) ?? 0;
    if (eventCount > 0) hints.push(`${eventCount} pending event(s) awaiting processing`);

    const queuedItems = db.prepare(
      "SELECT COUNT(*) as cnt FROM dispatch_queue WHERE project_id = ? AND status = 'queued'",
    ).get(projectId) as Record<string, unknown> | undefined;
    const queueCount = (queuedItems?.cnt as number) ?? 0;
    if (queueCount > 0) hints.push(`${queueCount} queued dispatch item(s)`);

    // Goal status hints
    try {
      const activeGoals = db.prepare(
        "SELECT COUNT(*) as cnt FROM goals WHERE project_id = ? AND status = 'active'",
      ).get(projectId) as Record<string, unknown> | undefined;
      const goalCount = (activeGoals?.cnt as number) ?? 0;

      const unplannedGoals = db.prepare(`
        SELECT COUNT(*) as cnt FROM goals g
        WHERE g.project_id = ? AND g.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM goals c WHERE c.parent_goal_id = g.id)
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.goal_id = g.id)
      `).get(projectId) as Record<string, unknown> | undefined;
      const unplannedCount = (unplannedGoals?.cnt as number) ?? 0;

      if (goalCount > 0) hints.push(`${goalCount} active goal(s)`);
      if (unplannedCount > 0) hints.push(`${unplannedCount} goal(s) with no decomposition plan — use clawforce_goal decompose`);
    } catch { /* goals table may not exist yet */ }

    const totalActive = (counts["OPEN"] ?? 0) + (counts["ASSIGNED"] ?? 0) + (counts["IN_PROGRESS"] ?? 0) +
      (counts["REVIEW"] ?? 0) + (counts["BLOCKED"] ?? 0);
    if (totalActive === 0) hints.push("No active tasks — consider creating new tasks or reviewing project goals");

    // Velocity hints
    try {
      const { windows, trend } = computeVelocity(projectId, db);
      const last24h = windows.find((w) => w.label === "last_24h");
      if (last24h && last24h.completed > 0) {
        hints.push(`Velocity: ${last24h.completed} tasks done in 24h (${last24h.tasksPerHour.toFixed(1)}/hr, ${trend})`);
      }

      const blockers = analyzeBlockerImpact(projectId, db, 3);
      if (blockers.length > 0) {
        const top = blockers[0]!;
        hints.push(`Top blocker: "${top.taskTitle}" [${top.taskState}] blocking ${top.downstreamCount} task(s)`);
      }

      const cost = computeCostTrajectory(projectId, db);
      if (cost?.overBudget) {
        hints.push(`Cost alert: projected $${(cost.projectedDailySpendCents / 100).toFixed(2)}/day exceeds budget of $${(cost.dailyLimitCents! / 100).toFixed(2)}/day`);
      }
    } catch { /* velocity queries non-fatal */ }
  } catch {
    // DB query failure is non-fatal — fall back to generic payload
  }

  return {
    name: `manager-${projectId}`,
    schedule,
    agentId,
    payload: buildOodaPrompt(projectId, hints),
  };
}

// --- Per-job cron registration ---

/**
 * Build a cron job for a specific agent job.
 * The payload includes a [clawforce:job=<name>] tag so the
 * before_prompt_build hook can detect which job is running.
 */
export function buildJobCronJob(
  projectId: string,
  agentId: string,
  jobName: string,
  job: JobDefinition,
  schedule: string,
): ManagerCronJob {
  const nudge = job.nudge ?? `Review your context and complete the "${jobName}" job.`;

  // Apply cronTimezone to cron expressions
  let effectiveSchedule = schedule;
  if (job.cronTimezone && !schedule.includes("|") && !schedule.startsWith("cron:")) {
    const parsed = parseSchedule(schedule);
    if (parsed.kind === "cron") {
      effectiveSchedule = `cron:${parsed.expr}|${job.cronTimezone}`;
    }
  }

  return {
    name: `job-${projectId}-${agentId}-${jobName}`,
    schedule: effectiveSchedule,
    agentId,
    payload: [
      `[clawforce:job=${jobName}]`,
      "",
      nudge,
    ].join("\n"),
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    delivery: job.delivery,
    failureAlert: job.failureAlert,
    model: job.model,
    timeoutSeconds: job.timeoutSeconds,
    lightContext: job.lightContext,
    deleteAfterRun: job.deleteAfterRun,
  };
}

/**
 * Register cron jobs for all jobs defined on an agent.
 * Each job with a `cron` field gets its own isolated cron.
 */
export async function registerJobCrons(
  projectId: string,
  agentId: string,
  jobs: Record<string, JobDefinition>,
): Promise<void> {
  if (!cronRegistrar) return;

  for (const [jobName, job] of Object.entries(jobs)) {
    if (!job.cron) continue;
    const cronJob = buildJobCronJob(projectId, agentId, jobName, job, job.cron);
    const input = toCronJobCreate(cronJob);
    try {
      await cronRegistrar(input);
    } catch (err) {
      safeLog("manager-cron.registerJob", err);
    }
  }
}
