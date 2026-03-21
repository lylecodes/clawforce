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
 * @param projectsDir - The ClawForce projects directory (e.g. ~/.clawforce)
 * @param domain - The domain name
 * @param sourceType - One of: direction, policies, standards, architecture
 */
export function renderDomainContext(
  projectsDir: string,
  domain: string,
  sourceType: string,
): string | null {
  const fileName = CONTEXT_FILES[sourceType];
  if (!fileName) return null;

  // Try domain-specific context directory
  const contextPath = path.join(projectsDir, "domains", domain, "context", fileName);
  try {
    if (!fs.existsSync(contextPath)) return null;
    const content = fs.readFileSync(contextPath, "utf-8").trim();
    if (!content) return null;
    return content;
  } catch {
    return null;
  }
}
