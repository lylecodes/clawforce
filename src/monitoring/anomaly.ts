/**
 * Clawforce — Anomaly detection
 *
 * Moving-average anomaly detection using historical metric windows.
 * No ML, no external deps — just mean + stddev comparison.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { aggregateMetrics, type MetricType } from "../metrics.js";
import type { AnomalyConfig } from "../types.js";

export type AnomalyResult = {
  name: string;
  metricKey: string;
  currentValue: number;
  mean: number;
  stddev: number;
  isAnomaly: boolean;
  deviations: number;
};

/**
 * Run anomaly detection for all configured anomaly detectors.
 */
export function detectAnomalies(
  projectId: string,
  configs: Record<string, AnomalyConfig>,
  dbOverride?: DatabaseSync,
): AnomalyResult[] {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const results: AnomalyResult[] = [];

  for (const [name, config] of Object.entries(configs)) {
    const result = detectSingleAnomaly(projectId, name, config, now, db);
    if (result) results.push(result);
  }

  return results;
}

function detectSingleAnomaly(
  projectId: string,
  name: string,
  config: AnomalyConfig,
  now: number,
  db: DatabaseSync,
): AnomalyResult | null {
  const { metricType, metricKey, lookbackWindows, windowMs, stddevThreshold } = config;

  // Gather historical window values
  const windowValues: number[] = [];

  for (let i = 1; i <= lookbackWindows; i++) {
    const windowEnd = now - (i - 1) * windowMs;
    const windowStart = windowEnd - windowMs;

    const agg = aggregateMetrics({
      projectId,
      type: metricType as MetricType,
      key: metricKey,
      since: windowStart,
      until: windowEnd,
    }, db);

    if (agg.length > 0 && agg[0]!.count > 0) {
      windowValues.push(agg[0]!.sum);
    }
  }

  if (windowValues.length < 3) return null; // Not enough history

  // Current window
  const currentAgg = aggregateMetrics({
    projectId,
    type: metricType as MetricType,
    key: metricKey,
    since: now - windowMs,
    until: now,
  }, db);

  if (currentAgg.length === 0 || currentAgg[0]!.count === 0) return null;
  const currentValue = currentAgg[0]!.sum;

  // Calculate mean and stddev of historical windows
  const mean = windowValues.reduce((a, b) => a + b, 0) / windowValues.length;
  const variance = windowValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / windowValues.length;
  const stddev = Math.sqrt(variance);

  // Avoid division by zero — cap deviations to a finite number
  if (stddev === 0) {
    const isAnomaly = currentValue !== mean;
    return { name, metricKey, currentValue, mean, stddev: 0, isAnomaly, deviations: isAnomaly ? 1e6 : 0 };
  }

  const deviations = Math.abs(currentValue - mean) / stddev;
  const isAnomaly = deviations > stddevThreshold;

  return { name, metricKey, currentValue, mean, stddev, isAnomaly, deviations };
}
