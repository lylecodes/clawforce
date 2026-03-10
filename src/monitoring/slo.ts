/**
 * Clawforce — SLO evaluation
 *
 * Evaluates service level objectives against recorded metrics.
 * Records results to slo_evaluations table.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { aggregateMetrics, type MetricType } from "../metrics.js";
import { safeLog } from "../diagnostics.js";
import { createTask } from "../tasks/ops.js";
import type { SloDefinition } from "../types.js";

export type SloEvaluation = {
  sloName: string;
  metricKey: string;
  threshold: number;
  actual: number | null;
  passed: boolean;
  noData?: boolean;
  breachTaskId?: string;
};

/**
 * Evaluate all SLOs for a project.
 * Returns evaluation results and records them to DB.
 */
export function evaluateSlos(
  projectId: string,
  slos: Record<string, SloDefinition>,
  dbOverride?: DatabaseSync,
): SloEvaluation[] {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const results: SloEvaluation[] = [];

  for (const [name, slo] of Object.entries(slos)) {
    const result = evaluateSingleSlo(projectId, name, slo, now, db);
    results.push(result);

    // Record to DB
    const id = crypto.randomUUID();
    try {
      db.prepare(`
        INSERT INTO slo_evaluations (id, project_id, slo_name, metric_key, window_ms,
          threshold, actual, passed, breach_task_id, evaluated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, projectId, name, slo.metricKey, slo.windowMs,
        slo.threshold, result.actual, result.passed ? 1 : 0,
        result.breachTaskId ?? null, now,
      );
    } catch (err) {
      safeLog("slo.record", err);
    }
  }

  return results;
}

function evaluateSingleSlo(
  projectId: string,
  name: string,
  slo: SloDefinition,
  now: number,
  db: DatabaseSync,
): SloEvaluation {
  const since = now - slo.windowMs;

  // Query metrics
  const agg = aggregateMetrics({
    projectId,
    type: slo.metricType as MetricType,
    key: slo.metricKey,
    since,
    until: now,
  }, db);

  if (agg.length === 0 || agg[0]!.count === 0) {
    const noDataPolicy = slo.noDataPolicy ?? "pass";
    const passed = noDataPolicy !== "fail";
    return { sloName: name, metricKey: slo.metricKey, threshold: slo.threshold, actual: null, passed, noData: true };
  }

  const aggResult = agg[0]!;

  // Get the aggregated value
  let actual: number;
  switch (slo.aggregation) {
    case "avg": actual = aggResult.avg; break;
    case "sum": actual = aggResult.sum; break;
    case "count": actual = aggResult.count; break;
    case "min": actual = aggResult.min; break;
    case "max": actual = aggResult.max; break;
    default: actual = aggResult.avg;
  }

  // Handle ratio-based SLOs (e.g., success rate = successes / total)
  if (slo.denominatorKey) {
    const denomAgg = aggregateMetrics({
      projectId,
      type: slo.metricType as MetricType,
      key: slo.denominatorKey,
      since,
      until: now,
    }, db);

    if (denomAgg.length > 0 && denomAgg[0]!.sum > 0) {
      actual = aggResult.sum / denomAgg[0]!.sum;
    }
  }

  // Evaluate condition
  let passed: boolean;
  switch (slo.condition) {
    case "lt": passed = actual < slo.threshold; break;
    case "gt": passed = actual > slo.threshold; break;
    case "lte": passed = actual <= slo.threshold; break;
    case "gte": passed = actual >= slo.threshold; break;
    default: passed = actual < slo.threshold;
  }

  let breachTaskId: string | undefined;

  // On breach: create remediation task (with dedup)
  if (!passed && slo.onBreach?.action === "create_task") {
    breachTaskId = createBreachTask(projectId, name, slo, actual, db);
  }

  return { sloName: name, metricKey: slo.metricKey, threshold: slo.threshold, actual, passed, breachTaskId };
}

function createBreachTask(
  projectId: string,
  sloName: string,
  slo: SloDefinition,
  actual: number,
  db: DatabaseSync,
): string | undefined {
  const title = slo.onBreach?.taskTitle ?? `SLO breach: ${sloName}`;

  // Dedup: check for existing non-terminal breach task
  const existing = db.prepare(
    "SELECT id FROM tasks WHERE project_id = ? AND title = ? AND state NOT IN ('DONE', 'FAILED', 'CANCELLED') LIMIT 1",
  ).get(projectId, title) as Record<string, unknown> | undefined;

  if (existing) return existing.id as string;

  try {
    const task = createTask({
      projectId,
      title,
      description: `SLO "${sloName}" breached: actual=${actual.toFixed(2)}, threshold=${slo.threshold}, condition=${slo.condition}`,
      priority: (slo.onBreach?.taskPriority as "P0" | "P1" | "P2" | "P3") ?? (slo.severity === "critical" ? "P0" : "P1"),
      createdBy: "system:monitoring",
      tags: ["slo-breach", sloName],
    }, db);
    return task.id;
  } catch (err) {
    safeLog("slo.createBreachTask", err);
    return undefined;
  }
}
