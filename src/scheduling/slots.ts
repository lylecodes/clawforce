/**
 * Clawforce — Rate-Aware Slot Calculator
 *
 * Computes how many concurrent sessions can be started per model
 * given rate limits, active sessions, and average token usage.
 */

export type ModelConfig = {
  rpm: number;
  tpm: number;
  costPer1kInput: number;
  costPer1kOutput: number;
};

export type SlotCalcInput = {
  models: Record<string, ModelConfig>;
  activeSessions: Record<string, number>;
  avgTokensPerSession: Record<string, number>;
};

export type SlotAvailability = {
  model: string;
  availableSlots: number;
  currentActive: number;
  rpmLimit: number;
  rpmUsed: number;
  tpmLimit: number;
  tpmEstimatedUsage: number;
  avgTokensPerSession: number;
};

const DEFAULT_AVG_TOKENS = 10000;
const DEFAULT_RPM_PER_SESSION = 5;

export function computeAvailableSlots(input: SlotCalcInput): SlotAvailability[] {
  const results: SlotAvailability[] = [];

  for (const [model, config] of Object.entries(input.models)) {
    const active = input.activeSessions[model] ?? 0;
    const avgTokens = input.avgTokensPerSession[model] ?? DEFAULT_AVG_TOKENS;

    const rpmUsed = active * DEFAULT_RPM_PER_SESSION;
    const rpmRemaining = Math.max(0, config.rpm - rpmUsed);
    const rpmSlots = Math.floor(rpmRemaining / DEFAULT_RPM_PER_SESSION);

    const tpmEstimatedUsage = active * avgTokens;
    const tpmRemaining = Math.max(0, config.tpm - tpmEstimatedUsage);
    const tpmSlots = avgTokens > 0 ? Math.floor(tpmRemaining / avgTokens) : 0;

    const availableSlots = Math.max(0, Math.min(rpmSlots, tpmSlots));

    results.push({
      model,
      availableSlots,
      currentActive: active,
      rpmLimit: config.rpm,
      rpmUsed,
      tpmLimit: config.tpm,
      tpmEstimatedUsage,
      avgTokensPerSession: avgTokens,
    });
  }

  return results;
}
