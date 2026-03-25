/**
 * Clawforce — Per-agent document resolvers (SOUL.md / TOOLS.md)
 *
 * Loads agent-scoped documentation from the project's agents/ directory.
 * TOOLS.md is auto-generated from the agent's effective scope when not present on disk.
 * SOUL.md is user-authored and optional — overrides config.persona when present.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentConfig } from "../../types.js";
import { DEFAULT_ACTION_SCOPES } from "../../profiles.js";
import { resolveEffectiveScopeForProject } from "../../scope.js";
import { generateScoped } from "../../skills/topics/tools.js";

const MAX_DOC_SIZE = 10_240; // 10KB cap, same as file source

/**
 * Resolve the agent's directory path. Returns null if projectDir is missing
 * or the resolved path escapes the project directory (path traversal guard).
 */
function resolveAgentDir(agentId: string, projectDir: string): string | null {
  // Guard against path traversal in agentId
  if (agentId.includes("..") || agentId.includes("/") || agentId.includes("\\")) {
    return null;
  }
  const agentDir = path.resolve(projectDir, "agents", agentId);
  const prefix = path.resolve(projectDir, "agents") + path.sep;
  if (!agentDir.startsWith(prefix)) return null;
  return agentDir;
}

/**
 * Resolve TOOLS.md for an agent.
 * - If the file exists on disk: returns its contents (user has customized).
 * - If not: auto-generates from effective scope (custom policies → role defaults).
 */
export function resolveToolsDocs(
  agentId: string,
  config: AgentConfig,
  projectDir: string | undefined,
  projectId?: string,
): string | null {
  // Try loading from disk first
  if (projectDir) {
    const agentDir = resolveAgentDir(agentId, projectDir);
    if (agentDir) {
      const toolsPath = path.join(agentDir, "TOOLS.md");
      try {
        if (fs.existsSync(toolsPath)) {
          const content = fs.readFileSync(toolsPath, "utf-8").trim();
          if (content) {
            return content.length > MAX_DOC_SIZE
              ? content.slice(0, MAX_DOC_SIZE) + "\n…(truncated)"
              : content;
          }
        }
      } catch {
        // Fall through to auto-generation
      }
    }
  }

  // Auto-generate from effective scope (checks custom policies first)
  const scope = projectId
    ? resolveEffectiveScopeForProject(projectId, agentId, config.extends)
    : DEFAULT_ACTION_SCOPES[config.extends ?? "employee"];
  if (!scope) return null;

  // Compact mode: one-liner per tool instead of full action listing.
  // The agent already knows its role from Soul and Standards — it doesn't
  // need every action memorized. Full docs available via clawforce_context expand.
  if (config.compactBriefing) {
    return generateCompactToolsSummary(scope);
  }

  return generateScoped(scope);
}

/** Generate a slim tools summary — tool name + one-liner description. */
function generateCompactToolsSummary(scope: Record<string, unknown>): string {
  const TOOL_SUMMARIES: Record<string, string> = {
    clawforce_task: "create, list, get, transition, review tasks and manage proposals",
    clawforce_log: "write journal entries, record outcomes, search history",
    clawforce_verify: "request reviews and submit verdicts (approve/reject/rework)",
    clawforce_workflow: "create and manage multi-phase workflows",
    clawforce_setup: "system setup, status checks, config validation",
    clawforce_compact: "update persistent context documents",
    clawforce_ops: "dispatch workers, check queue, reassign, agent lifecycle, audit",
    clawforce_context: "expand any briefing source for full detail",
    memory_search: "semantic search across past sessions and decisions",
    memory_get: "retrieve a specific memory entry by ID",
  };

  const lines = ["## Your Tools", ""];
  for (const toolName of Object.keys(scope)) {
    const summary = TOOL_SUMMARIES[toolName] ?? "available";
    lines.push(`- **${toolName}** — ${summary}`);
  }
  lines.push("");
  lines.push("> Use clawforce_context expand source=tools_reference for full action listing");
  return lines.join("\n");
}

/**
 * Resolve SOUL.md for an agent.
 * Returns the file contents if present, null otherwise (falls back to config.persona).
 */
export function resolveSoulDoc(
  agentId: string,
  projectDir: string | undefined,
): string | null {
  if (!projectDir) return null;

  const agentDir = resolveAgentDir(agentId, projectDir);
  if (!agentDir) return null;

  const soulPath = path.join(agentDir, "SOUL.md");
  try {
    if (!fs.existsSync(soulPath)) return null;
    const content = fs.readFileSync(soulPath, "utf-8").trim();
    if (!content) return null;
    return content.length > MAX_DOC_SIZE
      ? content.slice(0, MAX_DOC_SIZE) + "\n…(truncated)"
      : content;
  } catch {
    return null;
  }
}
