/**
 * Clawforce — Experiment results and outcome recording
 *
 * Records session outcomes, updates variant aggregate stats,
 * and computes winners using compliance > cost > speed ordering.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import type { ExperimentOutcome, ExperimentVariant } from "../types.js";
import { rowToVariant } from "./lifecycle.js";

// --- Record outcome ---

export function recordExperimentOutcome(
  experimentId: string,
  variantId: string,
  sessionKey: string,
  outcome: ExperimentOutcome,
  db?: DatabaseSync,
): void {
  const d = db ?? (() => { throw new Error("db required for recordExperimentOutcome"); })();

  // Update the session record
  const now = Date.now();
  d.prepare(`
    UPDATE experiment_sessions
    SET completed_at = ?, outcome = ?
    WHERE experiment_id = ? AND variant_id = ? AND session_key = ?
  `).run(now, JSON.stringify(outcome), experimentId, variantId, sessionKey);

  // Update variant aggregate stats
  d.prepare(`
    UPDATE experiment_variants
    SET total_cost_cents = total_cost_cents + ?,
        total_duration_ms = total_duration_ms + ?,
        compliant_count = compliant_count + ?
    WHERE id = ? AND experiment_id = ?
  `).run(
    outcome.costCents,
    outcome.durationMs,
    outcome.compliant === true ? 1 : 0,
    variantId,
    experimentId,
  );
}

// --- Variant results ---

export type VariantResult = ExperimentVariant & {
  complianceRate: number;
  avgCostCents: number;
  avgDurationMs: number;
  errorRate: number;
};

export type ExperimentResults = {
  experimentId: string;
  projectId: string;
  variants: VariantResult[];
  winner: VariantResult | null;
};

/**
 * Compute per-variant aggregations and determine the winner.
 *
 * Winner logic: highest compliance rate, then lowest avg cost, then fastest avg duration.
 */
export function getExperimentResults(
  projectId: string,
  experimentId: string,
  db?: DatabaseSync,
): ExperimentResults {
  const d = db ?? getDb(projectId);

  const variantRows = d.prepare(
    "SELECT * FROM experiment_variants WHERE experiment_id = ? ORDER BY created_at",
  ).all(experimentId) as Record<string, unknown>[];

  const variants: VariantResult[] = variantRows.map(row => {
    const v = rowToVariant(row);

    // Compute error count from sessions
    const sessions = d.prepare(
      "SELECT outcome FROM experiment_sessions WHERE experiment_id = ? AND variant_id = ? AND outcome IS NOT NULL",
    ).all(experimentId, v.id) as { outcome: string }[];

    let totalErrors = 0;
    for (const s of sessions) {
      try {
        const o = JSON.parse(s.outcome) as ExperimentOutcome;
        totalErrors += o.errorCount;
      } catch { /* skip */ }
    }

    const sessionCount = v.sessionCount || 1; // avoid division by zero
    return {
      ...v,
      complianceRate: v.sessionCount > 0 ? v.compliantCount / v.sessionCount : 0,
      avgCostCents: v.sessionCount > 0 ? v.totalCostCents / v.sessionCount : 0,
      avgDurationMs: v.sessionCount > 0 ? v.totalDurationMs / v.sessionCount : 0,
      errorRate: v.sessionCount > 0 ? totalErrors / v.sessionCount : 0,
    };
  });

  // Determine winner: highest compliance rate, then lowest cost, then fastest
  const candidates = variants.filter(v => v.sessionCount > 0);
  let winner: VariantResult | null = null;

  if (candidates.length > 0) {
    winner = candidates.reduce((best, v) => {
      // Higher compliance is better
      if (v.complianceRate > best.complianceRate) return v;
      if (v.complianceRate < best.complianceRate) return best;
      // Lower cost is better
      if (v.avgCostCents < best.avgCostCents) return v;
      if (v.avgCostCents > best.avgCostCents) return best;
      // Faster is better
      if (v.avgDurationMs < best.avgDurationMs) return v;
      return best;
    });
  }

  return {
    experimentId,
    projectId,
    variants,
    winner,
  };
}
