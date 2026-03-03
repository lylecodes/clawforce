/**
 * Clawforce — Built-in role profiles
 *
 * Each agent role has a default profile that provides sensible defaults
 * for briefing, expectations, and performance_policy. Agents inherit from
 * their role's profile and only need to specify what's different.
 */

import type { AgentRole, ContextSource, Expectation, PerformancePolicy } from "./types.js";

/** A profile defines the full default template for an agent role. */
export type RoleProfile = {
  briefing: ContextSource[];
  expectations: Expectation[];
  performance_policy: PerformancePolicy;
  /** Default compaction setting for this role. */
  compaction: boolean;
};

/** @deprecated Use RoleProfile instead. */
export type Paradigm = RoleProfile;

/**
 * Built-in profile defaults for each role.
 * The "instructions" source is NOT listed here — it is always
 * auto-injected by normalizeAgentConfig regardless of profile.
 */
export const BUILTIN_PROFILES: Record<AgentRole, RoleProfile> = {
  manager: {
    briefing: [
      { source: "project_md" },
      { source: "task_board" },
      { source: "escalations" },
      { source: "workflows" },
      { source: "activity" },
      { source: "sweep_status" },
      { source: "proposals" },
      { source: "agent_status" },
      { source: "knowledge", filter: { category: ["decision"] } },
      { source: "memory" },
      { source: "cost_summary" },
      { source: "policy_status" },
      { source: "health_status" },
      { source: "team_status" },
    ],
    expectations: [
      { tool: "clawforce_log", action: "write", min_calls: 1 },
      { tool: "clawforce_compact", action: "update_doc", min_calls: 1 },
    ],
    performance_policy: { action: "alert" },
    compaction: true,
  },

  employee: {
    briefing: [
      { source: "assigned_task" },
      { source: "memory" },
    ],
    expectations: [
      { tool: "clawforce_task", action: ["transition", "fail"], min_calls: 1 },
      { tool: "clawforce_log", action: "write", min_calls: 1 },
      { tool: "clawforce_memory", action: "save", min_calls: 1 },
    ],
    performance_policy: { action: "retry", max_retries: 3, then: "alert" },
    compaction: false,
  },

  scheduled: {
    briefing: [
      { source: "memory" },
    ],
    expectations: [
      { tool: "clawforce_log", action: "outcome", min_calls: 1 },
      { tool: "clawforce_memory", action: "save", min_calls: 1 },
    ],
    performance_policy: { action: "retry", max_retries: 3, then: "terminate_and_alert" },
    compaction: false,
  },
};

/** @deprecated Use BUILTIN_PROFILES instead. */
export const BUILTIN_PARADIGMS = BUILTIN_PROFILES;

/**
 * Default titles and personas per role.
 * Applied when the agent config doesn't specify its own.
 */
export const ROLE_DEFAULTS: Record<AgentRole, { title: string; persona: string }> = {
  manager: {
    title: "Manager",
    persona: "You are a manager responsible for coordinating your team, reviewing work, and making decisions.",
  },
  employee: {
    title: "Employee",
    persona: "You are an employee responsible for completing assigned tasks thoroughly and reporting results.",
  },
  scheduled: {
    title: "Scheduled Worker",
    persona: "You are a scheduled worker responsible for completing your assigned job and reporting the outcome.",
  },
};

/**
 * Sources considered critical for a role.
 * Excluding these produces a validation warning.
 */
export const CRITICAL_SOURCES: Partial<Record<AgentRole, string[]>> = {
  manager: ["task_board"],
  employee: ["assigned_task"],
};

/**
 * Default allowed tools per role. Used to auto-generate action_scope
 * policies when none are explicitly configured.
 */
export const DEFAULT_ACTION_SCOPES: Record<AgentRole, string[]> = {
  manager: [
    "clawforce_task", "clawforce_log", "clawforce_verify", "clawforce_compact",
    "clawforce_workflow", "clawforce_ops", "clawforce_setup", "clawforce_memory",
  ],
  employee: [
    "clawforce_task", "clawforce_log", "clawforce_verify", "clawforce_compact",
    "clawforce_memory",
  ],
  scheduled: [
    "clawforce_log", "clawforce_memory",
  ],
};

/**
 * Generate default action_scope policies from agent roles.
 * Skips agents that already have an explicit action_scope policy targeting them.
 */
export function generateDefaultScopePolicies(
  agents: Record<string, { role: AgentRole }>,
  existingPolicies?: Array<{ type: string; target?: string }>,
): Array<{ name: string; type: string; target: string; config: Record<string, unknown> }> {
  const result: Array<{ name: string; type: string; target: string; config: Record<string, unknown> }> = [];

  // Build set of agents that already have an explicit action_scope policy
  const coveredAgents = new Set<string>();
  if (existingPolicies) {
    for (const p of existingPolicies) {
      if (p.type === "action_scope" && p.target) {
        coveredAgents.add(p.target);
      }
    }
  }

  for (const [agentId, agentConfig] of Object.entries(agents)) {
    if (coveredAgents.has(agentId)) continue;

    const allowedTools = DEFAULT_ACTION_SCOPES[agentConfig.role];
    if (allowedTools) {
      result.push({
        name: `default-scope:${agentId}`,
        type: "action_scope",
        target: agentId,
        config: { allowed_tools: [...allowedTools] },
      });
    }
  }

  return result;
}

/**
 * Merge a role's profile defaults with agent-level overrides.
 *
 * - briefing: profile baseline (minus excludes) + agent additions (deduped)
 * - expectations: agent replaces if non-empty, otherwise inherits profile
 * - performance_policy: agent replaces if provided, otherwise inherits profile
 */
export function applyProfile(
  role: AgentRole,
  agent: {
    briefing: ContextSource[];
    exclude_briefing: string[];
    expectations: Expectation[] | null;
    performance_policy: PerformancePolicy | null;
  },
): {
  briefing: ContextSource[];
  expectations: Expectation[];
  performance_policy: PerformancePolicy;
} {
  const profile = BUILTIN_PROFILES[role];

  // --- briefing: baseline + agent additions, deduped ---
  const excludeSet = new Set(agent.exclude_briefing);

  // Filter baseline: remove excluded sources
  const baseline = profile.briefing.filter(
    (s) => !excludeSet.has(s.source),
  );

  // Source keys already present in agent config
  const agentSourceKeys = new Set(agent.briefing.map((s) => s.source));

  // Baseline sources the agent didn't already explicitly specify
  const newFromBaseline = baseline.filter(
    (s) => !agentSourceKeys.has(s.source),
  );

  const mergedBriefing = [...newFromBaseline, ...agent.briefing];

  // --- expectations: replace if specified (even if empty), inherit if null ---
  const mergedExpectations = agent.expectations !== null
    ? agent.expectations
    : profile.expectations;

  // --- performance_policy: replace if specified, inherit if not ---
  const mergedPolicy = agent.performance_policy ?? profile.performance_policy;

  return {
    briefing: mergedBriefing,
    expectations: mergedExpectations,
    performance_policy: mergedPolicy,
  };
}

/** @deprecated Use applyProfile instead. */
export const applyParadigm = applyProfile;
