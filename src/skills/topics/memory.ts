/**
 * Clawforce skill topic — Memory
 *
 * Documents the shared memory system.
 */

import { MEMORY_ACTIONS, MEMORY_CATEGORIES } from "../../tools/memory-tool.js";

export function generate(): string {
  const sections: string[] = [
    "# Shared Memory",
    "",
    "The shared memory system enables agents to save and recall learnings across sessions. Memories are scoped by agent identity, so same-type agents (same team, department, or role) automatically share relevant knowledge.",
    "",

    "## How Shared Memory Works",
    "",
    "1. An agent saves a memory with a scope, category, and content",
    "2. The memory is stored persistently in the project database",
    "3. At the start of a new session, relevant memories are auto-injected via the `memory` context source",
    "4. Agents can also explicitly recall memories during a session",
    "5. Memories can be validated (confirmed still accurate) or deprecated (marked outdated)",
    "",

    "## Scope Model",
    "",
    "Memories are scoped by identity. Each scope determines who can see the memory:",
    "",
    "| Scope | Format | Shared With |",
    "| --- | --- | --- |",
    "| Agent | `agent:<id>` | Only this specific agent |",
    "| Team | `team:<name>` | All agents in the same team |",
    "| Department | `dept:<name>` | All agents in the same department |",
    "| Role | `role:<role>` | All agents with the same role |",
    "",

    "### How Scopes Are Derived",
    "",
    "When an agent recalls memories, the system derives their readable scopes from their config:",
    "",
    "- Always includes `agent:<agentId>`",
    "- If the agent has a `role`, includes `role:<role>`",
    "- If the agent has a `team`, includes `team:<team>`",
    "- If the agent has a `department`, includes `dept:<department>`",
    "",
    "An agent with `role: employee`, `team: frontend`, `department: engineering` would query memories from scopes: `agent:dev-1`, `role:employee`, `team:frontend`, `dept:engineering`.",
    "",

    "## Memory Categories",
    "",
  ];

  for (const cat of MEMORY_CATEGORIES) {
    let description: string;
    switch (cat) {
      case "learning": description = "General learnings and knowledge gained (default)"; break;
      case "pattern": description = "Recurring patterns observed in the codebase or workflow"; break;
      case "rule": description = "Hard rules to always follow"; break;
      case "warning": description = "Pitfalls and things to avoid"; break;
      case "insight": description = "Higher-level observations and connections"; break;
    }
    sections.push(`- **\`${cat}\`**: ${description}`);
  }

  sections.push("");

  sections.push("## Memory Actions");
  sections.push("");

  for (const action of MEMORY_ACTIONS) {
    let description: string;
    switch (action) {
      case "save": description = "Save a new memory with scope, category, title, content, and confidence. Optionally supersede an older memory (deprecating it)."; break;
      case "recall": description = "Query memories filtered by scope, category, and text search. Auto-filtered to the agent's derived scopes unless a specific scope is given."; break;
      case "validate": description = "Confirm that a memory is still accurate. Increments the `validation_count` and updates `last_validated_at`, boosting its ranking."; break;
      case "deprecate": description = "Mark a memory as outdated. Deprecated memories are excluded from recall and context injection."; break;
      case "list": description = "Browse memories by scope and category without text search filtering."; break;
    }
    sections.push(`- **\`${action}\`**: ${description}`);
  }

  sections.push("");

  sections.push("## Quality Signals");
  sections.push("");
  sections.push("Memories are ranked by quality when displayed or injected as context:");
  sections.push("");
  sections.push("- **`confidence`**: A value from 0.0 to 1.0 set by the saving agent (default 0.7). Higher confidence = more likely to surface.");
  sections.push("- **`validation_count`**: Number of times the memory has been validated by agents. Each validation boosts the memory's ranking.");
  sections.push("");
  sections.push("The ranking formula is: `confidence * validation_count`, with `last_validated_at` as a tiebreaker (more recently validated memories rank higher).");
  sections.push("");

  sections.push("## Memory vs Journal (`clawforce_log`)");
  sections.push("");
  sections.push("| Aspect | Memory (`clawforce_memory`) | Journal (`clawforce_log`) |");
  sections.push("| --- | --- | --- |");
  sections.push("| Purpose | Persistent learnings that persist across sessions | Session-specific activity log |");
  sections.push("| Scope | Shared across agents via identity scopes | Per-agent, per-session |");
  sections.push("| Lifecycle | Lives until deprecated | Immutable audit trail |");
  sections.push("| Ranking | Quality-ranked (confidence + validation) | Chronological |");
  sections.push("| Auto-injected | Yes, via `memory` context source | No (searchable via `search` action) |");
  sections.push("| Use case | \"Remember this for next time\" | \"Log what I did today\" |");
  sections.push("");

  sections.push("## Auto-Injection at Session Start");
  sections.push("");
  sections.push("When the `memory` context source is included in an agent's briefing, the system:");
  sections.push("");
  sections.push("1. Derives the agent's readable scopes from their config");
  sections.push("2. Queries the top 15 non-deprecated memories across all scopes");
  sections.push("3. Ranks them by quality signal (`confidence * validation_count`)");
  sections.push("4. Groups them by scope for readability");
  sections.push("5. Injects them as a \"Shared Memory\" section in the agent's context");
  sections.push("");
  sections.push("This creates a feedback loop: agents learn from their own past sessions and from other agents with similar roles, teams, or departments.");
  sections.push("");

  return sections.join("\n");
}
