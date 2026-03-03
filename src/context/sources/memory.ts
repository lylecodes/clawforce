/**
 * Clawforce — Memory context source
 *
 * Injects scoped shared memories at session start.
 * Derives scopes from agent identity (agent ID, role, team, department)
 * and returns the top memories ordered by quality signal.
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../../db.js";
import { deriveAgentScopes } from "../../tools/memory-tool.js";
import type { AgentConfig } from "../../types.js";

/**
 * Build memory context markdown for an agent.
 * Returns null if no memories exist for the agent's scopes.
 */
export function buildMemoryContext(
  projectId: string,
  agentId: string,
  config: AgentConfig,
  dbOverride?: DatabaseSync,
): string | null {
  const db = dbOverride ?? getDb(projectId);
  const scopes = deriveAgentScopes(agentId, config);

  if (scopes.length === 0) return null;

  const placeholders = scopes.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT id, scope, category, title, content, confidence, validation_count, source_agent, created_at
    FROM memory
    WHERE project_id = ? AND scope IN (${placeholders}) AND deprecated = 0
    ORDER BY (confidence * validation_count) DESC, last_validated_at DESC
    LIMIT 15
  `).all(projectId, ...scopes) as MemoryRow[];

  if (rows.length === 0) return null;

  // Group by scope for readability
  const grouped = new Map<string, MemoryRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.scope) ?? [];
    existing.push(row);
    grouped.set(row.scope, existing);
  }

  const lines = ["## Shared Memory\n"];
  lines.push("Learnings from previous sessions and same-type agents. Use `clawforce_memory recall` for more detail.\n");

  for (const [scope, entries] of grouped) {
    lines.push(`### ${formatScopeLabel(scope)}\n`);
    for (const entry of entries) {
      const quality = `${(entry.confidence * 100).toFixed(0)}%`;
      const validated = entry.validation_count > 1 ? ` (confirmed ${entry.validation_count}x)` : "";
      lines.push(`- **${entry.title}** [${entry.category}, ${quality}${validated}]`);
      // Include content summary (first 200 chars)
      const summary = entry.content.length > 200
        ? entry.content.slice(0, 200) + "..."
        : entry.content;
      lines.push(`  ${summary}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatScopeLabel(scope: string): string {
  const [type, name] = scope.split(":", 2);
  switch (type) {
    case "agent": return `Personal (${name})`;
    case "team": return `Team: ${name}`;
    case "dept": return `Department: ${name}`;
    case "role": return `Role: ${name}`;
    default: return scope;
  }
}

type MemoryRow = {
  id: string;
  scope: string;
  category: string;
  title: string;
  content: string;
  confidence: number;
  validation_count: number;
  source_agent?: string;
  created_at: number;
};
