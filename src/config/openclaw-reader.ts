/**
 * Clawforce — OpenClaw Config Reader
 *
 * Cached reader for OpenClaw agent runtime config (model, pricing, rate limits).
 * Used when Clawforce needs runtime data it no longer stores itself.
 *
 * Cache loaded at gateway_start, invalidated on config watcher reload.
 * Used on warm paths (cost estimation, capacity), NOT hot paths (dispatch gates use own counters).
 */

type OpenClawAgentEntry = {
  id: string;
  model?: { primary?: string };
  tools?: string[];
  [key: string]: unknown;
};

type OpenClawModelEntry = {
  id: string;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  [key: string]: unknown;
};

type OpenClawProviderEntry = {
  id: string;
  models?: OpenClawModelEntry[];
  rpm?: number;
  tpm?: number;
  [key: string]: unknown;
};

type OpenClawConfigSnapshot = {
  agents?: {
    list?: OpenClawAgentEntry[];
    defaults?: { model?: string; [key: string]: unknown };
  };
  models?: {
    providers?: OpenClawProviderEntry[];
  };
  [key: string]: unknown;
};

let cachedConfig: OpenClawConfigSnapshot | null = null;

/** Set the cached config (called at gateway_start or on config reload). */
export function setOpenClawConfig(config: OpenClawConfigSnapshot): void {
  cachedConfig = config;
}

/** Clear the cache (for testing or forced refresh). */
export function clearOpenClawConfigCache(): void {
  cachedConfig = null;
}

/** Get the model for an agent. Falls back to agent defaults. */
export function getAgentModel(agentId: string): string | null {
  if (!cachedConfig?.agents) return null;

  const agent = cachedConfig.agents.list?.find((a) => a.id === agentId);
  if (agent?.model?.primary) return agent.model.primary;

  return cachedConfig.agents.defaults?.model ?? null;
}

/** Get the tools list for an agent. */
export function getAgentTools(agentId: string): string[] | null {
  if (!cachedConfig?.agents) return null;
  const agent = cachedConfig.agents.list?.find((a) => a.id === agentId);
  return agent?.tools ?? null;
}

/** Get pricing for a model (cents per 1M tokens). */
export function getModelPricing(
  modelId: string,
): { inputPer1M: number; outputPer1M: number } | null {
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

