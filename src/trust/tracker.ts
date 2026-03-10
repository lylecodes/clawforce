/**
 * Clawforce — Trust evolution tracker
 *
 * Records approval/rejection decisions per action category.
 * Computes approval rates and suggests tier adjustments.
 * Handles trust decay for inactive categories.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";

// --- Types ---

export type TrustDecision = {
  id: string;
  projectId: string;
  category: string;
  decision: "approved" | "rejected";
  agentId?: string;
  proposalId?: string;
  toolName?: string;
  riskTier?: string;
  createdAt: number;
};

export type CategoryTrustStats = {
  category: string;
  totalDecisions: number;
  approved: number;
  rejected: number;
  approvalRate: number;
  lastDecisionAt: number;
};

export type TierSuggestion = {
  category: string;
  currentTier: string;
  suggestedTier: string;
  approvalRate: number;
  totalDecisions: number;
  reason: string;
};

export type TrustOverride = {
  id: string;
  projectId: string;
  category: string;
  originalTier: string;
  overrideTier: string;
  reason?: string;
  activatedAt: number;
  lastUsedAt?: number;
  decayAfterDays: number;
  status: "active" | "decayed" | "revoked";
};

// Categories that should NEVER auto-evolve without explicit opt-in
const PROTECTED_CATEGORIES = new Set([
  "financial", "purchase", "transfer", "subscribe", "pay_bill",
  "security", "permission_change", "delete",
  "code:merge_pr", "code:deploy", "code:release",
]);

// Minimum decisions before suggesting a tier adjustment
const MIN_DECISIONS_FOR_SUGGESTION = 10;

// Minimum approval rate to suggest downgrade
const MIN_APPROVAL_RATE = 0.95;

// --- Core functions ---

/**
 * Record a trust decision (approval or rejection).
 */
export function recordTrustDecision(
  params: {
    projectId: string;
    category: string;
    decision: "approved" | "rejected";
    agentId?: string;
    proposalId?: string;
    toolName?: string;
    riskTier?: string;
  },
  dbOverride?: DatabaseSync,
): TrustDecision {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO trust_decisions (id, project_id, category, decision, agent_id, proposal_id, tool_name, risk_tier, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, params.projectId, params.category, params.decision,
    params.agentId ?? null, params.proposalId ?? null,
    params.toolName ?? null, params.riskTier ?? null, now,
  );

  // Update last_used_at on any active override for this category
  try {
    db.prepare(`
      UPDATE trust_overrides SET last_used_at = ?
      WHERE project_id = ? AND category = ? AND status = 'active'
    `).run(now, params.projectId, params.category);
  } catch { /* trust_overrides table may not exist yet */ }

  return {
    id,
    projectId: params.projectId,
    category: params.category,
    decision: params.decision,
    agentId: params.agentId,
    proposalId: params.proposalId,
    toolName: params.toolName,
    riskTier: params.riskTier,
    createdAt: now,
  };
}

/**
 * Get trust stats for a specific category.
 */
export function getCategoryStats(
  projectId: string,
  category: string,
  dbOverride?: DatabaseSync,
  since?: number,
): CategoryTrustStats | null {
  const db = dbOverride ?? getDb(projectId);
  const sinceMs = since ?? 0;

  const rows = db.prepare(`
    SELECT decision, COUNT(*) as cnt, MAX(created_at) as last_at
    FROM trust_decisions
    WHERE project_id = ? AND category = ? AND created_at >= ?
    GROUP BY decision
  `).all(projectId, category, sinceMs) as Record<string, unknown>[];

  if (rows.length === 0) return null;

  let approved = 0;
  let rejected = 0;
  let lastDecisionAt = 0;

  for (const row of rows) {
    const count = row.cnt as number;
    const lastAt = row.last_at as number;
    if (lastAt > lastDecisionAt) lastDecisionAt = lastAt;

    if (row.decision === "approved") approved = count;
    else if (row.decision === "rejected") rejected = count;
  }

  const total = approved + rejected;
  return {
    category,
    totalDecisions: total,
    approved,
    rejected,
    approvalRate: total > 0 ? approved / total : 0,
    lastDecisionAt,
  };
}

/**
 * Get trust stats for all categories in a project.
 */
export function getAllCategoryStats(
  projectId: string,
  dbOverride?: DatabaseSync,
  since?: number,
): CategoryTrustStats[] {
  const db = dbOverride ?? getDb(projectId);
  const sinceMs = since ?? 0;

  const rows = db.prepare(`
    SELECT category, decision, COUNT(*) as cnt, MAX(created_at) as last_at
    FROM trust_decisions
    WHERE project_id = ? AND created_at >= ?
    GROUP BY category, decision
    ORDER BY category
  `).all(projectId, sinceMs) as Record<string, unknown>[];

  const map = new Map<string, { approved: number; rejected: number; lastAt: number }>();

  for (const row of rows) {
    const cat = row.category as string;
    const entry = map.get(cat) ?? { approved: 0, rejected: 0, lastAt: 0 };
    const count = row.cnt as number;
    const lastAt = row.last_at as number;

    if (row.decision === "approved") entry.approved = count;
    else if (row.decision === "rejected") entry.rejected = count;
    if (lastAt > entry.lastAt) entry.lastAt = lastAt;

    map.set(cat, entry);
  }

  return Array.from(map.entries()).map(([category, data]) => {
    const total = data.approved + data.rejected;
    return {
      category,
      totalDecisions: total,
      approved: data.approved,
      rejected: data.rejected,
      approvalRate: total > 0 ? data.approved / total : 0,
      lastDecisionAt: data.lastAt,
    };
  });
}

/**
 * Suggest tier adjustments based on approval history.
 * Returns suggestions for categories with high approval rates.
 */
export function suggestTierAdjustments(
  projectId: string,
  currentTiers: Record<string, string>,
  dbOverride?: DatabaseSync,
): TierSuggestion[] {
  const stats = getAllCategoryStats(projectId, dbOverride);
  const suggestions: TierSuggestion[] = [];

  for (const stat of stats) {
    // Skip protected categories
    if (isProtectedCategory(stat.category)) continue;

    // Skip categories with too few decisions
    if (stat.totalDecisions < MIN_DECISIONS_FOR_SUGGESTION) continue;

    // Skip categories with low approval rate
    if (stat.approvalRate < MIN_APPROVAL_RATE) continue;

    const currentTier = currentTiers[stat.category];
    if (!currentTier) continue;

    const suggestedTier = suggestLowerTier(currentTier);
    if (!suggestedTier || suggestedTier === currentTier) continue;

    suggestions.push({
      category: stat.category,
      currentTier,
      suggestedTier,
      approvalRate: stat.approvalRate,
      totalDecisions: stat.totalDecisions,
      reason: `${stat.approved} approvals, ${stat.rejected} rejection(s) (${Math.round(stat.approvalRate * 100)}% approval rate)`,
    });
  }

  return suggestions;
}

/**
 * Check if a category is protected from auto-evolution.
 */
export function isProtectedCategory(category: string): boolean {
  if (PROTECTED_CATEGORIES.has(category)) return true;
  // Also protect any category starting with a protected prefix
  for (const p of PROTECTED_CATEGORIES) {
    if (category.startsWith(p + ":")) return true;
  }
  return false;
}

/**
 * Suggest the next lower tier for a given tier.
 */
function suggestLowerTier(tier: string): string | null {
  switch (tier) {
    case "critical": return null; // never auto-lower critical
    case "high": return "medium";
    case "medium": return "low";
    case "low": return null; // already lowest
    default: return null;
  }
}

// --- Trust overrides ---

/**
 * Apply a trust override (tier adjustment) for a category.
 * Replaces any existing active override for the same category.
 */
export function applyTrustOverride(
  params: {
    projectId: string;
    category: string;
    originalTier: string;
    overrideTier: string;
    reason?: string;
    decayAfterDays?: number;
  },
  dbOverride?: DatabaseSync,
): TrustOverride {
  const db = dbOverride ?? getDb(params.projectId);
  const id = crypto.randomUUID();
  const now = Date.now();
  const decayDays = params.decayAfterDays ?? 30;

  // Revoke any existing active override for this category
  db.prepare(`
    UPDATE trust_overrides SET status = 'revoked'
    WHERE project_id = ? AND category = ? AND status = 'active'
  `).run(params.projectId, params.category);

  db.prepare(`
    INSERT INTO trust_overrides (id, project_id, category, original_tier, override_tier, reason, activated_at, last_used_at, decay_after_days, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(
    id, params.projectId, params.category,
    params.originalTier, params.overrideTier,
    params.reason ?? null, now, now, decayDays,
  );

  return {
    id,
    projectId: params.projectId,
    category: params.category,
    originalTier: params.originalTier,
    overrideTier: params.overrideTier,
    reason: params.reason,
    activatedAt: now,
    lastUsedAt: now,
    decayAfterDays: decayDays,
    status: "active",
  };
}

/**
 * Get the effective tier for a category, considering active overrides.
 * Returns the override tier if one exists, otherwise null.
 */
export function getEffectiveTierOverride(
  projectId: string,
  category: string,
  dbOverride?: DatabaseSync,
): TrustOverride | null {
  const db = dbOverride ?? getDb(projectId);

  const row = db.prepare(`
    SELECT * FROM trust_overrides
    WHERE project_id = ? AND category = ? AND status = 'active'
    LIMIT 1
  `).get(projectId, category) as Record<string, unknown> | undefined;

  if (!row) return null;
  return mapOverrideRow(row);
}

/**
 * Get all active trust overrides for a project.
 */
export function getActiveTrustOverrides(
  projectId: string,
  dbOverride?: DatabaseSync,
): TrustOverride[] {
  const db = dbOverride ?? getDb(projectId);

  const rows = db.prepare(`
    SELECT * FROM trust_overrides
    WHERE project_id = ? AND status = 'active'
    ORDER BY category
  `).all(projectId) as Record<string, unknown>[];

  return rows.map(mapOverrideRow);
}

/**
 * Process trust decay: find overrides where last_used_at is older than
 * decay_after_days and mark them as decayed.
 *
 * Returns the number of overrides decayed.
 */
export function processTrustDecay(
  projectId: string,
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();

  const rows = db.prepare(`
    SELECT * FROM trust_overrides
    WHERE project_id = ? AND status = 'active'
  `).all(projectId) as Record<string, unknown>[];

  let decayed = 0;

  for (const row of rows) {
    const lastUsed = row.last_used_at as number;
    const decayDays = row.decay_after_days as number;
    const decayMs = decayDays * 86_400_000;

    if (now - lastUsed > decayMs) {
      db.prepare(
        "UPDATE trust_overrides SET status = 'decayed' WHERE id = ?",
      ).run(row.id as string);
      decayed++;

      try {
        safeLog("trust.decay", `Category "${row.category}" override decayed (inactive for ${decayDays}+ days)`);
      } catch { /* */ }
    }
  }

  return decayed;
}

/**
 * Render trust summary as markdown for context/dashboard.
 */
export function renderTrustSummary(
  projectId: string,
  dbOverride?: DatabaseSync,
): string | null {
  const stats = getAllCategoryStats(projectId, dbOverride);
  if (stats.length === 0) return null;

  const overrides = getActiveTrustOverrides(projectId, dbOverride);
  const overrideMap = new Map(overrides.map((o) => [o.category, o]));

  const lines = ["## Trust Scores", ""];

  for (const stat of stats) {
    const pct = Math.round(stat.approvalRate * 100);
    const override = overrideMap.get(stat.category);
    const overrideTag = override ? ` (override: ${override.originalTier} -> ${override.overrideTier})` : "";
    const protectedTag = isProtectedCategory(stat.category) ? " [protected]" : "";

    lines.push(
      `- **${stat.category}**: ${pct}% approval (${stat.approved}/${stat.totalDecisions})${overrideTag}${protectedTag}`,
    );
  }

  // Show suggestions
  const suggestions = suggestTierAdjustments(
    projectId,
    Object.fromEntries(stats.map((s) => [s.category, "high"])),
    dbOverride,
  );

  if (suggestions.length > 0) {
    lines.push("");
    lines.push("### Suggested Adjustments");
    for (const s of suggestions) {
      lines.push(`- **${s.category}**: ${s.currentTier} -> ${s.suggestedTier} (${s.reason})`);
    }
  }

  return lines.join("\n");
}

// --- Helpers ---

function mapOverrideRow(row: Record<string, unknown>): TrustOverride {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    category: row.category as string,
    originalTier: row.original_tier as string,
    overrideTier: row.override_tier as string,
    reason: (row.reason as string) ?? undefined,
    activatedAt: row.activated_at as number,
    lastUsedAt: (row.last_used_at as number) ?? undefined,
    decayAfterDays: row.decay_after_days as number,
    status: row.status as TrustOverride["status"],
  };
}
