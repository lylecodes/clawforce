/**
 * Clawforce — Monitoring sweep step
 *
 * Runs SLO evaluation, anomaly detection, and alert rule evaluation
 * as part of the sweep cycle. Called via dynamic import to avoid circular deps.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";
import { recordMetric } from "../metrics.js";
import type { ExtendedProjectConfig } from "../project.js";
import type { AlertRuleDefinition, AnomalyConfig, SloDefinition } from "../types.js";
import { evaluateAlertRules } from "./alerts.js";
import { detectAnomalies } from "./anomaly.js";
import { computeHealthTier, type HealthTier } from "./health-tier.js";
import { evaluateSlos } from "./slo.js";

export type MonitoringSweepResult = {
  sloChecked: number;
  sloBreach: number;
  alertsFired: number;
  anomaliesDetected: number;
  healthTier: HealthTier;
};

/**
 * Run all monitoring checks for a project.
 */
export function runMonitoringSweep(
  projectId: string,
  config: ExtendedProjectConfig | null,
  dbOverride?: DatabaseSync,
): MonitoringSweepResult {
  const db = dbOverride ?? getDb(projectId);

  let sloChecked = 0;
  let sloBreach = 0;
  let alertsFired = 0;
  let anomaliesDetected = 0;

  if (!config?.monitoring) return { sloChecked, sloBreach, alertsFired, anomaliesDetected, healthTier: "GREEN" as HealthTier };

  // Evaluate SLOs
  if (config.monitoring.slos) {
    try {
      const sloConfigs = normalizeSloConfigs(config.monitoring.slos);
      const results = evaluateSlos(projectId, sloConfigs, db);
      sloChecked = results.length;
      sloBreach = results.filter((r) => !r.passed).length;

      // Warn about SLOs with no data — these may indicate a broken metrics pipeline
      const noDataSlos = results.filter((r) => r.noData);
      if (noDataSlos.length > 0) {
        try {
          emitDiagnosticEvent({
            type: "slo.no_data",
            projectId,
            sloNames: noDataSlos.map((r) => r.sloName),
            count: noDataSlos.length,
          });
        } catch (e) { safeLog("monitoring.slo.noData", e); }
      }
    } catch (err) {
      safeLog("monitoring.slo", err);
    }
  }

  // Run anomaly detection
  if (config.monitoring.anomalyDetection) {
    try {
      const anomalyConfigs = normalizeAnomalyConfigs(config.monitoring.anomalyDetection);
      const results = detectAnomalies(projectId, anomalyConfigs, db);
      anomaliesDetected = results.filter((r) => r.isAnomaly).length;
    } catch (err) {
      safeLog("monitoring.anomaly", err);
    }
  }

  // Record budget utilization metrics so alert rules can evaluate them
  try {
    recordBudgetUtilizationMetrics(projectId, db);
  } catch (err) {
    safeLog("monitoring.budgetMetrics", err);
  }

  // Evaluate alert rules
  if (config.monitoring.alertRules) {
    try {
      const alertConfigs = normalizeAlertConfigs(config.monitoring.alertRules);
      const results = evaluateAlertRules(projectId, alertConfigs, db);
      alertsFired = results.filter((r) => r.fired).length;
    } catch (err) {
      safeLog("monitoring.alerts", err);
    }
  }

  const healthTier = computeHealthTier({ sloChecked, sloBreach, alertsFired, anomaliesDetected });
  return { sloChecked, sloBreach, alertsFired, anomaliesDetected, healthTier };
}

/**
 * Record budget utilization metrics for all budget rows so alert rules can evaluate them.
 * Records utilization as a percentage (0-100+) for cents and tokens dimensions.
 */
function recordBudgetUtilizationMetrics(projectId: string, db: DatabaseSync): void {
  const budgetRows = db.prepare(
    "SELECT * FROM budgets WHERE project_id = ?",
  ).all(projectId) as Record<string, number | string | null>[];

  for (const row of budgetRows) {
    const agentId = row.agent_id as string | null;
    const subject = agentId ?? projectId;

    const windows = ["hourly", "daily", "monthly"] as const;
    const dimensions = ["cents", "tokens", "requests"] as const;

    for (const win of windows) {
      for (const dim of dimensions) {
        const limit = row[`${win}_limit_${dim}`] as number | null;
        if (limit == null || limit <= 0) continue;

        const spent = (row[`${win}_spent_${dim}`] as number) ?? 0;
        const utilPct = Math.round((spent / limit) * 100);

        recordMetric({
          projectId,
          type: "cost",
          subject,
          key: `budget_${win}_${dim}_utilization`,
          value: utilPct,
          unit: "percent",
          tags: { agentId, window: win, dimension: dim, spent, limit },
        }, db);
      }
    }
  }
}

function normalizeSloConfigs(raw: Record<string, Record<string, unknown>>): Record<string, SloDefinition> {
  const result: Record<string, SloDefinition> = {};
  for (const [name, config] of Object.entries(raw)) {
    result[name] = {
      name,
      metricType: String(config.metric_type ?? ""),
      metricKey: String(config.metric_key ?? ""),
      aggregation: (String(config.aggregation ?? "avg")) as SloDefinition["aggregation"],
      condition: (String(config.condition ?? "lt")) as SloDefinition["condition"],
      threshold: Number(config.threshold ?? 0),
      windowMs: Number(config.window_ms ?? 3600000),
      denominatorKey: typeof config.denominator_key === "string" ? config.denominator_key : undefined,
      severity: (String(config.severity ?? "warning")) as SloDefinition["severity"],
      onBreach: config.on_breach && typeof config.on_breach === "object"
        ? {
            action: "create_task" as const,
            taskTitle: String((config.on_breach as Record<string, unknown>).task_title ?? `SLO breach: ${name}`),
            taskPriority: typeof (config.on_breach as Record<string, unknown>).task_priority === "string"
              ? String((config.on_breach as Record<string, unknown>).task_priority)
              : undefined,
          }
        : undefined,
    };
  }
  return result;
}

function normalizeAnomalyConfigs(raw: Record<string, Record<string, unknown>>): Record<string, AnomalyConfig> {
  const result: Record<string, AnomalyConfig> = {};
  for (const [name, config] of Object.entries(raw)) {
    result[name] = {
      name,
      metricType: String(config.metric_type ?? ""),
      metricKey: String(config.metric_key ?? ""),
      lookbackWindows: Number(config.lookback_windows ?? 24),
      windowMs: Number(config.window_ms ?? 3600000),
      stddevThreshold: Number(config.stddev_threshold ?? 3),
    };
  }
  return result;
}

const OPERATOR_TO_CONDITION: Record<string, string> = { ">": "gt", "<": "lt", ">=": "gte", "<=": "lte", "==": "eq", "=": "eq" };

function normalizeAlertConfigs(raw: Record<string, Record<string, unknown>>): Record<string, AlertRuleDefinition> {
  const result: Record<string, AlertRuleDefinition> = {};
  for (const [name, config] of Object.entries(raw)) {
    // Support both 'condition' and 'operator' field names, and symbolic operators like ">"
    const rawCondition = String(config.condition ?? config.operator ?? "gt");
    const condition = (OPERATOR_TO_CONDITION[rawCondition] ?? rawCondition) as AlertRuleDefinition["condition"];

    result[name] = {
      name,
      metricType: String(config.metric_type ?? ""),
      metricKey: String(config.metric_key ?? ""),
      condition,
      threshold: Number(config.threshold ?? 0),
      windowMs: Number(config.window_ms ?? 300000),
      action: (String(config.action ?? "create_task")) as AlertRuleDefinition["action"],
      actionParams: typeof config.action_params === "object" && config.action_params !== null
        ? config.action_params as Record<string, unknown>
        : undefined,
      cooldownMs: Number(config.cooldown_ms ?? 3600000),
    };
  }
  return result;
}
