/**
 * Clawforce skill topic — Memory
 *
 * Documents the RAG-based memory system powered by OpenClaw.
 */

export function generate(): string {
  const sections: string[] = [
    "# Shared Memory (RAG)",
    "",
    "The shared memory system is powered by OpenClaw's native RAG (Retrieval-Augmented Generation) engine. It provides two tools for interacting with persistent memory across sessions.",
    "",

    "## Tools",
    "",

    "### `memory_search`",
    "",
    "Semantic search across all stored memories. Uses hybrid BM25 + vector similarity with MMR re-ranking to find the most relevant results.",
    "",
    "- Accepts a natural-language query",
    "- Returns ranked results with relevance scores",
    "- Automatically filters to memories accessible by the current agent",
    "",

    "### `memory_get`",
    "",
    "Retrieve a specific memory entry by its ID.",
    "",
    "- Use when you already know the memory ID (e.g. from a previous search result)",
    "- Returns the full memory content and metadata",
    "",

    "## How RAG Memory Works",
    "",
    "1. When an agent produces a learning worth persisting, OpenClaw stores it with vector embeddings",
    "2. At query time, `memory_search` combines:",
    "   - **BM25** (keyword matching) for exact term recall",
    "   - **Vector similarity** (semantic embeddings) for meaning-based recall",
    "   - **MMR re-ranking** (Maximal Marginal Relevance) to diversify results and reduce redundancy",
    "3. Results are ranked by combined relevance and returned to the agent",
    "",

    "## Memory vs Journal (`clawforce_log`)",
    "",
    "| Aspect | Memory (`memory_search` / `memory_get`) | Journal (`clawforce_log`) |",
    "| --- | --- | --- |",
    "| Purpose | Persistent learnings across sessions | Session-specific activity log |",
    "| Storage | OpenClaw RAG with vector embeddings | SQLite audit trail |",
    "| Retrieval | Semantic search (hybrid BM25 + vector) | Keyword search or chronological |",
    "| Lifecycle | Managed by OpenClaw (auto-decay, dedup) | Immutable audit trail |",
    "| Auto-injected | Yes, via `memory` context source (as tool guidance) | No (searchable via `search` action) |",
    "| Use case | \"Find what we learned about X\" | \"Log what I did today\" |",
    "",

    "## Context Injection",
    "",
    "When the `memory` context source is included in an agent's briefing, the system injects guidance directing the agent to use `memory_search` and `memory_get` tools. Unlike the previous system, memories are not pre-loaded — agents search on-demand for relevant context.",
    "",

    "## Knowledge Promotion Pipeline",
    "",
    "Frequently retrieved memories can be promoted to structured knowledge. The system tracks retrieval frequency for every memory entry. When a memory crosses the configured threshold (default: 3 retrievals), it becomes a **promotion candidate**.",
    "",
    "- `checkPromotionCandidates(projectId)` — scans retrieval stats and creates candidates for memories above threshold",
    "- `listCandidates(projectId)` — lists all pending promotion candidates",
    "- `getCandidate(projectId, candidateId)` — retrieves a specific candidate",
    "- `approveCandidate(projectId, candidateId)` — approves promotion (memory becomes structured knowledge)",
    "- `dismissCandidate(projectId, candidateId)` — dismisses the candidate without promoting",
    "",
    "Managers review candidates via the `knowledge_candidates` briefing source, which surfaces pending promotions during coordination sessions.",
    "",

    "## Knowledge Demotion (Flagging)",
    "",
    "When structured knowledge is wrong or outdated, agents can flag it for review using the `flag_knowledge` action. This creates a demotion flag that a manager must review.",
    "",
    "- `createFlag(params)` — creates a flag against a knowledge entry with a reason",
    "- `getFlag(projectId, flagId)` — retrieves a specific flag",
    "- `listFlags(projectId)` — lists all pending flags",
    "- `resolveFlag(projectId, flagId)` — resolves the flag (demotes the knowledge back to a regular memory)",
    "- `dismissFlag(projectId, flagId)` — dismisses the flag (knowledge stays as-is)",
    "",

    "## Skill Cap",
    "",
    "Each agent preset defines a `skillCap` — the maximum number of skill topics that can be injected into a session. Manager agents default to 12, employees to 8. If an agent's configured skills exceed the cap, the config validator emits a lint warning. This prevents context bloat from too many injected skill sections.",
    "",

    "## Expectations Re-Injection",
    "",
    "Behavioral expectations (e.g. \"call clawforce_log at least once\") are defined in agent config and injected at session start. However, rules injected only at session start decay over long conversations. The ghost turn mechanism periodically re-injects a compact expectations reminder using `formatExpectationsReminder()`, reinforcing behavioral rules every turn to prevent drift.",
    "",
  ];

  return sections.join("\n");
}
