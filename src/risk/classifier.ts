/**
 * Clawforce — Risk classifier
 *
 * Classifies actions by risk tier based on pattern matching against config rules.
 * System actors (system:sweep) bypass classification.
 */

import type { RiskClassification, RiskPattern, RiskTier, RiskTierConfig } from "../types.js";

export type RiskContext = {
  actionType: string;
  toolName?: string;
  toolAction?: string;
  toState?: string;
  fromState?: string;
  taskPriority?: string;
  actor: string;
};

/**
 * Classify the risk tier of an action.
 * System actors bypass classification and always get "low".
 */
export function classifyRisk(
  context: RiskContext,
  config: RiskTierConfig,
): RiskClassification {
  // System actors bypass risk classification
  if (context.actor.startsWith("system:")) {
    return { tier: "low", reasons: ["system actor bypass"] };
  }

  if (!config.enabled) {
    return { tier: config.defaultTier, reasons: ["risk tiers disabled"] };
  }

  const reasons: string[] = [];
  let highestTier: RiskTier = config.defaultTier;

  // Evaluate patterns in order — higher tiers take precedence
  for (const pattern of config.patterns) {
    if (matchesPattern(context, pattern.match)) {
      if (tierOrdinal(pattern.tier) > tierOrdinal(highestTier)) {
        highestTier = pattern.tier;
        reasons.push(describePatternMatch(pattern));
      }
    }
  }

  // Priority-based escalation: P0 tasks get tier bumped by one
  if (context.taskPriority === "P0" && tierOrdinal(highestTier) < tierOrdinal("high")) {
    highestTier = bumpTier(highestTier);
    reasons.push("P0 task priority escalation");
  }

  if (reasons.length === 0) {
    reasons.push(`default tier: ${config.defaultTier}`);
  }

  return { tier: highestTier, reasons };
}

function matchesPattern(context: RiskContext, match: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(match)) {
    let contextValue: string | undefined;
    switch (key) {
      case "action_type": contextValue = context.actionType; break;
      case "tool_name": contextValue = context.toolName; break;
      case "tool_action": contextValue = context.toolAction; break;
      case "to_state": contextValue = context.toState; break;
      case "from_state": contextValue = context.fromState; break;
      case "task_priority": contextValue = context.taskPriority; break;
      default: continue;
    }
    if (contextValue !== String(value)) return false;
  }
  return true;
}

function describePatternMatch(pattern: RiskPattern): string {
  const parts = Object.entries(pattern.match).map(([k, v]) => `${k}=${v}`);
  return `pattern match: ${parts.join(", ")} → ${pattern.tier}`;
}

function tierOrdinal(tier: RiskTier): number {
  switch (tier) {
    case "low": return 0;
    case "medium": return 1;
    case "high": return 2;
    case "critical": return 3;
    default: return 0;
  }
}

function bumpTier(tier: RiskTier): RiskTier {
  switch (tier) {
    case "low": return "medium";
    case "medium": return "high";
    case "high": return "critical";
    case "critical": return "critical";
    default: return "medium";
  }
}
