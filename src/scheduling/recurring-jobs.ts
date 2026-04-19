import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { getAgentConfig, getRegisteredAgentIds } from "../project.js";
import { parseFrequency, shouldRunNow } from "./frequency.js";
import { parseSchedule } from "../manager-cron.js";
import { createTask, getTask, transitionTask } from "../tasks/ops.js";
import type { JobDefinition, Task, TaskPriority } from "../types.js";

export type RecurringJobRuntime = {
  lastScheduledAt: number | null;
  lastFinishedAt: number | null;
  lastStatus: string | null;
  lastTaskId: string | null;
  lastReason: string | null;
  activeTaskId: string | null;
  nextRunAt: number | null;
};

export type DueRecurringJob = {
  agentId: string;
  jobName: string;
  reason: string;
  scheduleLabel: string;
  nextRunAt: number | null;
  job: JobDefinition;
};

export type ScheduledRecurringJob = DueRecurringJob & {
  task: Task;
};

export type ReplayRecurringJobResult =
  | { ok: true; previousTask: Task; task: Task }
  | { ok: false; reason: string };

const RECURRING_JOB_PREFIX = "recurring_job:";
const MAX_CRON_LOOKAHEAD_MINUTES = 366 * 24 * 60;
const HIGH_PRIORITY_RECURRING_JOBS = new Set([
  "coordination",
  "daily-regime-sweep",
  "intake-triage",
  "onboarding-backlog-sweep",
  "integrity-sweep",
  "production-watch",
]);

function metadataKey(agentId: string, jobName: string, field: string): string {
  return `${RECURRING_JOB_PREFIX}${agentId}:${jobName}:${field}`;
}

function readMetaNumber(
  projectId: string,
  key: string,
  db: DatabaseSync,
): number | null {
  const row = db.prepare(
    "SELECT value FROM project_metadata WHERE project_id = ? AND key = ? LIMIT 1",
  ).get(projectId, key) as { value?: string } | undefined;
  if (!row?.value) return null;
  const value = Number(row.value);
  return Number.isFinite(value) ? value : null;
}

function readMetaString(
  projectId: string,
  key: string,
  db: DatabaseSync,
): string | null {
  const row = db.prepare(
    "SELECT value FROM project_metadata WHERE project_id = ? AND key = ? LIMIT 1",
  ).get(projectId, key) as { value?: string } | undefined;
  return row?.value ?? null;
}

function upsertMeta(
  projectId: string,
  key: string,
  value: string | number | null,
  db: DatabaseSync,
): void {
  if (value == null) {
    db.prepare(
      "DELETE FROM project_metadata WHERE project_id = ? AND key = ?",
    ).run(projectId, key);
    return;
  }
  db.prepare(`
    INSERT INTO project_metadata (project_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value
  `).run(projectId, key, String(value));
}

export function readRecurringJobRuntime(
  projectId: string,
  agentId: string,
  jobName: string,
  job: JobDefinition,
  dbOverride?: DatabaseSync,
): RecurringJobRuntime {
  const db = dbOverride ?? getDb(projectId);
  const lastScheduledAt = readMetaNumber(projectId, metadataKey(agentId, jobName, "last_scheduled_at"), db);
  const lastFinishedAt = readMetaNumber(projectId, metadataKey(agentId, jobName, "last_finished_at"), db);
  const lastStatus = readMetaString(projectId, metadataKey(agentId, jobName, "last_status"), db);
  const lastTaskId = readMetaString(projectId, metadataKey(agentId, jobName, "last_task_id"), db);
  const lastReason = readMetaString(projectId, metadataKey(agentId, jobName, "last_reason"), db);
  const activeTaskId = findActiveRecurringJobTaskId(projectId, agentId, jobName, db);
  const nextRunAt = computeNextRunAt(job, lastFinishedAt ?? lastScheduledAt, Date.now());
  return {
    lastScheduledAt,
    lastFinishedAt,
    lastStatus,
    lastTaskId,
    lastReason,
    activeTaskId,
    nextRunAt,
  };
}

export function markRecurringJobScheduled(
  projectId: string,
  agentId: string,
  jobName: string,
  taskId: string,
  reason: string,
  scheduledAt: number,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  upsertMeta(projectId, metadataKey(agentId, jobName, "last_scheduled_at"), scheduledAt, db);
  upsertMeta(projectId, metadataKey(agentId, jobName, "last_task_id"), taskId, db);
  upsertMeta(projectId, metadataKey(agentId, jobName, "active_task_id"), taskId, db);
  upsertMeta(projectId, metadataKey(agentId, jobName, "last_reason"), reason, db);
  upsertMeta(projectId, metadataKey(agentId, jobName, "last_status"), "scheduled", db);
}

export function markRecurringJobFinished(
  projectId: string,
  agentId: string,
  jobName: string,
  status: "completed" | "failed" | "cancelled",
  finishedAt: number,
  taskId?: string,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  upsertMeta(projectId, metadataKey(agentId, jobName, "last_finished_at"), finishedAt, db);
  upsertMeta(projectId, metadataKey(agentId, jobName, "last_status"), status, db);
  if (taskId) {
    upsertMeta(projectId, metadataKey(agentId, jobName, "last_task_id"), taskId, db);
  }
  upsertMeta(projectId, metadataKey(agentId, jobName, "active_task_id"), null, db);
}

export function replayRecurringJobTask(
  projectId: string,
  taskId: string,
  actor = "operator:cli",
  dbOverride?: DatabaseSync,
): ReplayRecurringJobResult {
  const db = dbOverride ?? getDb(projectId);
  const task = getTask(projectId, taskId, db);
  if (!task) {
    return { ok: false, reason: `Task not found: ${taskId}` };
  }
  if (task.state === "DONE") {
    return { ok: false, reason: `Recurring task ${taskId} is already DONE` };
  }

  const recurringJob = readRecurringJobPayload(task);
  if (!recurringJob) {
    return { ok: false, reason: `Task ${taskId} is not a recurring workflow run` };
  }

  const entry = getAgentConfig(recurringJob.agentId, projectId);
  const job = entry?.config.jobs?.[recurringJob.jobName];
  if (!job) {
    return { ok: false, reason: `Recurring workflow ${recurringJob.agentId}.${recurringJob.jobName} is no longer configured` };
  }

  const now = Date.now();
  const replayReason = `manual replay after ${task.state.toLowerCase()} recurring run ${task.id.slice(0, 8)}`;
  if (task.state !== "FAILED" && task.state !== "CANCELLED") {
    const supersede = transitionTask({
      projectId,
      taskId: task.id,
      toState: "CANCELLED",
      actor,
      reason: `Superseded by replayed recurring run`,
      verificationRequired: false,
    }, db);
    if (!supersede.ok) {
      return { ok: false, reason: supersede.reason ?? `Could not supersede recurring task ${task.id}` };
    }
  }

  const replayTask = createTask({
    projectId,
    title: `Run recurring workflow ${recurringJob.agentId}.${recurringJob.jobName}`,
    description: buildRecurringJobDescription({
      agentId: recurringJob.agentId,
      jobName: recurringJob.jobName,
      job,
      reason: replayReason,
      scheduleLabel: recurringJob.schedule,
      nextRunAt: computeNextRunAt(job, now, now),
    }),
    priority: recurringJobPriority(job, recurringJob.jobName),
    assignedTo: recurringJob.agentId,
    createdBy: actor,
    kind: "infra",
    origin: "reactive",
    tags: [
      "recurring-job",
      `agent:${recurringJob.agentId}`,
      `job:${recurringJob.jobName}`,
    ],
    metadata: {
      recurringJob: {
        agentId: recurringJob.agentId,
        jobName: recurringJob.jobName,
        schedule: recurringJob.schedule,
        reason: replayReason,
        scheduledAt: now,
      },
      replayOfTaskId: task.id,
    },
  }, db);

  markRecurringJobScheduled(projectId, recurringJob.agentId, recurringJob.jobName, replayTask.id, replayReason, now, db);
  return {
    ok: true,
    previousTask: task,
    task: replayTask,
  };
}

export function getRecurringJobMetadata(
  task: Task | { metadata?: Record<string, unknown> } | null | undefined,
): { agentId: string; jobName: string } | null {
  const metadata = task?.metadata;
  const recurringJob = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).recurringJob
    : null;
  if (!recurringJob || typeof recurringJob !== "object" || Array.isArray(recurringJob)) {
    return null;
  }
  const agentId = (recurringJob as Record<string, unknown>).agentId;
  const jobName = (recurringJob as Record<string, unknown>).jobName;
  if (typeof agentId !== "string" || typeof jobName !== "string") {
    return null;
  }
  return { agentId, jobName };
}

export function maybeNormalizeRecurringJobTask(
  projectId: string,
  task: Task,
  dbOverride?: DatabaseSync,
): Task {
  const recurringJob = readRecurringJobPayload(task);
  if (!recurringJob) return task;
  if (descriptionHasAcceptanceCriteria(task.description)) return task;

  const db = dbOverride ?? getDb(projectId);
  const entry = getAgentConfig(recurringJob.agentId, projectId);
  const job = entry?.config.jobs?.[recurringJob.jobName];
  if (!job) return task;

  const description = buildRecurringJobDescription({
    agentId: recurringJob.agentId,
    jobName: recurringJob.jobName,
    job,
    reason: recurringJob.reason,
    scheduleLabel: recurringJob.schedule,
    nextRunAt: null,
  });

  if (description === task.description) return task;

  const updatedAt = Date.now();
  db.prepare(
    "UPDATE tasks SET description = ?, updated_at = ? WHERE id = ? AND project_id = ?",
  ).run(description, updatedAt, task.id, projectId);

  return {
    ...task,
    description,
    updatedAt,
  };
}

function getProjectQueueDepth(projectId: string, db: DatabaseSync): number {
  const row = db.prepare(
    "SELECT COUNT(*) as depth FROM dispatch_queue WHERE project_id = ? AND status IN ('queued', 'leased')",
  ).get(projectId) as { depth?: number } | undefined;
  return row?.depth ?? 0;
}

function getPendingReviews(projectId: string, db: DatabaseSync): number {
  const row = db.prepare(
    "SELECT COUNT(*) as pending FROM tasks WHERE project_id = ? AND state = 'REVIEW'",
  ).get(projectId) as { pending?: number } | undefined;
  return row?.pending ?? 0;
}

export function collectDueRecurringJobs(
  projectId: string,
  dbOverride?: DatabaseSync,
  now = Date.now(),
): DueRecurringJob[] {
  const db = dbOverride ?? getDb(projectId);
  const queueDepth = getProjectQueueDepth(projectId, db);
  const pendingReviews = getPendingReviews(projectId, db);
  const due: DueRecurringJob[] = [];

  for (const agentId of getRegisteredAgentIds(projectId)) {
    const entry = getAgentConfig(agentId, projectId);
    if (!entry?.config.jobs) continue;

    for (const [jobName, job] of Object.entries(entry.config.jobs)) {
      if (!job.cron && !job.frequency) continue;
      if (findActiveRecurringJobTaskId(projectId, agentId, jobName, db)) continue;

      const runtime = readRecurringJobRuntime(projectId, agentId, jobName, job, db);
      const lastRunAt = runtime.lastFinishedAt ?? runtime.lastScheduledAt;

      if (job.frequency) {
        const freq = parseFrequency(job.frequency);
        if (!freq) continue;
        const check = shouldRunNow(freq, lastRunAt, queueDepth, pendingReviews, now);
        if (check.shouldRun) {
          due.push({
            agentId,
            jobName,
            job,
            reason: check.reason ?? "frequency due",
            scheduleLabel: job.frequency,
            nextRunAt: computeNextRunAt(job, lastRunAt, now),
          });
        }
        continue;
      }

      if (!job.cron) continue;
      const dueAt = nextRunAtForSchedule(job.cron, lastRunAt);
      if (dueAt != null && dueAt <= now) {
        due.push({
          agentId,
          jobName,
          job,
          reason: lastRunAt == null ? "never run before" : "cron due",
          scheduleLabel: job.cron,
          nextRunAt: computeNextRunAt(job, dueAt, now),
        });
      }
    }
  }

  return due;
}

export function scheduleDueRecurringJobs(
  projectId: string,
  dbOverride?: DatabaseSync,
  now = Date.now(),
): ScheduledRecurringJob[] {
  const db = dbOverride ?? getDb(projectId);
  const dueJobs = collectDueRecurringJobs(projectId, db, now);
  const scheduled: ScheduledRecurringJob[] = [];

  for (const due of dueJobs) {
    const task = createTask({
      projectId,
      title: `Run recurring workflow ${due.agentId}.${due.jobName}`,
      description: buildRecurringJobDescription(due),
      priority: recurringJobPriority(due.job, due.jobName),
      assignedTo: due.agentId,
      createdBy: "system:recurring-job",
      kind: "infra",
      origin: "reactive",
      tags: [
        "recurring-job",
        `agent:${due.agentId}`,
        `job:${due.jobName}`,
      ],
      metadata: {
        recurringJob: {
          agentId: due.agentId,
          jobName: due.jobName,
          schedule: due.scheduleLabel,
          reason: due.reason,
          scheduledAt: now,
        },
      },
    }, db);

    markRecurringJobScheduled(projectId, due.agentId, due.jobName, task.id, due.reason, now, db);

    scheduled.push({ ...due, task });
  }

  return scheduled;
}

function buildRecurringJobDescription(job: DueRecurringJob): string {
  const lines = [
    `Recurring workflow run for ${job.agentId}.${job.jobName}.`,
    `Schedule: ${job.scheduleLabel}`,
    `Reason: ${job.reason}`,
    "",
    job.job.nudge ?? `Run the configured recurring workflow for "${job.jobName}".`,
    "",
    "## Acceptance Criteria",
    "- Review the current recurring workflow scope and act on the configured nudge.",
    "- Leave concrete evidence of what you checked, changed, or created during this run.",
    "- If no follow-up work is needed, say that explicitly and explain why.",
  ];
  return lines.join("\n");
}

function readRecurringJobPayload(
  task: Task | { metadata?: Record<string, unknown> } | null | undefined,
): { agentId: string; jobName: string; schedule: string; reason: string } | null {
  const metadata = task?.metadata;
  const recurringJob = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).recurringJob
    : null;
  if (!recurringJob || typeof recurringJob !== "object" || Array.isArray(recurringJob)) {
    return null;
  }

  const agentId = (recurringJob as Record<string, unknown>).agentId;
  const jobName = (recurringJob as Record<string, unknown>).jobName;
  if (typeof agentId !== "string" || typeof jobName !== "string") {
    return null;
  }

  const schedule = (recurringJob as Record<string, unknown>).schedule;
  const reason = (recurringJob as Record<string, unknown>).reason;
  return {
    agentId,
    jobName,
    schedule: typeof schedule === "string" && schedule.trim()
      ? schedule
      : "configured recurring schedule",
    reason: typeof reason === "string" && reason.trim()
      ? reason
      : "scheduled recurring run",
  };
}

function descriptionHasAcceptanceCriteria(description: string | undefined): boolean {
  if (!description?.trim()) return false;
  const desc = description.toLowerCase();
  return (
    /##?\s*acceptance(\s+criteria)?/.test(desc) ||
    /acceptance(\s+criteria)?\s*:/.test(desc) ||
    desc.includes("output format") ||
    desc.includes("expected output") ||
    desc.includes("done when") ||
    desc.includes("success criteria") ||
    desc.includes("verify that") ||
    desc.includes("must include") ||
    desc.includes("required output")
  );
}

function recurringJobPriority(job: JobDefinition, jobName: string): TaskPriority {
  if (job.frequency) return "P2";
  if (HIGH_PRIORITY_RECURRING_JOBS.has(jobName)) return "P2";
  return "P3";
}

function computeNextRunAt(
  job: JobDefinition,
  referenceMs: number | null,
  now: number,
): number | null {
  if (job.frequency) {
    const freq = parseFrequency(job.frequency);
    if (!freq) return null;
    return referenceMs == null ? now : referenceMs + freq.intervalMs;
  }
  if (!job.cron) return null;
  const parsed = parseSchedule(job.cron);
  if (parsed.kind === "every") {
    return referenceMs == null ? now : referenceMs + parsed.everyMs;
  }
  if (parsed.kind === "at") {
    const at = Date.parse(parsed.at);
    return Number.isFinite(at) ? at : null;
  }
  return nextCronOccurrence(parsed.expr, referenceMs ?? now - 60_000, parsed.tz);
}

function nextRunAtForSchedule(
  schedule: string,
  referenceMs: number | null,
): number | null {
  const parsed = parseSchedule(schedule);
  if (parsed.kind === "every") {
    return referenceMs == null ? Date.now() : referenceMs + parsed.everyMs;
  }
  if (parsed.kind === "at") {
    const at = Date.parse(parsed.at);
    return Number.isFinite(at) ? at : null;
  }
  return nextCronOccurrence(parsed.expr, referenceMs ?? Date.now() - 60_000, parsed.tz);
}

function findActiveRecurringJobTaskId(
  projectId: string,
  agentId: string,
  jobName: string,
  db: DatabaseSync,
): string | null {
  const row = db.prepare(`
    SELECT id
    FROM tasks
    WHERE project_id = ?
      AND state NOT IN ('DONE', 'FAILED', 'CANCELLED')
      AND json_extract(metadata, '$.recurringJob.agentId') = ?
      AND json_extract(metadata, '$.recurringJob.jobName') = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(projectId, agentId, jobName) as { id?: string } | undefined;
  return row?.id ?? null;
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const DOW_NAMES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

function nextCronOccurrence(expr: string, afterMs: number, tz?: string): number | null {
  const start = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < MAX_CRON_LOOKAHEAD_MINUTES; i++) {
    const candidate = start + i * 60_000;
    if (matchesCron(expr, candidate, tz)) {
      return candidate;
    }
  }
  return null;
}

function matchesCron(expr: string, timestamp: number, tz?: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const values = getDateParts(timestamp, tz);
  const minuteMatch = matchesCronField(parts[0]!, values.minute, 0, 59);
  const hourMatch = matchesCronField(parts[1]!, values.hour, 0, 23);
  const monthMatch = matchesCronField(parts[3]!, values.month, 1, 12, MONTH_NAMES);
  const domRestricted = parts[2] !== "*";
  const dowRestricted = parts[4] !== "*";
  const domMatch = matchesCronField(parts[2]!, values.dayOfMonth, 1, 31);
  const dowMatch = matchesCronField(parts[4]!, values.dayOfWeek, 0, 7, DOW_NAMES, true);
  const dayMatch = domRestricted && dowRestricted ? (domMatch || dowMatch) : (domMatch && dowMatch);

  return minuteMatch && hourMatch && monthMatch && dayMatch;
}

function getDateParts(timestamp: number, tz?: string) {
  if (!tz) {
    const date = new Date(timestamp);
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      dayOfMonth: date.getDate(),
      month: date.getMonth() + 1,
      dayOfWeek: date.getDay(),
    };
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const weekday = part("weekday").slice(0, 3).toUpperCase();
  return {
    minute: Number(part("minute")),
    hour: Number(part("hour")),
    dayOfMonth: Number(part("day")),
    month: Number(part("month")),
    dayOfWeek: DOW_NAMES[weekday] ?? 0,
  };
}

function matchesCronField(
  field: string,
  value: number,
  min: number,
  max: number,
  aliases?: Record<string, number>,
  normalizeSunday = false,
): boolean {
  return field.split(",").some((segment) => matchesCronSegment(
    segment.trim(),
    value,
    min,
    max,
    aliases,
    normalizeSunday,
  ));
}

function matchesCronSegment(
  segment: string,
  value: number,
  min: number,
  max: number,
  aliases?: Record<string, number>,
  normalizeSunday = false,
): boolean {
  const [basePart, stepPart] = segment.split("/");
  const step = stepPart ? Number(stepPart) : 1;
  if (!Number.isFinite(step) || step <= 0) return false;

  const base = basePart.trim();
  const values: number[] = [];

  if (base === "*" || base === "?") {
    for (let current = min; current <= max; current += step) {
      values.push(current);
    }
  } else if (base.includes("-")) {
    const [startRaw, endRaw] = base.split("-");
    const start = normalizeCronValue(parseCronValue(startRaw, aliases), normalizeSunday);
    const end = normalizeCronValue(parseCronValue(endRaw, aliases), normalizeSunday);
    if (start == null || end == null) return false;
    for (let current = start; current <= end; current += step) {
      values.push(current);
    }
  } else {
    const single = normalizeCronValue(parseCronValue(base, aliases), normalizeSunday);
    if (single == null) return false;
    values.push(single);
  }

  return values.includes(normalizeCronValue(value, normalizeSunday) ?? value);
}

function parseCronValue(raw: string | undefined, aliases?: Record<string, number>): number | null {
  if (!raw) return null;
  const normalized = raw.trim().toUpperCase();
  if (aliases && normalized in aliases) {
    return aliases[normalized]!;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function normalizeCronValue(value: number | null, normalizeSunday: boolean): number | null {
  if (value == null) return null;
  if (normalizeSunday && value === 7) return 0;
  return value;
}
