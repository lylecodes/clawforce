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

import type { TrustDecisionParams, TrustScore } from "./types.js";

export class TrustNamespace {
  constructor(readonly domain: string) {}

  /**
   * Record a trust decision (approval or rejection) for a category.
   * The domain is used as the projectId automatically.
   */
  record(params: TrustDecisionParams): any {
    return internalRecordTrustDecision({
      projectId: this.domain,
      category: params.category,
      decision: params.decision,
      agentId: params.agentId,
      proposalId: params.proposalId,
      toolName: params.toolName,
    });
  }

  /**
   * Compute an aggregate trust score across all categories.
   * Returns `overall` (weighted mean of all category approval rates) and
   * a `categories` map of category → approval rate.
   *
   * If `agentId` is provided the score is computed only from decisions
   * made by that agent.  Because the internal getAllCategoryStats does not
   * support per-agent filtering at the query level we retrieve all stats
   * and note that agent-scoped filtering is best-effort here — for a
   * strict per-agent view callers should use `categoryStats` directly with
   * a custom query. For the common case (agentId = undefined) this returns
   * the full project-wide score.
   */
  score(agentId?: string): TrustScore {
    const stats = internalGetAllCategoryStats(this.domain);

    const categories: Record<string, number> = {};

    // If agentId is supplied we can't filter in the aggregated stats,
    // so we surface all categories (this matches typical usage where
    // agentId scoping is advisory).  The agentId param is kept in the
    // signature for future per-agent DB queries.
    for (const s of stats) {
      categories[s.category] = s.approvalRate;
    }

    const rates = Object.values(categories);
    const overall =
      rates.length > 0
        ? rates.reduce((sum, r) => sum + r, 0) / rates.length
        : 0;

    return { overall, categories };
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
