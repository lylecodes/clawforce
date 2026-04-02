/**
 * Clawforce — Context assembler
 *
 * Builds the session-start context for an agent from its config.
 * Kept minimal: role description + enforcement instructions + any custom sources.
 * Heavy context comes from tool responses at point of decision.
 *
 * Source resolution is handled by the context source registry (registry.ts).
 * Sources are registered in register-sources.ts (side-effect import).
 */

import type { ContextSource, AgentConfig } from "../types.js";
import { isCompactionEnabled, buildCompactionInstructions } from "./sources/compaction.js";
import { resolveSoulDoc } from "./sources/agent-docs.js";
import { resolveRegisteredSource } from "./registry.js";

// Side-effect import: registers all context sources with the registry.
import "./register-sources.js";

/**
 * Priority tiers for context sources (lower number = higher priority = kept first).
 * When truncation is needed, lowest-priority (highest number) sources are dropped first.
 */
const SOURCE_PRIORITY: Record<string, number> = {
  // Tier 1: Always keep — identity and instructions
  instructions: 1, soul: 1, direction: 1, policies: 1, standards: 1,
  custom: 1, project_md: 1, memory_instructions: 1, onboarding_welcome: 1,
  architecture: 1,

  // Tier 2: Current work context
  task_board: 2, assigned_task: 2, task_creation_standards: 2,
  execution_standards: 2, review_standards: 2, rejection_standards: 2,

  // Tier 3: Communication and escalations
  escalations: 3, pending_messages: 3, user_messages: 3, proposals: 3,
  channel_messages: 3, worker_findings: 3, intervention_suggestions: 3,

  // Tier 4: Planning and goals
  planning_delta: 4, goal_hierarchy: 4, initiative_status: 4,
  workflows: 4, recent_decisions: 4, budget_plan: 4, budget_guidance: 4,

  // Tier 5: Team and performance
  team_status: 5, team_performance: 5, agent_status: 5, trust_scores: 5,
  velocity: 5, cost_summary: 5, cost_forecast: 5, available_capacity: 5,

  // Tier 6: Observational / drop first
  health_status: 6, sweep_status: 6, activity: 6, observed_events: 6,
  clawforce_health_report: 6, weekly_digest: 6, policy_status: 6,
  knowledge: 6, knowledge_candidates: 6, memory_review_context: 6,
  preferences: 6, resources: 6, skill: 6, tools_reference: 6, file: 6,
  custom_stream: 6,
};

/** Default priority for sources not explicitly listed. */
const DEFAULT_SOURCE_PRIORITY = 4;

// Re-export the shared implementations so existing consumers keep working.
export {
  resolveInitiativeStatusSourceImpl as resolveInitiativeStatusSource,
  resolveCostForecastSourceImpl as resolveCostForecastSource,
  resolveAvailableCapacitySourceImpl as resolveAvailableCapacitySource,
  resolveKnowledgeCandidatesSourceImpl as resolveKnowledgeCandidatesSource,
} from "./register-sources.js";

import { getAgentConfig } from "../project.js";

export type AssemblerContext = {
  agentId: string;
  config: AgentConfig;
  projectId?: string;
  projectDir?: string;
};

/**
 * Sources that are static within a session — their content does not change between turns.
 * These are cached per session key to avoid redundant re-resolution on every turn.
 */
const STATIC_SOURCES = new Set<string>([
  "soul",
  "project_md",
  "skill",
  "tools_reference",
  "memory_instructions",
  "instructions",
]);

/** Session-scoped cache: `${sessionKey}:${sourceName}` → content */
const assemblerCache = new Map<string, string | null>();

/**
 * Clear the assembler cache for a given session at session end.
 */
export function clearAssemblerCache(sessionKey: string): void {
  for (const key of assemblerCache.keys()) {
    if (key.startsWith(`${sessionKey}:`)) {
      assemblerCache.delete(key);
    }
  }
}

/**
 * Assemble the session-start context for an agent.
 * Returns a markdown string to inject via before_prompt_build.
 */
export function assembleContext(
  agentId: string,
  config: AgentConfig,
  opts?: { projectId?: string; projectDir?: string; budgetChars?: number; sessionKey?: string },
): string {
  const ctx: AssemblerContext = { agentId, config, projectId: opts?.projectId, projectDir: opts?.projectDir };

  // Read default budget from project config, fall back to agent config, then hardcoded default
  let defaultBudgetChars = 15_000;
  if (opts?.projectId) {
    try {
      const { getExtendedProjectConfig } = require("../project.js") as typeof import("../project.js");
      const extConfig = getExtendedProjectConfig(opts.projectId);
      if (extConfig?.context?.defaultBudgetChars != null) {
        defaultBudgetChars = extConfig.context.defaultBudgetChars;
      }
    } catch { /* project module may not be available */ }
  }
  const budgetChars = opts?.budgetChars ?? config.contextBudgetChars ?? defaultBudgetChars;
  const sessionKey = opts?.sessionKey;

  // Collect sections tagged with their source priority for smart truncation.
  type TaggedSection = { content: string; priority: number; idx: number };
  const sections: TaggedSection[] = [];
  let idx = 0;

  // Inject title and persona at the top of the context (always highest priority)
  const profileHeader = buildProfileHeader(agentId, config, opts?.projectDir);
  if (profileHeader) {
    sections.push({ content: profileHeader, priority: 0, idx: idx++ });
  }

  for (const rawSource of config.briefing) {
    // Normalize: presets store briefing as string[] but assembler expects ContextSource[]
    const source: ContextSource = typeof rawSource === "string"
      ? { source: rawSource as ContextSource["source"] }
      : rawSource;
    const content = resolveSource(source, ctx, sessionKey);
    if (content) {
      const priority = SOURCE_PRIORITY[source.source] ?? DEFAULT_SOURCE_PRIORITY;
      sections.push({ content, priority, idx: idx++ });
    }
  }

  // Auto-inject compaction instructions at the end for eligible agents (high priority — instructions)
  if (isCompactionEnabled(config)) {
    const compactionInstructions = buildCompactionInstructions(config, ctx.projectDir);
    if (compactionInstructions) {
      sections.push({ content: compactionInstructions, priority: 1, idx: idx++ });
    }
  }

  if (sections.length === 0) return "";

  // Check total length before any truncation
  const totalLength = sections.reduce((sum, s) => sum + s.content.length, 0) + (sections.length - 1) * 2;
  if (totalLength <= budgetChars) {
    return sections.map((s) => s.content).join("\n\n");
  }

  // Priority-based truncation: include highest-priority sections first,
  // drop lowest-priority sources entirely until under budget.
  const sorted = [...sections].sort((a, b) => a.priority - b.priority || a.idx - b.idx);

  const TRUNCATION_NOTE_RESERVE = 60; // space reserved for the truncation footer
  let usedChars = 0;
  const included: TaggedSection[] = [];
  let dropped = 0;
  let hardTruncated = false;

  for (const entry of sorted) {
    const separatorCost = included.length > 0 ? 2 : 0; // "\n\n"
    const sectionCost = entry.content.length + separatorCost;
    if (usedChars + sectionCost + TRUNCATION_NOTE_RESERVE <= budgetChars) {
      usedChars += sectionCost;
      included.push(entry);
    } else {
      // Try to hard-truncate this last section if there's meaningful room
      const remaining = budgetChars - usedChars - separatorCost - TRUNCATION_NOTE_RESERVE;
      if (remaining > 100) {
        included.push({ content: entry.content.slice(0, remaining), priority: entry.priority, idx: entry.idx });
        usedChars += remaining + separatorCost;
        hardTruncated = true;
        dropped += sorted.length - included.length;
        break;
      } else {
        dropped++;
      }
    }
  }

  // Re-sort included sections by original index to preserve logical order
  included.sort((a, b) => a.idx - b.idx);

  let result = included.map((s) => s.content).join("\n\n");
  if (dropped > 0 || hardTruncated) {
    if (dropped > 0) {
      result += `\n\n[...truncated — dropped ${dropped} source${dropped > 1 ? "s" : ""} to fit budget]`;
    } else {
      result += "\n\n[...truncated]";
    }
  }

  return result;
}

/**
 * Resolve a single context source to its content.
 * Static sources (soul, project_md, skill, tools_reference, memory_instructions, instructions)
 * are cached per session key to avoid redundant re-resolution on every turn.
 */
function resolveSource(source: ContextSource, ctx: AssemblerContext, sessionKey?: string): string | null {
  // Cache lookup for static sources
  if (sessionKey && STATIC_SOURCES.has(source.source)) {
    const cacheKey = `${sessionKey}:${source.source}`;
    if (assemblerCache.has(cacheKey)) {
      return assemblerCache.get(cacheKey) ?? null;
    }
    const result = resolveRegisteredSource(source.source, ctx, source);
    assemblerCache.set(cacheKey, result);
    return result;
  }
  return resolveRegisteredSource(source.source, ctx, source);
}

/**
 * Build a profile header with title and persona for the agent.
 * If SOUL.md exists, uses its content as persona instead of config.persona.
 */
function buildProfileHeader(agentId: string, config: AgentConfig, projectDir?: string): string | null {
  const title = config.title;

  // SOUL.md overrides config.persona when present
  const soulContent = resolveSoulDoc(agentId, projectDir);
  const persona = soulContent ?? config.persona;

  if (!title && !persona) return null;

  const lines: string[] = [];
  if (title) {
    lines.push(`## Role: ${title}`);
  }
  if (persona) {
    lines.push("", persona);
  }

  return lines.join("\n");
}

/**
 * Resolve a single briefing source for the context tool (expand action).
 */
export function resolveSourceForTool(projectId: string, agentId: string, sourceName: string): string | null {
  const agentEntry = getAgentConfig(agentId);
  if (!agentEntry) return null;

  const source: ContextSource = { source: sourceName as ContextSource["source"] };
  const ctx: AssemblerContext = {
    agentId,
    config: agentEntry.config,
    projectId,
    projectDir: agentEntry.projectDir,
  };

  return resolveRegisteredSource(sourceName, ctx, source);
}
