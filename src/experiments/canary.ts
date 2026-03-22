/**
 * Clawforce — Canary deployment health checks
 *
 * Evaluates whether a running experiment's non-control variants
 * should be promoted, rolled back, or left to continue.
 *
 * Decision logic:
 * - If any non-control variant has >0 sessions and compliance rate < 50%
 *   while the control is >=50%: recommend rollback.
 * - If all variants have sufficient sessions and the best non-control
 *   variant outperforms the control: recommend promotion.
 * - Otherwise: continue.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { rowToVariant } from "./lifecycle.js";

export type CanaryAction =
  | { action: "continue" }
  | { action: "rollback"; reason: string }
  | { action: "promote" };

/** Minimum sessions per variant before canary checks become actionable. */
const MIN_SESSIONS_FOR_DECISION = 3;

export function checkCanaryHealth(
  experimentId: string,
  db?: DatabaseSync,
): CanaryAction {
  const d = db ?? (() => { throw new Error("db required for checkCanaryHealth"); })();

  // Get experiment
  const expRow = d.prepare("SELECT * FROM experiments WHERE id = ?")
    .get(experimentId) as Record<string, unknown> | undefined;

  if (!expRow) throw new Error(`Experiment not found: ${experimentId}`);
  if (expRow.state !== "running") {
    return { action: "continue" };
  }

  // Get variants
  const variantRows = d.prepare(
    "SELECT * FROM experiment_variants WHERE experiment_id = ? ORDER BY created_at",
  ).all(experimentId) as Record<string, unknown>[];

  const variants = variantRows.map(rowToVariant);
  if (variants.length < 2) return { action: "continue" };

  const control = variants.find(v => v.isControl);
  const treatments = variants.filter(v => !v.isControl);

  // If no control is designated, can't compare — continue
  if (!control) return { action: "continue" };

  // Not enough data yet
  if (control.sessionCount < MIN_SESSIONS_FOR_DECISION) {
    return { action: "continue" };
  }

  const controlComplianceRate = control.sessionCount > 0
    ? control.compliantCount / control.sessionCount
    : 0;

  // Check for rollback: any treatment with enough data performing poorly
  for (const t of treatments) {
    if (t.sessionCount < MIN_SESSIONS_FOR_DECISION) continue;

    const tComplianceRate = t.compliantCount / t.sessionCount;

    // Treatment compliance significantly worse than control
    if (tComplianceRate < 0.5 && controlComplianceRate >= 0.5) {
      return {
        action: "rollback",
        reason: `Variant "${t.name}" compliance rate ${(tComplianceRate * 100).toFixed(1)}% is below 50% threshold while control is at ${(controlComplianceRate * 100).toFixed(1)}%`,
      };
    }
  }

  // Check for promotion: all treatments have enough data and best outperforms control
  const readyTreatments = treatments.filter(t => t.sessionCount >= MIN_SESSIONS_FOR_DECISION);
  if (readyTreatments.length === treatments.length && treatments.length > 0) {
    const bestTreatment = readyTreatments.reduce((best, t) => {
      const tRate = t.compliantCount / t.sessionCount;
      const bRate = best.compliantCount / best.sessionCount;
      return tRate > bRate ? t : best;
    });

    const bestRate = bestTreatment.compliantCount / bestTreatment.sessionCount;

    // Treatment outperforms control on compliance
    if (bestRate > controlComplianceRate) {
      return { action: "promote" };
    }

    // If treatment matches control on compliance but cheaper
    if (bestRate === controlComplianceRate && bestTreatment.sessionCount > 0 && control.sessionCount > 0) {
      const treatmentAvgCost = bestTreatment.totalCostCents / bestTreatment.sessionCount;
      const controlAvgCost = control.totalCostCents / control.sessionCount;
      if (treatmentAvgCost < controlAvgCost) {
        return { action: "promote" };
      }
    }
  }

  return { action: "continue" };
}
