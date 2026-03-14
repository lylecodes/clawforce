/**
 * Clawforce — Budget Config Normalization
 *
 * Converts legacy BudgetConfig (flat cents fields) to BudgetConfigV2 (nested dimensions).
 * Called at config load time. All internal code uses BudgetConfigV2.
 */

import type { BudgetConfig, BudgetConfigV2 } from "../types.js";

function isLegacyConfig(config: unknown): config is BudgetConfig {
  if (!config || typeof config !== "object") return false;
  const c = config as Record<string, unknown>;
  return (
    "dailyLimitCents" in c ||
    "hourlyLimitCents" in c ||
    "monthlyLimitCents" in c ||
    "sessionLimitCents" in c ||
    "taskLimitCents" in c
  );
}

export function normalizeBudgetConfig(
  config: BudgetConfig | BudgetConfigV2 | undefined,
): BudgetConfigV2 {
  if (!config) return {};
  if (!isLegacyConfig(config)) return config as BudgetConfigV2;

  const v2: BudgetConfigV2 = {};
  if (config.dailyLimitCents) v2.daily = { cents: config.dailyLimitCents };
  if (config.hourlyLimitCents) v2.hourly = { cents: config.hourlyLimitCents };
  if (config.monthlyLimitCents) v2.monthly = { cents: config.monthlyLimitCents };
  if (config.sessionLimitCents) v2.session = { cents: config.sessionLimitCents };
  if (config.taskLimitCents) v2.task = { cents: config.taskLimitCents };
  return v2;
}
