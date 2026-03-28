import fs from "node:fs";
import path from "node:path";

const CONTEXT_FILES: Record<string, string> = {
  direction: "DIRECTION.md",
  policies: "POLICIES.md",
  standards: "STANDARDS.md",
  architecture: "ARCHITECTURE.md",
};

/**
 * Render a domain context file as a briefing section.
 * Reads from {projectsDir}/domains/{domain}/context/{FILE}.md
 *
 * For all source types, supports per-team override files:
 *   1. {FILE}-{team}.md (team-specific, if team is provided)
 *   2. {FILE}.md (domain-wide fallback)
 *
 * @param projectsDir - The ClawForce projects directory (e.g. ~/.clawforce)
 * @param domain - The domain name
 * @param sourceType - One of: direction, policies, standards, architecture
 * @param team - Optional team name for team-specific resolution
 */
export function renderDomainContext(
  projectsDir: string,
  domain: string,
  sourceType: string,
  team?: string,
): string | null {
  const fileName = CONTEXT_FILES[sourceType];
  if (!fileName) return null;

  const contextDir = path.join(projectsDir, "domains", domain, "context");

  // For any source type with a team, try team-specific file first
  if (team) {
    const baseName = fileName.replace(".md", "");
    const teamFileName = `${baseName}-${team}.md`;
    const teamContent = readContextFile(path.join(contextDir, teamFileName));
    if (teamContent !== null) return teamContent;
  }

  // Fall back to the domain-wide file
  return readContextFile(path.join(contextDir, fileName));
}

/**
 * Read and trim a context file, returning null if missing or empty.
 */
function readContextFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) return null;
    return content;
  } catch {
    return null;
  }
}
