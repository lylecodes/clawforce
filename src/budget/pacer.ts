/**
 * Clawforce — Budget Pacer
 *
 * Computes budget pacing decisions for event-driven dispatch.
 * Given current budget state, returns hourly spend rate, reserve amounts,
 * and dispatch permissions for leads and workers.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BudgetPacingInput = {
  /** Total daily budget in cents. */
  dailyBudgetCents: number;
  /** Amount already spent today in cents. */
  spentCents: number;
  /** Hours remaining in the budget day. */
  hoursRemaining: number;
  /** Amount spent in the current hour, in cents. */
  currentHourSpentCents?: number;
  /** Percentage of remaining budget reserved for reactive work (default: 20). */
  reactiveReservePct?: number;
  /** Percentage of daily budget remaining that triggers low-budget mode (default: 10). */
  lowBudgetThreshold?: number;
  /** Percentage of daily budget remaining that triggers critical mode (default: 5). */
  criticalThreshold?: number;
  /** Estimated cost of a lead session in cents (default: 1500 = $15). */
  leadSessionCostCents?: number;
  /** Estimated cost of a worker session in cents (default: 30 = $0.30). */
  workerSessionCostCents?: number;
};

export type DispatchBudget = {
  /** Cents per hour we can spend on proactive work. */
  hourlyRate: number;
  /** Cents held back for reactive sessions. */
  reactiveReserve: number;
  /** Whether a lead session can be dispatched. */
  canDispatchLead: boolean;
  /** Whether a worker session can be dispatched. */
  canDispatchWorker: boolean;
  /** Milliseconds to wait before next dispatch (0 = go now). */
  paceDelay: number;
  /** Human-readable recommendation for briefings. */
  recommendation: string;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function computeBudgetPacing(input: BudgetPacingInput): DispatchBudget {
  const {
    dailyBudgetCents,
    spentCents,
    hoursRemaining,
    currentHourSpentCents = 0,
    reactiveReservePct = 20,
    lowBudgetThreshold = 10,
    criticalThreshold = 5,
    leadSessionCostCents = 1500,
    workerSessionCostCents = 30,
  } = input;

  // Core calculations
  const remaining = Math.max(0, dailyBudgetCents - spentCents);
  const reserve = Math.round(remaining * (reactiveReservePct / 100));
  const allocatable = remaining - reserve;
  const hourlyRate =
    hoursRemaining > 0 ? Math.round(allocatable / hoursRemaining) : 0;

  // Budget percentage remaining
  const pctRemaining =
    dailyBudgetCents > 0 ? (remaining / dailyBudgetCents) * 100 : 0;

  // --- Exhausted: nothing left or no time left ---
  if (remaining <= 0 || dailyBudgetCents <= 0) {
    return {
      hourlyRate: 0,
      reactiveReserve: 0,
      canDispatchLead: false,
      canDispatchWorker: false,
      paceDelay: 0,
      recommendation: "Budget exhausted — all dispatch blocked.",
    };
  }

  if (hoursRemaining <= 0) {
    return {
      hourlyRate: 0,
      reactiveReserve: reserve,
      canDispatchLead: false,
      canDispatchWorker: false,
      paceDelay: 0,
      recommendation: "No hours remaining — all dispatch blocked.",
    };
  }

  // --- Critical threshold: block everything ---
  if (pctRemaining <= criticalThreshold) {
    return {
      hourlyRate,
      reactiveReserve: reserve,
      canDispatchLead: false,
      canDispatchWorker: false,
      paceDelay: 0,
      recommendation: `Budget critical (${pctRemaining.toFixed(1)}% remaining) — all dispatch blocked.`,
    };
  }

  // --- Low budget threshold: leads only (reactive reviews always allowed) ---
  if (pctRemaining <= lowBudgetThreshold) {
    return {
      hourlyRate,
      reactiveReserve: reserve,
      canDispatchLead: true,
      canDispatchWorker: false,
      paceDelay: 0,
      recommendation: `Budget low (${pctRemaining.toFixed(1)}% remaining) — workers blocked, leads allowed for reactive reviews.`,
    };
  }

  // --- Normal pacing ---
  let canDispatchLead = allocatable >= leadSessionCostCents;
  let canDispatchWorker = allocatable >= workerSessionCostCents;

  // Pace delay: throttle if current hour spend exceeds hourly rate
  let paceDelay = 0;
  let recommendation: string;

  if (currentHourSpentCents > hourlyRate && hourlyRate > 0) {
    // Delay proportional to how far over pace we are
    const overageRatio = currentHourSpentCents / hourlyRate;
    // Scale delay: at 1.5x overage -> 30 min, at 2x -> 60 min, etc.
    paceDelay = Math.round((overageRatio - 1) * 60 * 60 * 1000);
    // Cap at 1 hour
    paceDelay = Math.min(paceDelay, 3_600_000);

    recommendation = `Pacing: throttled (${currentHourSpentCents}c spent this hour vs ${hourlyRate}c/hr target). Delay ${Math.round(paceDelay / 1000)}s.`;
  } else {
    recommendation = `Normal pacing — ${pctRemaining.toFixed(1)}% budget remaining, ${hourlyRate}c/hr allocatable.`;
  }

  return {
    hourlyRate,
    reactiveReserve: reserve,
    canDispatchLead,
    canDispatchWorker,
    paceDelay,
    recommendation,
  };
}
