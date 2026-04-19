/**
 * Clawforce — Operational Profiles
 *
 * Abstracted operational levels (low/medium/high/ultra) that configure
 * all operational knobs with a single choice. Users pick a level and
 * everything works — or override individual settings for fine-tuning.
 *
 * normalizeDomainProfile is a pure config transformation — it expands
 * the profile into agent config fields and job definitions. It does NOT
 * register cron jobs. Cron registration happens downstream in the
 * adapter layer.
 */

import type { OperationalProfile, OperationalProfileConfig } from "../types.js";
import type { DomainConfig, GlobalConfig, GlobalAgentDef } from "../config/schema.js";

// --- Profile Definitions ---

const PROFILE_DEFINITIONS: Record<OperationalProfile, Omit<OperationalProfileConfig, "profile">> = {
  low: {
    coordination: {
      sessionTarget: "isolated",
      cronSchedule: "0 */2 * * *",
      adaptiveWake: false,
    },
    memory: {
      reviewSchedule: "0 18 * * SUN",
      reviewAggressiveness: "low",
      ghostRecallIntensity: "low",
      expectations: false,
    },
    meetings: {
      reflectionSchedule: "0 9 * * FRI",
    },
    models: {
      managerRecommended: "gpt-5.4-mini",
      employeeRecommended: "gpt-5.4-mini",
    },
  },

  medium: {
    coordination: {
      sessionTarget: "main",
      sessionPersistHours: 8,
      cronSchedule: "*/30 * * * *",
      adaptiveWake: true,
      wakeBounds: ["30m", "120m"],
    },
    memory: {
      reviewSchedule: "0 18 * * *",
      reviewAggressiveness: "medium",
      ghostRecallIntensity: "medium",
      expectations: true,
    },
    meetings: {
      standupSchedule: "0 9 * * MON-FRI",
      reflectionSchedule: "0 9 * * FRI",
    },
    models: {
      managerRecommended: "gpt-5.4",
      employeeRecommended: "gpt-5.4-mini",
    },
    sessionReset: {
      enabled: true,
      schedule: "0 0 * * *",
    },
  },

  high: {
    coordination: {
      sessionTarget: "main",
      sessionPersistHours: 24,
      cronSchedule: "*/15 * * * *",
      adaptiveWake: true,
      wakeBounds: ["15m", "120m"],
    },
    memory: {
      reviewSchedule: "0 12,18 * * *",
      reviewAggressiveness: "high",
      ghostRecallIntensity: "high",
      expectations: true,
    },
    meetings: {
      standupSchedule: "0 9,14 * * MON-FRI",
      reflectionSchedule: "0 9 * * WED,FRI",
    },
    models: {
      managerRecommended: "gpt-5.4",
      employeeRecommended: "gpt-5.4",
    },
    sessionReset: {
      enabled: true,
      schedule: "59 23 * * *",
    },
  },

  ultra: {
    coordination: {
      sessionTarget: "main",
      sessionPersistHours: 24,
      cronSchedule: "*/10 * * * *",
      adaptiveWake: true,
      wakeBounds: ["10m", "60m"],
    },
    memory: {
      reviewSchedule: "0 18 * * *",
      reviewAggressiveness: "high",
      ghostRecallIntensity: "high",
      expectations: true,
    },
    meetings: {
      standupSchedule: "0 9,12,16 * * MON-FRI",
      reflectionSchedule: "0 18 * * *",
    },
    models: {
      managerRecommended: "gpt-5.4",
      employeeRecommended: "gpt-5.4",
    },
    sessionReset: {
      enabled: true,
      schedule: "59 23 * * *",
    },
  },
};

/**
 * Expand a profile name to the full OperationalProfileConfig.
 * Pure function, no side effects.
 */
export function expandProfile(profile: OperationalProfile): OperationalProfileConfig {
  const def = PROFILE_DEFINITIONS[profile];
  return {
    profile,
    ...structuredClone(def),
  };
}

type AgentOverrides = {
  jobs?: Record<string, Record<string, unknown>>;
  scheduling?: Record<string, unknown>;
  memory?: Record<string, unknown>;
};

type DomainWithOverrides = DomainConfig & {
  manager_overrides?: Record<string, AgentOverrides>;
};

/**
 * Pure config transformation: if domain has operational_profile, expand it
 * into agent config overrides (jobs, scheduling, memory). Does NOT register
 * cron jobs — that happens downstream in the adapter layer.
 *
 * Respects per-agent overrides: existing jobs/settings are not overwritten.
 */
export function normalizeDomainProfile(
  domain: DomainConfig,
  global: GlobalConfig,
): DomainConfig {
  const rawDomain = domain as DomainWithOverrides;
  const profile = rawDomain.operational_profile as OperationalProfile | undefined;
  if (!profile) return domain;

  const config = expandProfile(profile);
  const result = { ...rawDomain } as DomainWithOverrides;
  const overrides = result.manager_overrides
    ? structuredClone(result.manager_overrides)
    : {} as Record<string, AgentOverrides>;

  for (const agentId of domain.agents) {
    const agentDef = global.agents[agentId] as GlobalAgentDef | undefined;
    if (!agentDef) continue;

    const isManager = agentDef.extends === "manager";
    const agentOverride: AgentOverrides = overrides[agentId] ?? {};
    if (!agentOverride.jobs) agentOverride.jobs = {};

    if (isManager) {
      applyManagerProfile(config, agentOverride);
    } else {
      applyEmployeeProfile(config, agentOverride);
    }

    overrides[agentId] = agentOverride;
  }

  result.manager_overrides = overrides;
  return result as DomainConfig;
}

function applyManagerProfile(
  config: OperationalProfileConfig,
  overrides: AgentOverrides,
): void {
  const jobs = overrides.jobs!;

  // Coordination job (only if not already specified)
  if (!jobs.coordination) {
    jobs.coordination = {
      cron: config.coordination.cronSchedule,
      sessionTarget: config.coordination.sessionTarget,
      ...(config.coordination.sessionTarget === "main" ? { wakeMode: "next-heartbeat" } : {}),
      extends: "triage",
    };
  }

  // Memory review (isolated — reads transcripts from main session)
  if (!jobs.memory_review) {
    jobs.memory_review = {
      extends: "memory_review",
      cron: config.memory.reviewSchedule,
      sessionTarget: "isolated",
    };
  }

  // Standup
  if (config.meetings.standupSchedule && !jobs.standup) {
    jobs.standup = {
      cron: config.meetings.standupSchedule,
      sessionTarget: "isolated",
    };
  }

  // Reflection
  if (!jobs.reflection) {
    jobs.reflection = {
      extends: "reflect",
      cron: config.meetings.reflectionSchedule,
    };
  }

  // Session reset (High/Ultra only — regular daily cron, not deleteAfterRun)
  if (config.sessionReset?.enabled && !jobs.session_reset) {
    jobs.session_reset = {
      cron: config.sessionReset.schedule,
      sessionTarget: "main",
      nudge: "End of day. Your session will reset. Key learnings have been extracted by the memory review job.",
    };
  }

  // Scheduling (adaptive wake)
  if (!overrides.scheduling) {
    overrides.scheduling = {};
  }
  if (overrides.scheduling.adaptiveWake === undefined) {
    overrides.scheduling.adaptiveWake = config.coordination.adaptiveWake;
  }
  if (config.coordination.wakeBounds && !overrides.scheduling.wakeBounds) {
    overrides.scheduling.wakeBounds = config.coordination.wakeBounds;
  }
}

function applyEmployeeProfile(
  config: OperationalProfileConfig,
  overrides: AgentOverrides,
): void {
  // Memory governance
  if (!overrides.memory) {
    overrides.memory = {};
  }

  if (overrides.memory.review === undefined) {
    overrides.memory.review = {
      aggressiveness: config.memory.reviewAggressiveness,
    };
  }

  // Ghost recall intensity is applied at the domain level, not per-agent
  // (it's read from the profile at runtime by the ghost-turn system)
}
