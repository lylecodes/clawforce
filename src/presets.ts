/**
 * Clawforce — Config Inheritance / Preset Resolution
 *
 * Walks `extends` chains, deep-merges configs, supports +/-/~ array operators.
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

/**
 * Briefing composition operators for ContextSource arrays.
 *
 * Briefing items can be strings or ContextSource objects. Operators are
 * detected on string items with prefix characters:
 *   +source  — add source to the preset base
 *   -source  — remove source from the preset base
 *   ~source  — override: replace matching source in preset base with this item's params
 *
 * When an item uses `~`, it is returned as a ContextSource with the original
 * source name plus any params from the override item (parsed from "~source:key=val" or object form).
 *
 * If NO items use operators, the child array replaces the parent (standard behavior).
 */
export type BriefingItem = string | { source: string; [key: string]: unknown };

function hasBriefingOperators(arr: BriefingItem[]): boolean {
  return arr.length > 0 && arr.every((item) => {
    if (typeof item === "string") {
      return item.startsWith("+") || item.startsWith("-") || item.startsWith("~");
    }
    // Object items with an operator prefix on their source field
    if (typeof item === "object" && item !== null && typeof item.source === "string") {
      return item.source.startsWith("+") || item.source.startsWith("-") || item.source.startsWith("~");
    }
    return false;
  });
}

export function mergeBriefingWithOperators(
  parent: BriefingItem[] | undefined,
  child: BriefingItem[],
): BriefingItem[] {
  if (!hasBriefingOperators(child)) return child;

  // Preserve parent items in their original format (string or object)
  const result = [...(parent ?? [])];

  for (const rawItem of child) {
    const { op, sourceName, item } = parseBriefingOp(rawItem);

    switch (op) {
      case "+": {
        // Add if not already present
        const exists = result.some((r) => getSourceName(r) === sourceName);
        if (!exists) result.push(item);
        break;
      }
      case "-": {
        // Remove matching source
        const idx = result.findIndex((r) => getSourceName(r) === sourceName);
        if (idx !== -1) result.splice(idx, 1);
        break;
      }
      case "~": {
        // Override: replace matching source with item (preserving extra params from override)
        const idx = result.findIndex((r) => getSourceName(r) === sourceName);
        if (idx !== -1) {
          result[idx] = item;
        } else {
          // If source not found in parent, add it
          result.push(item);
        }
        break;
      }
    }
  }

  return result;
}

function normalizeBriefingItem(item: BriefingItem): BriefingItem {
  if (typeof item === "string") return { source: item };
  return item;
}

function getSourceName(item: BriefingItem): string {
  if (typeof item === "string") return item;
  return item.source;
}

function parseBriefingOp(rawItem: BriefingItem): { op: "+" | "-" | "~"; sourceName: string; item: BriefingItem } {
  if (typeof rawItem === "string") {
    const op = rawItem[0] as "+" | "-" | "~";
    const sourceName = rawItem.slice(1);
    // For string-only items (+ and -), keep them as strings in the result
    return { op, sourceName, item: sourceName };
  }
  // Object form: { source: "+task_board", params: { ... } }
  const source = rawItem.source;
  const op = source[0] as "+" | "-" | "~";
  const sourceName = source.slice(1);
  return { op, sourceName, item: { ...rawItem, source: sourceName } };
}

export function deepMerge(parent: Record<string, unknown>, child: Record<string, unknown>): Record<string, unknown> {
  const result = { ...parent };
  for (const key of Object.keys(child)) {
    const pVal = parent[key];
    const cVal = child[key];

    if (Array.isArray(cVal)) {
      if (key === "briefing") {
        // Briefing arrays support +/-/~ composition operators on ContextSource items
        result[key] = mergeBriefingWithOperators(
          Array.isArray(pVal) ? (pVal as BriefingItem[]) : undefined,
          cVal as BriefingItem[],
        );
      } else {
        // Other arrays: +/- operators for string arrays, full replacement otherwise.
        // Arrays of non-string items (e.g., expectations objects) pass through
        // hasMergeOperators as false and get returned as-is (full replacement).
        result[key] = mergeArrayWithOperators(
          Array.isArray(pVal) ? (pVal as string[]) : undefined,
          cVal as string[],
        );
      }
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

/**
 * Merge a config layer (e.g. role defaults, team template) onto a base config.
 * Uses the same deep merge logic as preset resolution, including briefing
 * composition operators and +/- array operators.
 */
export function mergeConfigLayer<T extends Record<string, unknown>>(
  base: T,
  layer: Record<string, unknown>,
): T {
  return deepMerge(base, layer) as T;
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
      "knowledge_candidates", "budget_guidance", "budget_plan",
      "onboarding_welcome", "weekly_digest", "intervention_suggestions",
      "task_creation_standards",
    ],
    expectations: [
      { tool: "clawforce_log", action: "write", min_calls: 1 },
    ],
    performance_policy: { action: "retry", max_retries: 2, then: "alert" },
    compaction: true,
    coordination: { enabled: true, schedule: "*/30 * * * *" },
    scheduling: { adaptiveWake: true, planning: true, wakeBounds: ["*/15 * * * *", "*/120 * * * *"], maxTurnsPerCycle: 50 },
    skillCap: 12,
    runtime: {
      // Cost optimization: managers get a higher bootstrap budget than workers but still reduced
      bootstrapConfig: { maxChars: 12000, totalMaxChars: 50000 },
      // Cost optimization: exclude assistant-oriented bootstrap files (managers use ClawForce briefing)
      bootstrapExcludeFiles: ["HEARTBEAT.md", "IDENTITY.md", "BOOTSTRAP.md"],
    },
  },
  employee: {
    title: "Employee",
    persona: "You are an employee agent responsible for executing assigned tasks and reporting results.",
    briefing: [
      "soul", "assigned_task", "execution_standards", "task_board",
    ],
    // Employees have zero ClawForce tools — expectations must be empty (auto-lifecycle handles transitions)
    expectations: [],
    performance_policy: { action: "retry", max_retries: 3, then: "alert" },
    compaction: false,
    coordination: { enabled: false },
    skillCap: 8,
    runtime: {
      // Cost optimization: workers only need core coding tools
      allowedTools: ["Bash", "Read", "Edit", "Write", "WebSearch"],
      // Cost optimization: reduce bootstrap budget — workers get context via ClawForce briefing
      bootstrapConfig: { maxChars: 8000, totalMaxChars: 30000 },
      // Cost optimization: exclude assistant-oriented bootstrap files
      bootstrapExcludeFiles: ["AGENTS.md", "HEARTBEAT.md", "IDENTITY.md", "BOOTSTRAP.md"],
    },
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
  onboarding: {
    extends: "assistant",
    title: "Clawforce Onboarding Guide",
    persona: `You are the Clawforce onboarding guide. Help users set up their AI workforce.

You understand three scenarios:
1. EXISTING PROJECT: The user already has an AI workforce or runtime setup. Help them create a Clawforce domain that adds governance (budgets, compliance, org structure) on top of their existing execution environment. Ask about their current agents, what they do, how they relate to each other, and which executor/runtime they plan to keep using.

2. NEW PROJECT: The user is starting fresh. Help them design their AI workforce. Ask about their use case, how many agents they need, what roles, and their budget. Generate the full config.

3. EXPLORATION: The user just wants to see how Clawforce works. Create a demo domain with sample agents so they can explore the dashboard.

For all scenarios:
- Ask questions one at a time
- Suggest an operational profile (low/medium/high/ultra) based on their budget
- Show the cost preview before finalizing
- Create the config files using clawforce_setup tools
- After setup, point them to the dashboard views that matter most for their use case

POST-SETUP COACHING (first-day guide):
After creating the domain, transition to coaching mode:
- "Your domain is live. Your manager agent will wake up on its first coordination cycle shortly."
- Help them create their first goal or task: "Want to give your team something to work on? Tell me what to create."
- Walk them through their first approval when one comes in
- Explain what they're seeing in the dashboard as data populates
- After 2-3 interactions, let them know: "You've got the hang of it. I'm here in the assistant widget anytime you need help."
- You naturally transition from onboarding guide to regular dashboard assistant after the first session

You have access to all Clawforce tools. Use clawforce_setup to create configs, clawforce_ops for operational actions.`,
    briefing: [
      "soul", "tools_reference", "skill", "memory_instructions",
    ],
    expectations: [],
    performance_policy: { action: "alert" },
    coordination: { enabled: false },
  },
  verifier: {
    extends: "employee",
    title: "Verifier",
    persona: "You are a code reviewer. Your job is to verify completed work against acceptance criteria. Read the task, read the evidence, check the code, run tests, and submit a verdict. You cannot modify code — if something is wrong, reject with specific feedback.",
    briefing: [
      "soul", "tools_reference", "assigned_task",
      "review_standards",
    ],
    expectations: [
      { tool: "clawforce_verify", action: "verdict", min_calls: 1 },
    ],
    performance_policy: { action: "retry", max_retries: 2, then: "alert" },
    compactBriefing: false,
    compaction: false,
    coordination: { enabled: false },
    skillCap: 4,
    runtime: {
      // Cost optimization: verifiers only need read-only tools (no Edit/Write)
      allowedTools: ["Bash", "Read", "WebSearch"],
      // Cost optimization: reduce bootstrap budget — verifiers get context via ClawForce briefing
      bootstrapConfig: { maxChars: 8000, totalMaxChars: 30000 },
      // Cost optimization: exclude assistant-oriented bootstrap files
      bootstrapExcludeFiles: ["AGENTS.md", "HEARTBEAT.md", "IDENTITY.md", "BOOTSTRAP.md"],
    },
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
  daily_review: {
    cron: "0 18 * * *",
    briefing: [
      { source: "instructions" },
      { source: "task_board" },
      { source: "team_performance" },
      { source: "velocity" },
      { source: "trust_scores" },
      { source: "cost_summary" },
    ],
    nudge: "Review today's progress. Check task completion, agent performance, and budget efficiency. Take action: reassign stuck work, adjust priorities, message underperformers with specific feedback.",
  },
  memory_review: {
    cron: "0 18 * * *",
    model: "gpt-5.4-mini",
    sessionTarget: "isolated",
    briefing: ["memory_review_context"],
    expectations: [
      { tool: "memory_search", action: "search", min_calls: 1 },
    ],
    nudge: "Review today's session transcripts. Extract key learnings, decisions, patterns, and reusable knowledge. Search existing memory to avoid duplicates. Write valuable findings to memory using memory tools.",
    performance_policy: { action: "alert" },
  },
};
