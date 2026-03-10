/**
 * Clawforce — Agent docs bootstrap
 *
 * Creates per-agent directories and scaffolds SOUL.md templates during
 * project registration. TOOLS.md is no longer auto-generated to disk —
 * it is resolved dynamically from the agent's effective scope at runtime.
 * Existing on-disk TOOLS.md files continue to work as user overrides.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentConfig } from "../../types.js";

const SOUL_TEMPLATE_MARKER = "<!-- SOUL.md";

/**
 * Generate a SOUL.md template for an agent.
 */
export function generateSoulTemplate(agentId: string): string {
  return `<!-- SOUL.md — Identity and domain context for ${agentId} -->
<!-- Edit this file to customize this agent's persona and knowledge. -->
<!-- Delete sections you don't need. This file replaces config.persona when present. -->

## Expertise
<!-- What domains does this agent specialize in? -->

## Guidelines
<!-- Key rules, conventions, or constraints for this agent's work -->
`;
}

/**
 * Ensure the agent's docs directory exists and SOUL.md template is present.
 * Called during project registration (scanAndRegisterProjects) and activate.
 *
 * - Creates `{projectDir}/agents/{agentId}/` if missing.
 * - Scaffolds `SOUL.md` template if missing.
 * - Does NOT generate TOOLS.md to disk (resolved dynamically at runtime).
 */
export function ensureAgentDocs(
  projectDir: string,
  agentId: string,
  _config: AgentConfig,
): void {
  // Guard against path traversal
  if (agentId.includes("..") || agentId.includes("/") || agentId.includes("\\")) {
    return;
  }

  const agentDir = path.join(projectDir, "agents", agentId);

  try {
    fs.mkdirSync(agentDir, { recursive: true });
  } catch {
    return; // Can't create directory — skip silently
  }

  const soulPath = path.join(agentDir, "SOUL.md");

  // Only scaffold if SOUL.md doesn't already exist
  if (fs.existsSync(soulPath)) return;

  try {
    fs.writeFileSync(soulPath, generateSoulTemplate(agentId), "utf-8");
  } catch {
    // Write failed — not critical
  }
}

/**
 * Check if a SOUL.md file still has the scaffold marker (not yet customized).
 */
export function isSoulTemplateUnmodified(content: string): boolean {
  return content.trimStart().startsWith(SOUL_TEMPLATE_MARKER);
}
