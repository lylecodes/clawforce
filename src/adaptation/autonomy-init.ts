/**
 * Clawforce — Autonomy Initialization
 *
 * Seeds trust overrides based on the autonomy level in DIRECTION.md.
 * Overrides decay naturally as real trust decisions accumulate.
 */

import type { DatabaseSync } from "../sqlite-driver.js";
import { applyTrustOverride } from "../trust/tracker.js";
import type { Autonomy } from "../direction.js";

const ADAPTATION_CATEGORIES = [
  "adaptation:skill_creation",
  "adaptation:budget_reallocation",
  "adaptation:process_change",
  "adaptation:agent_hiring",
  "adaptation:agent_splitting",
  "adaptation:infra_provisioning",
];

/**
 * Initialize trust overrides based on DIRECTION.md autonomy level.
 *
 * - low: no overrides (default zero-trust start)
 * - medium: override all adaptation categories to medium tier
 * - high: override all adaptation categories to high tier
 *
 * All overrides decay after 14 days.
 */
export function initializeAutonomy(
  projectId: string,
  autonomy: Autonomy,
  db?: DatabaseSync,
): void {
  if (autonomy === "low") return;

  const overrideTier = autonomy; // "medium" or "high"

  for (const category of ADAPTATION_CATEGORIES) {
    applyTrustOverride({
      projectId,
      category,
      originalTier: "low",
      overrideTier,
      reason: `Initialized from DIRECTION.md autonomy: ${autonomy}`,
      decayAfterDays: 14,
    }, db);
  }
}
