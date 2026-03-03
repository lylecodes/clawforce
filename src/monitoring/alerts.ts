/**
 * Clawforce — Alert rule evaluation
 *
 * Evaluates alert rules against metrics and fires actions with cooldown.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { aggregateMetrics, type MetricType } from "../metrics.js";
import { safeLog } from "../diagnostics.js";
import { createTask } from "../tasks/ops.js";
import { ingestEvent } from "../events/store.js";
import type { AlertRuleDefinition } from "../types.js";

export type AlertResult = {
  name: string;
  fired: boolean;
  reason?: string;
};

/**
 * Evaluate all alert rules for a project.
 * Persists rules to DB on first call, checks cooldowns.
 */
export function evaluateAlertRules(
  projectId: string,
  rules: Record<string, AlertRuleDefinition>,
  dbOverride?: DatabaseSync,
): AlertResult[] {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const results: AlertResult[] = [];

  for (const [name, rule] of Object.entries(rules)) {
    const result = evaluateSingleRule(projectId, name, rule, now, db);
    results.push(result);
  }

  return results;
}

function evaluateSingleRule(
  projectId: string,
  name: string,
  rule: AlertRuleDefinition,
  now: number,
  db: DatabaseSync,
): AlertResult {
  // Check cooldown
  const dbRule = db.prepare(
    "SELECT id, last_fired_at FROM alert_rules WHERE project_id = ? AND name = ?",
  ).get(projectId, name) as Record<string, unknown> | undefined;

  if (dbRule) {
    const lastFired = dbRule.last_fired_at as number | null;
    if (lastFired && (now - lastFired) < rule.cooldownMs) {
      return { name, fired: false, reason: "cooldown" };
    }
  } else {
    // Persist rule to DB
    try {
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO alert_rules (id, project_id, name, metric_type, metric_key,
          condition, threshold, window_ms, action, action_params, cooldown_ms, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        id, projectId, name, rule.metricType, rule.metricKey,
        rule.condition, rule.threshold, rule.windowMs,
        rule.action, rule.actionParams ? JSON.stringify(rule.actionParams) : null,
        rule.cooldownMs,
      );
    } catch (err) {
      safeLog("alerts.persistRule", err);
    }
  }

  // Evaluate metric
  const since = now - rule.windowMs;
  const agg = aggregateMetrics({
    projectId,
    type: rule.metricType as MetricType,
    key: rule.metricKey,
    since,
    until: now,
  }, db);

  if (agg.length === 0 || agg[0]!.count === 0) {
    return { name, fired: false };
  }

  const value = agg[0]!.sum;
  let triggered = false;

  switch (rule.condition) {
    case "gt": triggered = value > rule.threshold; break;
    case "lt": triggered = value < rule.threshold; break;
    case "gte": triggered = value >= rule.threshold; break;
    case "lte": triggered = value <= rule.threshold; break;
    case "eq": triggered = value === rule.threshold; break;
  }

  if (!triggered) {
    return { name, fired: false };
  }

  // Fire action
  try {
    fireAlertAction(projectId, name, rule, value, now, db);
  } catch (err) {
    safeLog("alerts.fireAction", err);
  }

  // Update last_fired_at
  try {
    db.prepare(
      "UPDATE alert_rules SET last_fired_at = ? WHERE project_id = ? AND name = ?",
    ).run(now, projectId, name);
  } catch (err) {
    safeLog("alerts.updateLastFired", err);
  }

  return { name, fired: true, reason: `${rule.metricKey}: ${value} ${rule.condition} ${rule.threshold}` };
}

function fireAlertAction(
  projectId: string,
  name: string,
  rule: AlertRuleDefinition,
  value: number,
  now: number,
  db: DatabaseSync,
): void {
  switch (rule.action) {
    case "create_task": {
      const title = (rule.actionParams?.taskTitle as string) ?? `Alert: ${name}`;
      // Dedup
      const existing = db.prepare(
        "SELECT id FROM tasks WHERE project_id = ? AND title = ? AND state NOT IN ('DONE', 'FAILED', 'CANCELLED') LIMIT 1",
      ).get(projectId, title) as Record<string, unknown> | undefined;
      if (!existing) {
        createTask({
          projectId,
          title,
          description: `Alert "${name}" triggered: ${rule.metricKey}=${value.toFixed(2)} (threshold: ${rule.condition} ${rule.threshold})`,
          priority: (rule.actionParams?.priority as "P0" | "P1" | "P2" | "P3") ?? "P1",
          createdBy: "system:monitoring",
          tags: ["alert", name],
        }, db);
      }
      break;
    }
    case "emit_event":
      ingestEvent(projectId, "custom", "internal", {
        alert: name,
        metricKey: rule.metricKey,
        value,
        threshold: rule.threshold,
        condition: rule.condition,
      }, `alert:${name}`, db);
      break;
    case "escalate":
      ingestEvent(projectId, "sweep_finding", "internal", {
        finding: "alert_escalation",
        alert: name,
        metricKey: rule.metricKey,
        value,
      }, `alert-escalation:${name}`, db);
      break;
  }
}
