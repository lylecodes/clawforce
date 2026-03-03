/**
 * Clawforce — Risk config helpers
 *
 * Parse and normalize risk tier configuration from YAML.
 */

import type { RiskTierConfig } from "../types.js";

/** Default risk tier config when none is specified. */
export const DEFAULT_RISK_CONFIG: RiskTierConfig = {
  enabled: false,
  defaultTier: "low",
  policies: {
    low: { gate: "none" },
    medium: { gate: "delay", delayMs: 30000 },
    high: { gate: "approval" },
    critical: { gate: "human_approval" },
  },
  patterns: [],
};

/**
 * Get the risk config for a project, falling back to defaults.
 */
export function getRiskConfig(config: RiskTierConfig | undefined): RiskTierConfig {
  return config ?? DEFAULT_RISK_CONFIG;
}
