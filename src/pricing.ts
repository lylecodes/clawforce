/**
 * Clawforce — Dynamic pricing
 *
 * Loads model pricing from OpenClaw's ModelDefinitionConfig at runtime.
 * Falls back to hardcoded defaults for offline/unknown models.
 */

export type ModelPricing = {
  inputPerM: number;    // cents per 1M input tokens
  outputPerM: number;   // cents per 1M output tokens
  cacheReadPerM: number;
  cacheWritePerM: number;
};

/** Hardcoded fallback pricing (Sonnet-level as safe middle ground). */
const DEFAULT_PRICING: ModelPricing = {
  inputPerM: 300,
  outputPerM: 1500,
  cacheReadPerM: 30,
  cacheWritePerM: 375,
};

/** Hardcoded baseline for known Claude models. */
const BUILTIN_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6":   { inputPerM: 1500, outputPerM: 7500, cacheReadPerM: 150,  cacheWritePerM: 1875 },
  "claude-sonnet-4-6": { inputPerM: 300,  outputPerM: 1500, cacheReadPerM: 30,   cacheWritePerM: 375  },
  "claude-haiku-4-5":  { inputPerM: 80,   outputPerM: 400,  cacheReadPerM: 8,    cacheWritePerM: 100  },
  // Aliases
  "opus":              { inputPerM: 1500, outputPerM: 7500, cacheReadPerM: 150,  cacheWritePerM: 1875 },
  "sonnet":            { inputPerM: 300,  outputPerM: 1500, cacheReadPerM: 30,   cacheWritePerM: 375  },
  "haiku":             { inputPerM: 80,   outputPerM: 400,  cacheReadPerM: 8,    cacheWritePerM: 100  },
};

const dynamicPricing = new Map<string, ModelPricing>();

export function getPricing(model: string): ModelPricing {
  return dynamicPricing.get(model)
    ?? BUILTIN_PRICING[model]
    ?? DEFAULT_PRICING;
}

export function registerModelPricing(model: string, pricing: ModelPricing): void {
  dynamicPricing.set(model, pricing);
}

/**
 * Register pricing from OpenClaw's ModelDefinitionConfig.cost format.
 * OpenClaw costs are in dollars per 1M tokens. We store cents per 1M tokens.
 */
export function registerModelPricingFromConfig(
  model: string,
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number },
): void {
  dynamicPricing.set(model, {
    inputPerM: Math.round(cost.input * 100),
    outputPerM: Math.round(cost.output * 100),
    cacheReadPerM: Math.round(cost.cacheRead * 100),
    cacheWritePerM: Math.round(cost.cacheWrite * 100),
  });
}

/**
 * Bulk register from OpenClaw model registry.
 */
export function registerBulkPricing(
  models: Array<{ id: string; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } }>,
): void {
  for (const m of models) {
    registerModelPricingFromConfig(m.id, m.cost);
  }
}

export function clearPricingCache(): void {
  dynamicPricing.clear();
}
