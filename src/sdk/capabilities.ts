/**
 * Clawforce SDK — Capability Resolution
 *
 * Maps built-in agent presets to capability sets and provides helpers
 * for querying what a given agent config is allowed to do.
 *
 * Replaces hardcoded `extends === "manager"` checks throughout the codebase
 * with the abstract `hasCapability(config, "coordinate")` pattern.
 */

import type { AgentCapability } from "./types.js";

// Map built-in presets to capabilities
const PRESET_CAPABILITIES: Record<string, AgentCapability[]> = {
  manager: ["coordinate", "create_tasks", "run_meetings", "review_work", "escalate"],
  employee: ["execute_tasks", "report_status"],
  assistant: ["monitor", "report_status"],
};

/**
 * Resolve the full capability set for an agent config.
 *
 * Resolution order:
 *   1. Start with preset capabilities (from `extends`, defaulting to "employee")
 *   2. Merge in any custom `capabilities` declared directly on the config
 *   3. Add "coordinate" if `coordination.enabled` is true
 *
 * userPresets allows callers to supply their own preset→capability mappings
 * that take precedence over the built-in ones.
 */
export function getAgentCapabilities(
  config: { extends?: string; capabilities?: AgentCapability[]; coordination?: { enabled?: boolean } },
  userPresets?: Record<string, { capabilities?: AgentCapability[] }>,
): AgentCapability[] {
  const presetName = config.extends ?? "employee";
  const presetCaps =
    userPresets?.[presetName]?.capabilities ??
    PRESET_CAPABILITIES[presetName] ??
    ["execute_tasks", "report_status"];
  const customCaps = config.capabilities ?? [];
  // coordination.enabled implies coordinate capability
  const coordCap: AgentCapability[] = config.coordination?.enabled ? ["coordinate"] : [];
  return [...new Set([...presetCaps, ...customCaps, ...coordCap])];
}

/**
 * Check whether a given agent config has a specific capability.
 *
 * @param config     - The agent's configuration object (internal or SDK shape)
 * @param capability - The capability to test for
 * @param userPresets - Optional caller-supplied preset→capability overrides
 */
export function hasCapability(
  config: { extends?: string; capabilities?: AgentCapability[]; coordination?: { enabled?: boolean } },
  capability: AgentCapability,
  userPresets?: Record<string, { capabilities?: AgentCapability[] }>,
): boolean {
  return getAgentCapabilities(config, userPresets).includes(capability);
}
