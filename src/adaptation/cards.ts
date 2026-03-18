/**
 * Clawforce — Adaptation Cards
 *
 * Defines the manager's adaptation toolkit and trust-gated permissions.
 * Each card has a risk level. Trust tier determines whether the card
 * requires human approval or can be auto-approved.
 */

export type CardRisk = "none" | "low" | "medium" | "high";

export type AdaptationCard = {
  name: string;
  description: string;
  risk: CardRisk;
};

export const ADAPTATION_CARDS: Record<string, AdaptationCard> = {
  skill_creation: {
    name: "Skill Creation",
    description: "Create a new skill from repeated patterns",
    risk: "low",
  },
  budget_reallocation: {
    name: "Budget Reallocation",
    description: "Shift budget between agents",
    risk: "low",
  },
  process_change: {
    name: "Process Change",
    description: "Add/remove approval gates, change tick frequency",
    risk: "medium",
  },
  agent_hiring: {
    name: "Agent Hiring",
    description: "Spin up a new specialist agent",
    risk: "medium",
  },
  agent_splitting: {
    name: "Agent Splitting",
    description: "Split an overloaded agent into two focused agents",
    risk: "medium",
  },
  infra_provisioning: {
    name: "Infra Provisioning",
    description: "Set up monitoring, CI/CD, alerting",
    risk: "high",
  },
  escalation: {
    name: "Escalation",
    description: "Flag an issue to the human",
    risk: "none",
  },
};

export type PermissionResult = {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
};

/**
 * Check whether a manager can execute an adaptation card at the given trust score.
 *
 * Trust tiers:
 * - Low (< 0.4): all cards require approval except escalation
 * - Medium (0.4-0.7): low-risk auto-approved, medium/high require approval
 * - High (> 0.7): low+medium auto-approved, high requires approval
 */
export function checkAdaptationPermission(
  cardType: string,
  trustScore: number,
): PermissionResult {
  const card = ADAPTATION_CARDS[cardType];
  if (!card) {
    return { allowed: false, requiresApproval: false, reason: `Unknown card type: ${cardType}` };
  }

  if (card.risk === "none") {
    return { allowed: true, requiresApproval: false };
  }

  const tier = trustScore > 0.7 ? "high" : trustScore > 0.4 ? "medium" : "low";

  if (tier === "low") {
    return { allowed: true, requiresApproval: true, reason: "Low trust — all adaptations require approval" };
  }

  if (tier === "medium") {
    if (card.risk === "low") {
      return { allowed: true, requiresApproval: false };
    }
    return { allowed: true, requiresApproval: true, reason: `Medium trust — ${card.risk}-risk cards require approval` };
  }

  // High trust
  if (card.risk === "high") {
    return { allowed: true, requiresApproval: true, reason: "High-risk cards always require approval" };
  }
  return { allowed: true, requiresApproval: false };
}
