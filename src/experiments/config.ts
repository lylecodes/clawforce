/**
 * Clawforce — Experiment variant config merging
 *
 * Merges variant-level overrides onto a base agent config.
 * Briefing replaces entirely when specified; expectations replace entirely;
 * all other fields merge/override individually.
 */

import type { AgentConfig, VariantConfig } from "../types.js";

/**
 * Merge a variant's config overrides onto a base agent config.
 *
 * Strategy:
 * - persona: replaces if specified
 * - briefing: replaces if specified (not appended)
 * - exclude_briefing: replaces if specified
 * - expectations: replaces if specified (not merged)
 * - performance_policy: replaces if specified
 * - model: stored in metadata (AgentConfig has no model field)
 * - context_overrides: stored in metadata
 */
export function mergeVariantConfig(baseConfig: AgentConfig, variant: VariantConfig): AgentConfig {
  const merged: AgentConfig = { ...baseConfig };

  if (variant.persona !== undefined) {
    merged.persona = variant.persona;
  }

  if (variant.briefing !== undefined) {
    merged.briefing = [...variant.briefing];
  }

  if (variant.exclude_briefing !== undefined) {
    merged.exclude_briefing = [...variant.exclude_briefing];
  }

  if (variant.expectations !== undefined) {
    merged.expectations = [...variant.expectations];
  }

  if (variant.performance_policy !== undefined) {
    merged.performance_policy = { ...variant.performance_policy };
  }

  // model and context_overrides don't have direct AgentConfig fields.
  // Store them via a special metadata convention so downstream consumers
  // can read them (e.g. dispatch layer checks for model override).
  if (variant.model !== undefined || variant.context_overrides !== undefined) {
    const existingMeta = (merged as any)._experimentOverrides ?? {};
    (merged as any)._experimentOverrides = {
      ...existingMeta,
      ...(variant.model !== undefined ? { model: variant.model } : {}),
      ...(variant.context_overrides !== undefined ? { context_overrides: variant.context_overrides } : {}),
    };
  }

  return merged;
}
