/**
 * Clawforce — Built-in preset profiles
 *
 * Each agent preset has a default profile that provides sensible defaults
 * for briefing, expectations, and performance_policy. Agents inherit from
 * their preset's profile and only need to specify what's different.
 */

import type { ActionConstraint, ActionConstraints, ActionScope, ContextSource, Expectation, PerformancePolicy } from "./types.js";
import { BUILTIN_AGENT_PRESETS } from "./presets.js";

/**
 * Default allowed tools and actions per role. Used to auto-generate action_scope
 * policies and to filter tool registration/schemas at startup.
 *
 * `"*"` = all actions allowed for that tool.
 * `string[]` = only listed actions are visible and permitted.
 * Tool absent from a role's scope = hidden from that role entirely.
 */
export const DEFAULT_ACTION_SCOPES: Record<string, ActionScope> = {
  manager: {
    clawforce_task: "*",
    clawforce_log: "*",
    clawforce_verify: "*",
    clawforce_compact: "*",
    clawforce_workflow: "*",
    clawforce_ops: "*",
    clawforce_setup: "*",
    clawforce_context: "*",
    clawforce_message: "*",
    clawforce_goal: "*",
    clawforce_channel: "*",
    memory_search: "*",
    memory_get: "*",
  },
  employee: {
    memory_search: "*",
    memory_get: "*",
  },
  verifier: {
    clawforce_task: ["get"],
    clawforce_verify: ["verdict"],
    clawforce_log: ["write"],
    memory_search: "*",
    memory_get: "*",
  },
  assistant: {
    clawforce_log: ["write", "outcome", "search", "list"],
    clawforce_setup: ["explain", "status"],
    clawforce_context: "*",
    clawforce_message: [
      "send", "list", "read", "reply",
      "request", "delegate", "request_feedback",
      "respond", "accept", "reject", "complete", "submit_review",
      "list_protocols",
    ],
    clawforce_channel: ["send", "list", "history", "meeting_status", "join", "leave"],
    memory_search: "*",
    memory_get: "*",
  },
};

/** Extract the list of tool names from an ActionScope. */
export function getToolNamesFromScope(scope: ActionScope): string[] {
  return Object.keys(scope);
}

/** Get allowed actions for a tool from an ActionScope. Returns `null` if tool is not in scope. */
export function getAllowedActionsForTool(scope: ActionScope, toolName: string): string[] | "*" | null {
  if (!(toolName in scope)) return null;
  const entry = scope[toolName]!;
  // ActionConstraint shape: extract .actions
  if (typeof entry === "object" && !Array.isArray(entry) && "actions" in entry) {
    return (entry as ActionConstraint).actions;
  }
  return entry as string[] | "*";
}

/** Get constraints for a tool from an ActionScope. Returns `undefined` if no constraints. */
export function getConstraintsForTool(scope: ActionScope, toolName: string): ActionConstraints | undefined {
  if (!(toolName in scope)) return undefined;
  const entry = scope[toolName]!;
  if (typeof entry === "object" && !Array.isArray(entry) && "actions" in entry) {
    return (entry as ActionConstraint).constraints;
  }
  return undefined;
}

/**
 * Generate default action_scope policies from agent roles.
 * Skips agents that already have an explicit action_scope policy targeting them.
 */
export function generateDefaultScopePolicies(
  agents: Record<string, { extends?: string }>,
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

    const scope = DEFAULT_ACTION_SCOPES[agentConfig.extends ?? "employee"];
    if (scope) {
      result.push({
        name: `default-scope:${agentId}`,
        type: "action_scope",
        target: agentId,
        config: { allowed_tools: { ...scope } },
      });
    }
  }

  return result;
}

/**
 * Merge a preset's profile defaults with agent-level overrides.
 *
 * - briefing: profile baseline (minus excludes) + agent additions (deduped)
 * - expectations: agent replaces if non-empty, otherwise inherits profile
 * - performance_policy: agent replaces if provided, otherwise inherits profile
 */
export function applyProfile(
  extendsFrom: string,
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
  const preset = BUILTIN_AGENT_PRESETS[extendsFrom];
  if (!preset) {
    // Unknown preset — return agent config as-is with empty defaults
    return {
      briefing: agent.briefing,
      expectations: agent.expectations ?? [],
      performance_policy: agent.performance_policy ?? { action: "alert" },
    };
  }

  // Convert preset's string[] briefing to ContextSource[]
  const presetBriefing: ContextSource[] = (preset.briefing as string[]).map(
    (s) => ({ source: s } as ContextSource),
  );
  const presetExpectations = (preset.expectations ?? []) as Expectation[];
  const presetPolicy = (preset.performance_policy ?? { action: "alert" }) as PerformancePolicy;

  // --- briefing: baseline + agent additions, deduped ---
  const excludeSet = new Set(agent.exclude_briefing);

  // Filter baseline: remove excluded sources
  const baseline = presetBriefing.filter(
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
    : presetExpectations;

  // --- performance_policy: replace if specified, inherit if not ---
  const mergedPolicy = agent.performance_policy ?? presetPolicy;

  return {
    briefing: mergedBriefing,
    expectations: mergedExpectations,
    performance_policy: mergedPolicy,
  };
}
