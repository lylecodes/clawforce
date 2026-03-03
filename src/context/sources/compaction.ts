/**
 * Clawforce — Compaction instructions source
 *
 * Builds compaction instructions by inspecting the agent's briefing.
 * For each file or project_md source, tells the agent to update that file
 * with session learnings before ending.
 */

import type { AgentConfig, CompactionConfig } from "../../types.js";

/**
 * Resolve compaction config to a normalized CompactionConfig.
 * - undefined → null (use paradigm default externally)
 * - boolean → { enabled: bool }
 * - CompactionConfig → as-is
 */
export function resolveCompactionConfig(
  raw: boolean | CompactionConfig | undefined,
): CompactionConfig | null {
  if (raw === undefined) return null;
  if (typeof raw === "boolean") return { enabled: raw };
  return raw;
}

/**
 * Check if compaction is effectively enabled for an agent config.
 */
export function isCompactionEnabled(config: AgentConfig): boolean {
  if (config.compaction === undefined) return false;
  if (typeof config.compaction === "boolean") return config.compaction;
  return config.compaction.enabled;
}

/**
 * Derive compactable file targets from an agent's briefing.
 * Returns relative file paths the agent should update.
 */
export function deriveCompactionTargets(config: AgentConfig): string[] {
  // If explicit files are provided, use those
  if (
    typeof config.compaction === "object" &&
    config.compaction !== null &&
    typeof config.compaction !== "boolean" &&
    config.compaction.files?.length
  ) {
    return config.compaction.files;
  }

  // Otherwise derive from briefing
  const targets: string[] = [];

  for (const source of config.briefing) {
    if (source.source === "project_md") {
      targets.push("PROJECT.md");
    } else if (source.source === "file" && source.path) {
      targets.push(source.path);
    }
  }

  return targets;
}

/**
 * Build compaction instructions markdown from an agent's config.
 * Returns null if no compactable sources found or compaction is disabled.
 */
export function buildCompactionInstructions(
  config: AgentConfig,
  projectDir?: string,
): string | null {
  if (!isCompactionEnabled(config)) return null;
  if (!projectDir) return null;

  const targets = deriveCompactionTargets(config);
  if (targets.length === 0) return null;

  const lines: string[] = [
    "## Session Compaction",
    "",
    "Before ending your session, update the following project documents with any",
    "significant learnings, decisions, or status changes from this session:",
    "",
  ];

  for (const target of targets) {
    const label = describeTarget(target);
    lines.push(`- **${target}**: ${label}`);
  }

  lines.push("");
  lines.push(
    "Use the `clawforce_compact` tool to update each file. First use action `read_doc` to read",
    "the current content, then use action `update_doc` with the full updated content.",
    "Only update if you have meaningful changes — skip files where nothing relevant changed.",
  );

  return lines.join("\n");
}

/**
 * Generate a human-readable description for a compaction target.
 */
function describeTarget(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower === "project.md") {
    return "Project status, progress, and key decisions";
  }
  if (lower.includes("architecture") || lower.includes("arch")) {
    return "Architectural patterns and technical decisions";
  }
  if (lower.includes("summary") || lower.includes("conversation")) {
    return "Session summary and key takeaways";
  }
  if (lower.includes("readme")) {
    return "Project documentation and setup instructions";
  }
  return "Update with relevant learnings from this session";
}
