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
import { getExtendedProjectConfig } from "../project.js";
import {
  CONTEXT_SOURCE_PRIORITIES,
  DEFAULT_CONTEXT_SOURCE_PRIORITY,
  STATIC_CONTEXT_SOURCES,
} from "./catalog.js";

// Side-effect import: registers all context sources with the registry.
import "./register-sources.js";

// Re-export the shared implementations so existing consumers keep working.
export {
  resolveInitiativeStatusSourceImpl as resolveInitiativeStatusSource,
  resolveCostForecastSourceImpl as resolveCostForecastSource,
  resolveAvailableCapacitySourceImpl as resolveAvailableCapacitySource,
  resolveKnowledgeCandidatesSourceImpl as resolveKnowledgeCandidatesSource,
} from "./register-sources.js";

import { getAgentConfig } from "../project.js";
import { getDefaultRuntimeState } from "../runtime/default-runtime.js";

export type AssemblerContext = {
  agentId: string;
  config: AgentConfig;
  projectId?: string;
  projectDir?: string;
  sessionKey?: string;
  taskId?: string;
  queueItemId?: string;
};

/**
 * Sources that are static within a session — their content does not change between turns.
 * These are cached per session key to avoid redundant re-resolution on every turn.
 */
type ContextAssemblerRuntimeState = {
  cache: Map<string, string | null>;
};

const runtime = getDefaultRuntimeState();

function getAssemblerCache(): ContextAssemblerRuntimeState["cache"] {
  return (runtime.contextAssembler as ContextAssemblerRuntimeState).cache;
}

/**
 * Clear the assembler cache for a given session at session end.
 */
export function clearAssemblerCache(sessionKey: string): void {
  for (const key of getAssemblerCache().keys()) {
    if (key.startsWith(`${sessionKey}:`)) {
      getAssemblerCache().delete(key);
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
  opts?: {
    projectId?: string;
    projectDir?: string;
    budgetChars?: number;
    sessionKey?: string;
    taskId?: string;
    queueItemId?: string;
  },
): string {
  const ctx: AssemblerContext = {
    agentId,
    config,
    projectId: opts?.projectId,
    projectDir: opts?.projectDir,
    sessionKey: opts?.sessionKey,
    taskId: opts?.taskId,
    queueItemId: opts?.queueItemId,
  };

  // Read default budget from project config, fall back to agent config, then hardcoded default
  let defaultBudgetChars = 15_000;
  if (opts?.projectId) {
    try {
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
      const priority = CONTEXT_SOURCE_PRIORITIES[source.source] ?? DEFAULT_CONTEXT_SOURCE_PRIORITY;
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
  if (sessionKey && STATIC_CONTEXT_SOURCES.has(source.source)) {
    const cacheKey = `${sessionKey}:${source.source}`;
    if (getAssemblerCache().has(cacheKey)) {
      return getAssemblerCache().get(cacheKey) ?? null;
    }
    const result = resolveRegisteredSource(source.source, ctx, source);
    getAssemblerCache().set(cacheKey, result);
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
  const agentEntry = getAgentConfig(agentId, projectId);
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
