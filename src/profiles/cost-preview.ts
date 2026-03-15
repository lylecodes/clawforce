/**
 * Clawforce — Cost Preview Engine
 *
 * Estimates daily operational cost for each profile level using a
 * three-bucket breakdown: Management, Execution, Intelligence.
 *
 * Uses MODEL_COSTS from budget-guide.ts (per-session costs).
 * For persistent sessions (High/Ultra), coordination wakes cost ~20%
 * of a fresh session via CYCLE_COST_MULTIPLIER.
 */

import type {
  OperationalProfile,
  CostBucket,
  CostLineItem,
  ProfileCostEstimate,
  ProfileRecommendation,
} from "../types.js";
import { OPERATIONAL_PROFILES } from "../types.js";
import { MODEL_COSTS } from "../config/budget-guide.js";
import { expandProfile } from "./operational.js";

export type CostAgentInput = {
  agentId: string;
  role: "manager" | "employee";
};

/**
 * For isolated sessions each coordination cycle is a fresh session (1.0x).
 * For persistent sessions each wake is a continuation (~20% of fresh cost).
 */
const CYCLE_COST_MULTIPLIER: Record<"isolated" | "main", number> = {
  isolated: 1.0,
  main: 0.2,
};

/** Default employee sessions per day for cost estimation. */
const DEFAULT_EMPLOYEE_SESSIONS_PER_DAY = 4;

/** Ghost recall triage cost in cents per turn (Haiku-level). */
const GHOST_RECALL_COST_PER_TURN = 2;

/** Average turns per day for ghost recall. */
const GHOST_RECALL_TURNS_PER_DAY: Record<OperationalProfile, number> = {
  low: 4,
  medium: 8,
  high: 12,
  ultra: 16,
};

/** Memory review cost per review in cents (Sonnet-level review session). */
const MEMORY_REVIEW_COST_CENTS = 15;

function getModelCost(model: string): number {
  return MODEL_COSTS[model] ?? MODEL_COSTS["anthropic/claude-sonnet-4-6"]!;
}

function countCyclesPerDay(cronSchedule: string): number {
  // Parse common cron patterns like "*/30 * * * *" (every 30m) or "0 */2 * * *" (every 2h)
  const parts = cronSchedule.split(/\s+/);
  if (parts.length < 5) return 6; // fallback

  const minute = parts[0]!;
  const hour = parts[1]!;

  // "*/N * * * *" — every N minutes
  const everyNMinMatch = minute.match(/^\*\/(\d+)$/);
  if (everyNMinMatch && hour === "*") {
    const intervalMin = parseInt(everyNMinMatch[1]!, 10);
    return Math.floor(24 * 60 / intervalMin);
  }

  // "0 */N * * *" — every N hours
  const everyNHourMatch = hour.match(/^\*\/(\d+)$/);
  if (everyNHourMatch) {
    const intervalHr = parseInt(everyNHourMatch[1]!, 10);
    return Math.floor(24 / intervalHr);
  }

  // "0 9 * * MON-FRI" or similar — once or twice per day
  if (minute.includes(",")) return minute.split(",").length;
  if (hour.includes(",")) return hour.split(",").length;

  return 6; // fallback
}

function countReviewsPerDay(reviewSchedule: string): number {
  const parts = reviewSchedule.split(/\s+/);
  if (parts.length < 5) return 1;

  const minute = parts[0]!;
  const hour = parts[1]!;

  if (hour.includes(",")) return hour.split(",").length;
  if (minute.includes(",")) return minute.split(",").length;

  // Weekly schedules (day-of-week restricted)
  const dow = parts[4]!;
  if (dow !== "*" && !dow.includes(",")) {
    // Single day of week = ~1/7 per day
    return 1 / 7;
  }

  return 1;
}

function countStandupsPerDay(standupSchedule?: string): number {
  if (!standupSchedule) return 0;
  const parts = standupSchedule.split(/\s+/);
  if (parts.length < 5) return 0;
  const hour = parts[1]!;
  const count = hour.includes(",") ? hour.split(",").length : 1;
  // Only weekdays → multiply by 5/7
  return count * (5 / 7);
}

/**
 * Estimate daily operational cost for a profile + agent composition.
 * Returns a three-bucket cost breakdown.
 *
 * @param profile The operational profile level
 * @param agents Agent composition (id + role)
 * @param budgetCents Optional daily budget in cents for fitsInBudget calculation
 */
export function estimateProfileCost(
  profile: OperationalProfile,
  agents: CostAgentInput[],
  budgetCents?: number,
): ProfileCostEstimate {
  const config = expandProfile(profile);
  const managerModel = config.models.managerRecommended;
  const employeeModel = config.models.employeeRecommended;
  const managerCost = getModelCost(managerModel);
  const employeeCost = getModelCost(employeeModel);

  const managers = agents.filter((a) => a.role === "manager");
  const employees = agents.filter((a) => a.role === "employee");

  // --- Management Bucket ---
  const managementItems: CostLineItem[] = [];

  // Manager coordination cycles
  const cyclesPerDay = countCyclesPerDay(config.coordination.cronSchedule);
  const cycleMult = CYCLE_COST_MULTIPLIER[config.coordination.sessionTarget];
  for (const mgr of managers) {
    const costPerCycle = managerCost * cycleMult;
    const totalCost = Math.round(costPerCycle * cyclesPerDay);
    const modelShort = managerModel.split("/").pop() ?? managerModel;
    managementItems.push({
      label: `${mgr.agentId} coordination (${modelShort} x ${cyclesPerDay} cycles)`,
      cents: totalCost,
    });
  }

  // Standups
  const standupsPerDay = countStandupsPerDay(config.meetings.standupSchedule);
  if (standupsPerDay > 0) {
    const participants = agents.length;
    // Each standup turn is a dispatch at employee cost
    const standupCost = Math.round(standupsPerDay * participants * employeeCost * 0.5);
    managementItems.push({
      label: `Standups (${participants} participants)`,
      cents: standupCost,
    });
  }

  // Reflection
  const reflectionFreq = countReviewsPerDay(config.meetings.reflectionSchedule);
  if (reflectionFreq > 0) {
    const reflectionCost = Math.round(managerCost * reflectionFreq);
    managementItems.push({
      label: `Reflection sessions`,
      cents: reflectionCost,
    });
  }

  // --- Execution Bucket ---
  const executionItems: CostLineItem[] = [];

  for (const emp of employees) {
    const dailyCost = DEFAULT_EMPLOYEE_SESSIONS_PER_DAY * employeeCost;
    const modelShort = employeeModel.split("/").pop() ?? employeeModel;
    executionItems.push({
      label: `${emp.agentId} sessions (${modelShort} x ${DEFAULT_EMPLOYEE_SESSIONS_PER_DAY}/day)`,
      cents: dailyCost,
    });
  }

  // --- Intelligence Bucket ---
  const intelligenceItems: CostLineItem[] = [];

  // Memory review
  const reviewsPerDay = countReviewsPerDay(config.memory.reviewSchedule);
  const memoryReviewCost = Math.round(MEMORY_REVIEW_COST_CENTS * reviewsPerDay * managers.length);
  if (memoryReviewCost > 0) {
    intelligenceItems.push({
      label: `Memory review (${reviewsPerDay.toFixed(1)}/day)`,
      cents: memoryReviewCost,
    });
  }

  // Ghost recall
  const ghostTurns = GHOST_RECALL_TURNS_PER_DAY[profile];
  const ghostCost = ghostTurns * GHOST_RECALL_COST_PER_TURN * agents.length;
  intelligenceItems.push({
    label: `Ghost recall triage (${ghostTurns} turns/day)`,
    cents: ghostCost,
  });

  // Build buckets
  const buckets: CostBucket[] = [
    {
      name: "Management",
      totalCents: managementItems.reduce((sum, i) => sum + i.cents, 0),
      items: managementItems,
    },
    {
      name: "Execution",
      totalCents: executionItems.reduce((sum, i) => sum + i.cents, 0),
      items: executionItems,
    },
    {
      name: "Intelligence",
      totalCents: intelligenceItems.reduce((sum, i) => sum + i.cents, 0),
      items: intelligenceItems,
    },
  ];

  const dailyCents = buckets.reduce((sum, b) => sum + b.totalCents, 0);
  const monthlyCents = dailyCents * 30;

  const fitsInBudget = budgetCents ? dailyCents <= budgetCents : true;
  const headroomCents = budgetCents ? budgetCents - dailyCents : 0;
  const headroomPercent = budgetCents && budgetCents > 0
    ? Math.round((headroomCents / budgetCents) * 100)
    : 0;

  return {
    profile,
    dailyCents,
    monthlyCents,
    buckets,
    fitsInBudget,
    headroomCents,
    headroomPercent,
  };
}

/**
 * Recommend the best operational profile for a team and budget.
 *
 * Logic:
 * 1. Estimate cost for each profile level
 * 2. Filter to profiles that fit within budget (with at least 30% headroom)
 * 3. Pick the highest profile that fits
 * 4. If none fit: recommend Low with a warning
 */
export function recommendProfile(
  teamSize: number,
  budgetCents: number,
  agentRoles?: CostAgentInput[],
): ProfileRecommendation {
  // Build default agent composition if not provided
  const agents: CostAgentInput[] = agentRoles ?? buildDefaultAgentComposition(teamSize);

  const allProfiles = OPERATIONAL_PROFILES.map((profile) => {
    const estimate = estimateProfileCost(profile, agents, budgetCents);
    return {
      profile,
      estimatedCents: estimate.dailyCents,
      fitsInBudget: estimate.fitsInBudget,
      headroomPercent: estimate.headroomPercent,
    };
  });

  // Find highest profile with at least 30% headroom
  const HEADROOM_THRESHOLD = 30;
  const fitting = allProfiles.filter(
    (p) => p.fitsInBudget && p.headroomPercent >= HEADROOM_THRESHOLD,
  );

  if (fitting.length === 0) {
    // Check if low at least fits at all
    const lowProfile = allProfiles[0]!;
    const reason = lowProfile.fitsInBudget
      ? `Budget is tight — Low profile fits but with only ${lowProfile.headroomPercent}% headroom. Consider increasing budget.`
      : `Budget is tight — even Low profile exceeds $${(budgetCents / 100).toFixed(2)}/day. Consider increasing budget.`;

    return {
      recommended: "low",
      reason,
      allProfiles,
    };
  }

  const recommended = fitting[fitting.length - 1]!;
  const nextUp = allProfiles.find(
    (p) => OPERATIONAL_PROFILES.indexOf(p.profile) === OPERATIONAL_PROFILES.indexOf(recommended.profile) + 1,
  );

  let reason = `Fits your $${(budgetCents / 100).toFixed(2)}/day budget with ${recommended.headroomPercent}% headroom for tasks.`;
  if (nextUp) {
    reason += ` ${nextUp.profile.charAt(0).toUpperCase() + nextUp.profile.slice(1)} would cost ~$${(nextUp.estimatedCents / 100).toFixed(2)}/day (${nextUp.headroomPercent}% headroom).`;
  }

  return {
    recommended: recommended.profile,
    reason,
    allProfiles,
  };
}

function buildDefaultAgentComposition(teamSize: number): CostAgentInput[] {
  const agents: CostAgentInput[] = [];
  // First agent is always a manager
  agents.push({ agentId: "manager", role: "manager" });
  for (let i = 1; i < teamSize; i++) {
    agents.push({ agentId: `employee-${i}`, role: "employee" });
  }
  return agents;
}
