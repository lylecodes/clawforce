/**
 * Clawforce — Config Inheritance / Preset Resolution
 *
 * Walks `extends` chains, deep-merges configs, supports +/- array operators.
 */

function hasMergeOperators(arr: unknown[]): boolean {
  return arr.length > 0 && arr.every(
    (item) => typeof item === "string" && (item.startsWith("+") || item.startsWith("-")),
  );
}

export function mergeArrayWithOperators(
  parent: string[] | undefined,
  child: string[],
): string[] {
  if (!hasMergeOperators(child)) return child;

  const result = [...(parent ?? [])];
  for (const item of child) {
    if (item.startsWith("+")) {
      const value = item.slice(1);
      if (!result.includes(value)) result.push(value);
    } else if (item.startsWith("-")) {
      const value = item.slice(1);
      const idx = result.indexOf(value);
      if (idx !== -1) result.splice(idx, 1);
    }
  }
  return result;
}

function deepMerge(parent: Record<string, unknown>, child: Record<string, unknown>): Record<string, unknown> {
  const result = { ...parent };
  for (const key of Object.keys(child)) {
    const pVal = parent[key];
    const cVal = child[key];

    if (Array.isArray(cVal)) {
      // Arrays of non-string items (e.g., expectations objects) pass through
      // hasMergeOperators as false and get returned as-is (full replacement).
      result[key] = mergeArrayWithOperators(
        Array.isArray(pVal) ? (pVal as string[]) : undefined,
        cVal as string[],
      );
    } else if (
      cVal !== null &&
      typeof cVal === "object" &&
      !Array.isArray(cVal) &&
      pVal !== null &&
      typeof pVal === "object" &&
      !Array.isArray(pVal)
    ) {
      result[key] = deepMerge(
        pVal as Record<string, unknown>,
        cVal as Record<string, unknown>,
      );
    } else {
      result[key] = cVal;
    }
  }
  return result;
}

type PresetLookup = (name: string) => Record<string, unknown> | undefined;

export function detectCycle(
  startName: string,
  lookup: PresetLookup,
): string | null {
  const visited: string[] = [];
  let current: string | undefined = startName;
  while (current) {
    if (visited.includes(current)) {
      return [...visited, current].join(" → ");
    }
    visited.push(current);
    const preset = lookup(current);
    current = preset?.extends as string | undefined;
  }
  return null;
}

export function resolveConfig<T extends Record<string, unknown>>(
  config: T & { extends?: string },
  presets: Record<string, Record<string, unknown>>,
): T {
  if (!config.extends) {
    return { ...config };
  }

  const lookup: PresetLookup = (name) => presets[name];

  const cycle = detectCycle(config.extends, lookup);
  if (cycle) {
    throw new Error(`Circular extends chain detected: ${cycle}`);
  }

  const chain: Record<string, unknown>[] = [];
  let current: string | undefined = config.extends;
  while (current) {
    const preset = presets[current];
    if (!preset) {
      throw new Error(`Preset "${current}" not found`);
    }
    chain.unshift(preset);
    current = preset.extends as string | undefined;
  }

  let resolved: Record<string, unknown> = {};
  for (const layer of chain) {
    const { extends: _, ...rest } = layer;
    resolved = deepMerge(resolved, rest);
  }

  const { extends: __, ...childRest } = config;
  resolved = deepMerge(resolved, childRest);

  return resolved as T;
}

/* ── Builtin Agent Presets ── */

export const BUILTIN_AGENT_PRESETS: Record<string, Record<string, unknown>> = {
  manager: {
    title: "Manager",
    persona: "You are a manager agent responsible for coordinating your team, delegating tasks, and reviewing results.",
    briefing: [
      "soul", "tools_reference", "project_md", "task_board", "goal_hierarchy",
      "escalations", "team_status", "trust_scores", "cost_summary", "resources",
      "pending_messages", "channel_messages", "memory_instructions", "skill",
      "policy_status", "preferences", "cost_forecast", "available_capacity",
      "knowledge_candidates", "budget_guidance",
      "onboarding_welcome", "weekly_digest", "intervention_suggestions",
    ],
    expectations: [
      { tool: "clawforce_log", action: "write", min_calls: 1 },
      { tool: "clawforce_compact", action: "update_doc", min_calls: 1 },
      { tool: "memory_search", action: "search", min_calls: 1 },
    ],
    performance_policy: { action: "alert" },
    compaction: true,
    coordination: { enabled: true, schedule: "*/30 * * * *" },
    scheduling: { adaptiveWake: true, planning: true, wakeBounds: ["*/15 * * * *", "*/120 * * * *"], maxTurnsPerCycle: 50 },
    skillCap: 12,
  },
  employee: {
    title: "Employee",
    persona: "You are an employee agent responsible for executing assigned tasks and reporting results.",
    briefing: [
      "soul", "tools_reference", "assigned_task", "pending_messages",
      "channel_messages", "memory_instructions", "skill",
    ],
    expectations: [
      { tool: "clawforce_task", action: "transition", min_calls: 1 },
      { tool: "clawforce_log", action: "write", min_calls: 1 },
    ],
    performance_policy: { action: "retry", max_retries: 3, then: "alert" },
    compaction: false,
    coordination: { enabled: false },
    skillCap: 8,
  },
  assistant: {
    title: "Personal Assistant",
    persona: "You are a personal assistant agent focused on communication, memory management, and helping users.",
    briefing: [
      "soul", "tools_reference", "pending_messages", "channel_messages",
      "memory_instructions", "skill", "preferences",
    ],
    expectations: [],
    performance_policy: { action: "alert" },
    compaction: true,
    coordination: { enabled: false },
  },
  "dashboard-assistant": {
    extends: "assistant",
    title: "Clawforce Dashboard Assistant",
    persona: "You help the user manage their AI workforce through the Clawforce dashboard. You have access to all operational tools and can search audit logs, adjust budgets, reassign tasks, and manage agents. Always explain what you're doing before taking actions. Be concise and actionable.",
    briefing: [
      "soul", "tools_reference", "task_board", "cost_summary",
      "escalations", "pending_messages", "memory_instructions", "skill",
    ],
    expectations: [],
    performance_policy: { action: "alert" },
    coordination: { enabled: false },
    skillCap: 10,
  },
  /** @deprecated Use employee instead. */
  scheduled: {
    extends: "employee",
  },
};

/* ── Builtin Job Presets ── */

export const BUILTIN_JOB_PRESETS: Record<string, Record<string, unknown>> = {
  reflect: {
    cron: "0 9 * * MON",
    briefing: ["team_performance", "cost_summary", "velocity", "trust_scores"],
    nudge: "Review team performance. Consider: budget rebalancing, agent hiring/splitting, skill gaps, initiative reprioritization.",
    performance_policy: { action: "alert" },
  },
  triage: {
    cron: "*/30 * * * *",
    briefing: ["task_board", "escalations", "pending_messages"],
    nudge: "Check on your team. Reassign stuck tasks, handle escalations.",
    performance_policy: { action: "alert" },
  },
  memory_review: {
    cron: "0 18 * * *",
    model: "anthropic/claude-sonnet-4-6",
    sessionTarget: "isolated",
    briefing: ["memory_review_context"],
    expectations: [
      { tool: "memory_search", action: "search", min_calls: 1 },
    ],
    nudge: "Review today's session transcripts. Extract key learnings, decisions, patterns, and reusable knowledge. Search existing memory to avoid duplicates. Write valuable findings to memory using memory tools.",
    performance_policy: { action: "alert" },
  },
};
