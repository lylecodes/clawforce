import { getDb } from "../../db.js";
import { isDomainDisabled } from "../../enforcement/disabled-store.js";
import { computeHealthTier } from "../../monitoring/health-tier.js";
import type { AlertResult } from "../../monitoring/alerts.js";
import { evaluateAlertRules } from "../../monitoring/alerts.js";
import type { SloEvaluation } from "../../monitoring/slo.js";
import { evaluateSlos } from "../../monitoring/slo.js";
import { getExtendedProjectConfig } from "../../project.js";
import { isEmergencyStopActive } from "../../safety.js";
import type { AlertRuleDefinition, SloDefinition } from "../../types.js";

export type DomainSlosQueryResult = {
  slos: SloEvaluation[];
};

export type DomainAlertsQueryResult = {
  alerts: AlertResult[];
};

export type DomainHealthQueryResult = {
  tier: "GREEN" | "YELLOW" | "RED";
  sloChecked: number;
  sloBreach: number;
  alertsFired: number;
  emergencyStop: boolean;
  domainEnabled: boolean;
};

export function queryDomainSlos(projectId: string): DomainSlosQueryResult {
  const extConfig = getExtendedProjectConfig(projectId);
  if (!extConfig?.monitoring?.slos) return { slos: [] };

  const raw = extConfig.monitoring.slos as Record<string, Record<string, unknown>>;
  const normalized: Record<string, SloDefinition> = {};
  for (const [name, cfg] of Object.entries(raw)) {
    normalized[name] = {
      name,
      metricType: String(cfg.metric_type ?? cfg.metricType ?? ""),
      metricKey: String(cfg.metric_key ?? cfg.metricKey ?? ""),
      aggregation: String(cfg.aggregation ?? "avg") as SloDefinition["aggregation"],
      condition: String(cfg.condition ?? "lt") as SloDefinition["condition"],
      threshold: Number(cfg.threshold ?? 0),
      windowMs: Number(cfg.window_ms ?? cfg.windowMs ?? 3600000),
      severity: String(cfg.severity ?? "warning") as SloDefinition["severity"],
      denominatorKey: typeof cfg.denominator_key === "string" ? cfg.denominator_key : undefined,
      noDataPolicy: (cfg.no_data_policy ?? cfg.noDataPolicy ?? "pass") as SloDefinition["noDataPolicy"],
    };
  }

  const results = evaluateSlos(projectId, normalized);
  const db = getDb(projectId);

  for (const result of results) {
    if (result.actual !== null || result.metricKey !== "completion_rate") continue;

    try {
      const doneRow = db.prepare(
        "SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND state = 'DONE' AND (kind IS NULL OR kind != 'exercise')",
      ).get(projectId) as { cnt: number } | undefined;
      const totalRow = db.prepare(
        "SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND state != 'CANCELLED' AND (kind IS NULL OR kind != 'exercise')",
      ).get(projectId) as { cnt: number } | undefined;

      const done = doneRow?.cnt ?? 0;
      const total = totalRow?.cnt ?? 0;
      if (total === 0) continue;

      result.actual = done / total;
      const sloConfig = normalized[result.sloName];
      if (sloConfig) {
        switch (sloConfig.condition) {
          case "lt":
            result.passed = result.actual < sloConfig.threshold;
            break;
          case "gt":
            result.passed = result.actual > sloConfig.threshold;
            break;
          case "lte":
            result.passed = result.actual <= sloConfig.threshold;
            break;
          case "gte":
            result.passed = result.actual >= sloConfig.threshold;
            break;
        }
      }
      result.noData = false;
    } catch {
      // tasks table may not exist
    }
  }

  return { slos: results };
}

export function queryDomainAlerts(projectId: string): DomainAlertsQueryResult {
  const extConfig = getExtendedProjectConfig(projectId);
  if (!extConfig?.monitoring?.alertRules) return { alerts: [] };

  const raw = extConfig.monitoring.alertRules as Record<string, Record<string, unknown>>;
  const normalized: Record<string, AlertRuleDefinition> = {};
  const conditionMap: Record<string, AlertRuleDefinition["condition"]> = {
    ">": "gt",
    "<": "lt",
    ">=": "gte",
    "<=": "lte",
    "==": "eq",
    "=": "eq",
  };

  for (const [name, cfg] of Object.entries(raw)) {
    const rawCondition = String(cfg.condition ?? cfg.operator ?? "gt");
    normalized[name] = {
      name,
      metricType: String(cfg.metric_type ?? cfg.metricType ?? ""),
      metricKey: String(cfg.metric_key ?? cfg.metricKey ?? ""),
      aggregation: String(cfg.aggregation ?? "sum") as AlertRuleDefinition["aggregation"],
      condition: conditionMap[rawCondition] ?? rawCondition as AlertRuleDefinition["condition"],
      threshold: Number(cfg.threshold ?? 0),
      windowMs: Number(cfg.window_ms ?? cfg.windowMs ?? 3600000),
      cooldownMs: Number(cfg.cooldown_ms ?? cfg.cooldownMs ?? 3600000),
      action: String(cfg.action ?? "emit_event") as AlertRuleDefinition["action"],
      actionParams: cfg.action_params as AlertRuleDefinition["actionParams"] | undefined,
    };
  }

  return { alerts: evaluateAlertRules(projectId, normalized) };
}

export function queryDomainHealth(projectId: string): DomainHealthQueryResult {
  const emergencyStop = isEmergencyStopActive(projectId);
  const domainEnabled = !isDomainDisabled(projectId);
  const sloResults = queryDomainSlos(projectId).slos;
  const alertResults = queryDomainAlerts(projectId).alerts;

  const sloChecked = sloResults.filter((result) => !result.noData).length;
  const sloBreach = sloResults.filter((result) => result.passed === false && !result.noData).length;
  const alertsFired = alertResults.filter((result) => result.fired).length;

  return {
    tier: computeHealthTier({
      sloChecked,
      sloBreach,
      alertsFired,
      anomaliesDetected: 0,
    }),
    sloChecked,
    sloBreach,
    alertsFired,
    emergencyStop,
    domainEnabled,
  };
}
