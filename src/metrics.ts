/**
 * Clawforce — Metrics collection, aggregation, and query API
 *
 * Stores metrics in SQLite per-project. Covers task cycle times,
 * agent performance, dispatch stats, and system health.
 */

import crypto from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "./sqlite-driver.js";
import { getDb } from "./db.js";

export type MetricType = "task_cycle" | "task" | "agent_performance" | "dispatch" | "sweep" | "system" | "cost" | "assignment";

export type Metric = {
  id: string;
  projectId: string;
  type: MetricType;
  subject?: string;
  key: string;
  value: number;
  unit?: string;
  tags?: Record<string, unknown>;
  createdAt: number;
};

export function recordMetric(
  params: {
    projectId: string;
    type: MetricType;
    subject?: string;
    key: string;
    value: number;
    unit?: string;
    tags?: Record<string, unknown>;
  },
  dbOverride?: DatabaseSync,
): Metric {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO metrics (id, project_id, type, subject, key, value, unit, tags, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.projectId,
    params.type,
    params.subject ?? null,
    params.key,
    params.value,
    params.unit ?? null,
    params.tags ? JSON.stringify(params.tags) : null,
    now,
  );

  return {
    id,
    projectId: params.projectId,
    type: params.type,
    subject: params.subject,
    key: params.key,
    value: params.value,
    unit: params.unit,
    tags: params.tags,
    createdAt: now,
  };
}

export type MetricQuery = {
  projectId: string;
  type?: MetricType;
  subject?: string;
  key?: string;
  since?: number;
  until?: number;
  limit?: number;
};

export function queryMetrics(query: MetricQuery, dbOverride?: DatabaseSync): Metric[] {
  const db = dbOverride ?? getDb(query.projectId);
  const conditions: string[] = ["project_id = ?"];
  const values: SQLInputValue[] = [query.projectId];

  if (query.type) {
    conditions.push("type = ?");
    values.push(query.type);
  }
  if (query.subject) {
    conditions.push("subject = ?");
    values.push(query.subject);
  }
  if (query.key) {
    conditions.push("key = ?");
    values.push(query.key);
  }
  if (query.since) {
    conditions.push("created_at >= ?");
    values.push(query.since);
  }
  if (query.until) {
    conditions.push("created_at <= ?");
    values.push(query.until);
  }

  const limit = query.limit ?? 1000;
  values.push(limit);

  const sql = `SELECT * FROM metrics WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    projectId: row.project_id as string,
    type: row.type as MetricType,
    subject: (row.subject as string) ?? undefined,
    key: row.key as string,
    value: row.value as number,
    unit: (row.unit as string) ?? undefined,
    tags: row.tags ? JSON.parse(row.tags as string) : undefined,
    createdAt: row.created_at as number,
  }));
}

export type AggregateResult = {
  key: string;
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
};

export function aggregateMetrics(
  params: {
    projectId: string;
    type?: MetricType;
    subject?: string;
    key: string;
    since?: number;
    until?: number;
    groupBy?: "subject" | "type";
  },
  dbOverride?: DatabaseSync,
): AggregateResult[] {
  const db = dbOverride ?? getDb(params.projectId);
  const conditions: string[] = ["project_id = ?", "key = ?"];
  const values: SQLInputValue[] = [params.projectId, params.key];

  if (params.type) {
    conditions.push("type = ?");
    values.push(params.type);
  }
  if (params.subject) {
    conditions.push("subject = ?");
    values.push(params.subject);
  }
  if (params.since) {
    conditions.push("created_at >= ?");
    values.push(params.since);
  }
  if (params.until) {
    conditions.push("created_at <= ?");
    values.push(params.until);
  }

  const groupCol = params.groupBy ?? "key";
  const ALLOWED_GROUP_COLS = new Set(["key", "subject", "type"]);
  if (!ALLOWED_GROUP_COLS.has(groupCol)) {
    throw new Error(`Invalid groupBy column: ${groupCol}`);
  }
  const sql = `
    SELECT ${groupCol} as group_key, COUNT(*) as cnt, SUM(value) as total,
      AVG(value) as avg_val, MIN(value) as min_val, MAX(value) as max_val
    FROM metrics WHERE ${conditions.join(" AND ")}
    GROUP BY ${groupCol}
  `;

  const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];

  return rows.map((row) => ({
    key: String(row.group_key ?? params.key),
    count: row.cnt as number,
    sum: row.total as number,
    avg: row.avg_val as number,
    min: row.min_val as number,
    max: row.max_val as number,
  }));
}

/**
 * Record task cycle time metric when a task reaches DONE.
 */
export function recordTaskCycleTime(
  projectId: string,
  taskId: string,
  createdAt: number,
  completedAt: number,
  assignedTo?: string,
  dbOverride?: DatabaseSync,
): void {
  const cycleTimeMs = completedAt - createdAt;

  recordMetric(
    {
      projectId,
      type: "task_cycle",
      subject: taskId,
      key: "cycle_time",
      value: cycleTimeMs,
      unit: "ms",
      tags: { assignedTo },
    },
    dbOverride,
  );
}

/**
 * Record dispatch metrics from a Claude Code invocation.
 */
export function recordDispatchMetric(
  projectId: string,
  taskId: string,
  params: {
    durationMs: number;
    exitCode: number;
    profile?: string;
    model?: string;
  },
  dbOverride?: DatabaseSync,
): void {
  recordMetric(
    {
      projectId,
      type: "dispatch",
      subject: taskId,
      key: "dispatch_duration",
      value: params.durationMs,
      unit: "ms",
      tags: {
        exitCode: params.exitCode,
        profile: params.profile,
        model: params.model,
        success: params.exitCode === 0,
      },
    },
    dbOverride,
  );
}
