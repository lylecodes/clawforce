/**
 * Clawforce SDK — Trust Namespace
 *
 * Wraps internal trust tracker functions with the public SDK API.
 * All operations are scoped to the domain (projectId) passed at construction.
 */

import {
  recordTrustDecision as internalRecordTrustDecision,
  getCategoryStats as internalGetCategoryStats,
  getAllCategoryStats as internalGetAllCategoryStats,
  applyTrustOverride as internalApplyTrustOverride,
  getActiveTrustOverrides as internalGetActiveTrustOverrides,
} from "../trust/tracker.js";

import type { TrustDecisionParams, TrustScore, TrustScoreOptions, TrustTier, TrustTierThresholds } from "./types.js";
import { getDb } from "../db.js";

const DEFAULT_TIERS: TrustTierThresholds = { high: 0.8, medium: 0.5 };

export class TrustNamespace {
  constructor(readonly domain: string) {}

  /**
   * Record a trust decision (approval or rejection) for a category.
   * Optionally include severity (0-1) — higher severity means bigger trust impact.
   */
  record(params: TrustDecisionParams): any {
    return internalRecordTrustDecision({
      projectId: this.domain,
      category: params.category,
      decision: params.decision,
      agentId: params.agentId,
      proposalId: params.proposalId,
      toolName: params.toolName,
      severity: params.severity,
    });
  }

  /**
   * Compute an aggregate trust score across all categories.
   *
   * Options:
   * - `recencyDecay`: Weight recent decisions more (0-1 decay factor per day). Default 0.95.
   * - `tiers`: Custom thresholds for high/medium/low enforcement tiers.
   *
   * Returns `overall`, `categories` map, and `tier` (enforcement level).
   */
  score(agentIdOrOpts?: string | TrustScoreOptions, opts?: TrustScoreOptions): TrustScore {
    // Handle overloaded signature: score(), score("agent-1"), score({ recencyDecay: 0.9 }), score("agent-1", { ... })
    let agentId: string | undefined;
    let options: TrustScoreOptions | undefined;
    if (typeof agentIdOrOpts === "string") {
      agentId = agentIdOrOpts;
      options = opts;
    } else if (typeof agentIdOrOpts === "object") {
      options = agentIdOrOpts;
    }

    const recencyDecay = options?.recencyDecay ?? 0.95;
    const tiers = options?.tiers ?? DEFAULT_TIERS;

    // Use recency-weighted scoring if decay < 1
    if (recencyDecay < 1) {
      return this.computeRecencyWeightedScore(agentId, recencyDecay, tiers);
    }

    // Fall back to simple approval rate (original behavior)
    const stats = internalGetAllCategoryStats(this.domain);
    const categories: Record<string, number> = {};
    for (const s of stats) {
      categories[s.category] = s.approvalRate;
    }
    const rates = Object.values(categories);
    const overall = rates.length > 0
      ? rates.reduce((sum, r) => sum + r, 0) / rates.length
      : 0;

    return { overall, categories, tier: computeTier(overall, tiers) };
  }

  /**
   * Get the enforcement tier for a given trust score.
   * - high: allow + notify (score > high threshold)
   * - medium: warn (score > medium threshold)
   * - low: block + escalate (score <= medium threshold)
   */
  tier(scoreOrAgentId?: number | string): TrustTier {
    if (typeof scoreOrAgentId === "number") {
      return computeTier(scoreOrAgentId, DEFAULT_TIERS);
    }
    const { tier } = this.score(scoreOrAgentId);
    return tier;
  }

  private computeRecencyWeightedScore(
    _agentId: string | undefined,
    decayPerDay: number,
    tiers: TrustTierThresholds,
  ): TrustScore {
    const db = getDb(this.domain);
    const now = Date.now();
    const msPerDay = 86_400_000;

    // Fetch all decisions with severity
    const rows = db.prepare(`
      SELECT category, decision, severity, created_at
      FROM trust_decisions
      WHERE project_id = ?
      ORDER BY created_at DESC
    `).all(this.domain) as { category: string; decision: string; severity: number; created_at: number }[];

    // Group by category with weighted scoring
    const categoryWeights = new Map<string, { weightedApproved: number; weightedTotal: number }>();

    for (const row of rows) {
      const daysAgo = (now - row.created_at) / msPerDay;
      const recencyWeight = Math.pow(decayPerDay, daysAgo);
      const severity = row.severity ?? 1.0;
      const weight = recencyWeight * severity;

      const entry = categoryWeights.get(row.category) ?? { weightedApproved: 0, weightedTotal: 0 };
      entry.weightedTotal += weight;
      if (row.decision === "approved") {
        entry.weightedApproved += weight;
      }
      categoryWeights.set(row.category, entry);
    }

    const categories: Record<string, number> = {};
    for (const [cat, data] of categoryWeights) {
      categories[cat] = data.weightedTotal > 0 ? data.weightedApproved / data.weightedTotal : 0;
    }

    const rates = Object.values(categories);
    const overall = rates.length > 0
      ? rates.reduce((sum, r) => sum + r, 0) / rates.length
      : 0;

    return { overall, categories, tier: computeTier(overall, tiers) };
  }

  /**
   * Get trust stats for a specific category.
   * Returns null if no decisions have been recorded for that category.
   */
  categoryStats(category: string): any {
    return internalGetCategoryStats(this.domain, category);
  }

  /**
   * Get trust stats for all categories in this domain.
   */
  allStats(): any[] {
    return internalGetAllCategoryStats(this.domain);
  }

  /**
   * Apply a trust override (tier adjustment) for a category.
   * Replaces any existing active override for the same category.
   */
  override(params: {
    category: string;
    originalTier: string;
    overrideTier: string;
    reason?: string;
    decayAfterDays?: number;
  }): any {
    return internalApplyTrustOverride({
      projectId: this.domain,
      category: params.category,
      originalTier: params.originalTier,
      overrideTier: params.overrideTier,
      reason: params.reason,
      decayAfterDays: params.decayAfterDays,
    });
  }

  /**
   * Get all active trust overrides for this domain.
   */
  overrides(): any[] {
    return internalGetActiveTrustOverrides(this.domain);
  }
}

/** Map a trust score (0-1) to an enforcement tier */
function computeTier(score: number, thresholds: TrustTierThresholds): TrustTier {
  if (score > thresholds.high) return "high";
  if (score > thresholds.medium) return "medium";
  return "low";
}
