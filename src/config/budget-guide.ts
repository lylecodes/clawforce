/**
 * Clawforce — Budget Guidance
 *
 * Estimates daily budget based on team composition and model costs.
 * Provides per-agent cost breakdowns for init wizard and runtime guidance.
 */

export type AgentBudgetInput = {
  agentId: string;
  model: string;
  role: "manager" | "employee";
};

export type AgentCostEstimate = {
  agentId: string;
  model: string;
  sessionsPerDay: number;
  costPerSession: number;
  dailyCost: number;
};

export type BudgetEstimate = {
  recommended: number;
  low: number;
  high: number;
  breakdown: AgentCostEstimate[];
};

/** Default cost per session in cents, keyed by model identifier. */
export const MODEL_COSTS: Record<string, number> = {
  "anthropic/claude-opus-4-6": 150,
  "anthropic/claude-sonnet-4-6": 30,
  "anthropic/claude-haiku-4-5": 8,
  "claude-opus-4-6": 150,
  "claude-sonnet-4-6": 30,
  "claude-haiku-4-5": 8,
};

const DEFAULT_SESSIONS: Record<string, number> = {
  manager: 6,
  employee: 4,
};

const FALLBACK_COST = MODEL_COSTS["anthropic/claude-sonnet-4-6"];

export function estimateBudget(
  agents: AgentBudgetInput[],
  modelCostOverrides?: Record<string, number>,
): BudgetEstimate {
  const breakdown: AgentCostEstimate[] = agents.map((agent) => {
    const costPerSession =
      modelCostOverrides?.[agent.model] ??
      MODEL_COSTS[agent.model] ??
      FALLBACK_COST;
    const sessionsPerDay = DEFAULT_SESSIONS[agent.role] ?? 4;
    const dailyCost = costPerSession * sessionsPerDay;

    return {
      agentId: agent.agentId,
      model: agent.model,
      sessionsPerDay,
      costPerSession,
      dailyCost,
    };
  });

  const recommended = breakdown.reduce((sum, b) => sum + b.dailyCost, 0);
  const low = Math.round(recommended * 0.6);
  const high = Math.round(recommended * 1.6);

  return { recommended, low, high, breakdown };
}

export function formatBudgetSummary(estimate: BudgetEstimate): string {
  const lines = [
    `Recommended: $${(estimate.recommended / 100).toFixed(2)}/day ($${(estimate.low / 100).toFixed(2)} low / $${(estimate.high / 100).toFixed(2)} comfortable)`,
    "",
    "Per-agent breakdown:",
  ];

  for (const b of estimate.breakdown) {
    const model = b.model.split("/").pop() ?? b.model;
    lines.push(
      `  ${b.agentId} (${model}, ~${b.sessionsPerDay} sessions): $${(b.dailyCost / 100).toFixed(2)}/day`,
    );
  }

  return lines.join("\n");
}
