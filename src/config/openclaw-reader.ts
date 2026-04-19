/**
 * Clawforce — OpenClaw Config Reader
 *
 * Cached reader for OpenClaw agent runtime config (model, pricing, rate limits).
 * Used when Clawforce needs runtime data it no longer stores itself.
 *
 * Cache loaded at gateway_start, invalidated on config watcher reload.
 * Used on warm paths (cost estimation, capacity), NOT hot paths (dispatch gates use own counters).
 */

import {
  getOpenClawConfigSnapshot,
  setOpenClawConfigSnapshot,
} from "../runtime/integrations.js";
import type { OpenClawConfigSnapshot } from "../runtime/ports.js";

function resolveModelRef(
  value: string | { primary?: string; fallbacks?: string[] } | null | undefined,
): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && typeof value.primary === "string" && value.primary.trim()) {
    return value.primary.trim();
  }
  return null;
}

/** Set the cached config (called at gateway_start or on config reload). */
export function setOpenClawConfig(config: OpenClawConfigSnapshot): void {
  setOpenClawConfigSnapshot(config);
}

/** Clear the cache (for testing or forced refresh). */
export function clearOpenClawConfigCache(): void {
  setOpenClawConfigSnapshot(null);
}

/** Get the model for an agent. Falls back to agent defaults. */
export function getAgentModel(agentId: string): string | null {
  const cachedConfig = getOpenClawConfigSnapshot();
  if (!cachedConfig?.agents) return null;

  const agent = cachedConfig.agents.list?.find((a) => a.id === agentId);
  return resolveModelRef(agent?.model) ?? resolveModelRef(cachedConfig.agents.defaults?.model);
}

/** Get the tools list for an agent. */
export function getAgentTools(agentId: string): string[] | null {
  const cachedConfig = getOpenClawConfigSnapshot();
  if (!cachedConfig?.agents) return null;
  const agent = cachedConfig.agents.list?.find((a) => a.id === agentId);
  return agent?.tools ?? null;
}

/** Get pricing for a model (cents per 1M tokens). */
export function getModelPricing(
  modelId: string,
): { inputPer1M: number; outputPer1M: number } | null {
  const cachedConfig = getOpenClawConfigSnapshot();
  if (!cachedConfig?.models?.providers) return null;

  for (const provider of cachedConfig.models.providers) {
    const model = provider.models?.find((m) => m.id === modelId);
    if (model?.cost) {
      return {
        inputPer1M: model.cost.input ?? 0,
        outputPer1M: model.cost.output ?? 0,
      };
    }
  }

  return null;
}
