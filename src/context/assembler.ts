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
  const budgetChars = opts?.budgetChars ?? config.contextBudgetChars ?? 15_000;
  const sessionKey = opts?.sessionKey;
  const sections: string[] = [];

  // Inject title and persona at the top of the context
  const profileHeader = buildProfileHeader(agentId, config, opts?.projectDir);
  if (profileHeader) {
    sections.push(profileHeader);
  }

  for (const rawSource of config.briefing) {
    // Normalize: presets store briefing as string[] but assembler expects ContextSource[]
    const source: ContextSource = typeof rawSource === "string"
      ? { source: rawSource as ContextSource["source"] }
      : rawSource;
    const content = resolveSource(source, ctx, sessionKey);
    if (content) {
      sections.push(content);
    }
  }

  // Auto-inject compaction instructions at the end for eligible agents
  if (isCompactionEnabled(config)) {
    const compactionInstructions = buildCompactionInstructions(config, ctx.projectDir);
    if (compactionInstructions) {
      sections.push(compactionInstructions);
    }
  }

  if (sections.length === 0) return "";

  let result = sections.join("\n\n");

  if (result.length > budgetChars) {
    result = result.slice(0, budgetChars - 20) + "\n\n[...truncated]";
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
