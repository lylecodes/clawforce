# Memory Governance — Design Spec

> Last updated: 2026-03-14

## Overview

Clawforce provides **memory governance** — structured rules and automation for how agents use OpenClaw's memory infrastructure. OpenClaw owns the memory primitives (RAG vector store, memory tools, embeddings). Clawforce owns the organizational layer: when to search, when to write, where to write, what to extract, and quality control.

Three components:
1. **Memory instructions** — role-based prompt injection telling agents how to use memory correctly
2. **Memory expectations** — compliance enforcement (managers must search memory)
3. **Memory review job** — daily dispatched agent that extracts learnings from session transcripts

**Guiding principle:** Managers are memory *users* (search, write, review, promote). Employees are knowledge *consumers* (receive curated skills, learnings extracted on their behalf). Employees should not be forced to interact with memory.

---

## Part 1: Memory Instructions

### Problem

Agents don't know how to use memory properly. They write to `memory.md` (gets truncated on compaction) instead of the RAG store via memory tools. They don't search memory proactively. No structured guidance exists.

### Design

**New briefing source: `memory_instructions`**

Injected via `before_prompt_build` into agent context. Role-based defaults with full override support.

**Manager default:**

```
## Memory Protocol

- Search memory at the START of every coordination cycle for relevant strategic context
- Before making decisions, check if similar situations have been handled before
- Write strategic decisions, rationale, and observations to memory using memory tools
- IMPORTANT: Save memories to the persistent RAG store using the appropriate memory write tools. Do NOT write to memory.md — that file gets truncated on compaction. The persistent memory store is accessed via memory tools.
- Your memory review job will extract learnings from your reports' sessions — review promotion candidates in your briefing
```

**Employee default:**

```
## Memory Protocol

- Your knowledge comes through skills and curated context — check your skill documentation first
- If you discover something reusable during your task, write it to memory using memory tools (NOT memory.md)
- memory.md gets truncated on compaction. Use the memory tools for persistent storage.
- Your learnings will be automatically extracted and reviewed by your manager
```

**Configuration:**

```yaml
agents:
  lead:
    memory:
      instructions: true    # use role default
      # OR
      instructions: false   # disable
      # OR
      instructions: "Custom memory instructions text here"
```

**Implementation:** New source resolver in `src/context/sources/memory-instructions.ts`. Reads from agent config `memory.instructions`. If `true` or omitted, uses role default from presets. If string, uses custom text. If `false`, returns null.

**Source registration:** Add `"memory_instructions"` and `"memory_review_context"` to THREE places:
1. `ContextSource["source"]` union in `src/types.ts:202`
2. `VALID_SOURCES` in `src/project.ts:346`
3. `VALID_SOURCES` in `src/config-validator.ts:560`

**Replaces existing `"memory"` source:** The existing `"memory"` source (line 170 of assembler.ts) is a short blurb: "Use memory_search to find relevant learnings..." This is superseded by `memory_instructions` which provides richer, role-specific guidance. Replace `"memory"` with `"memory_instructions"` in both manager and employee preset briefing arrays. Keep the `"memory"` source case in the assembler as deprecated fallback.

Registered in the stream catalog.

---

## Part 2: Memory Expectations

### Problem

Even with instructions, agents may ignore memory search. Managers especially should be searching memory for strategic context. No enforcement mechanism exists for memory behavior.

### Design

**Add memory expectations to manager preset:**

```typescript
// In BUILTIN_AGENT_PRESETS.manager.expectations:
{ tool: "memory_search", action: "search", min_calls: 1 }
```

This means: every manager session must call `memory_search` at least once, or compliance fails. The existing enforcement system (retry → alert → escalate) handles violations.

**Employees get NO memory expectations** — they shouldn't be forced to interact with memory. Their learnings are extracted by the memory review job.

**Configuration:**

Users can override in agent config:

```yaml
agents:
  lead:
    memory:
      expectations: true       # use role default (manager: search min 1)
      # OR
      expectations: false      # no memory compliance enforcement
```

When `expectations: false`, the memory_search expectation is removed from the agent's expectations array.

**Implementation:** The expectation is added to the manager preset in `src/presets.ts`. A new field `memory.expectations` on the agent config controls whether it's included. The stripping happens in `normalizeAgentConfig()` in `src/project.ts` (NOT in `applyProfile`) — same pattern as compaction expectation stripping at lines 440-444. After `applyProfile` returns the merged expectations, `normalizeAgentConfig` checks `memory.expectations` and filters out the memory_search expectation if false.

---

## Part 3: Memory Review Job

### Problem

Agents don't reliably write good memories during their sessions. Employees especially shouldn't be burdened with memory management. A dedicated, contextful agent should review session transcripts and extract learnings after the fact.

### Design

**New built-in job preset: `memory_review`**

A dispatched agent session that reviews the day's session transcripts and writes valuable learnings to the RAG memory store.

**Job preset definition:**

```typescript
// In BUILTIN_JOB_PRESETS:
memory_review: {
  cron: "0 18 * * *",              // 6pm daily
  model: "anthropic/claude-sonnet-4-6", // needs judgment, not just pattern matching
  sessionTarget: "isolated",
  briefing: ["memory_review_context"],  // custom source with transcripts
  expectations: [
    { tool: "memory_search", action: "search", min_calls: 1 },  // check existing before writing
  ],
  nudge: "Review today's session transcripts. Extract key learnings, decisions, patterns, and reusable knowledge. Search existing memory to avoid duplicates. Write valuable findings to memory using memory tools.",
}
```

**Memory review context source: `memory_review_context`**

New briefing source that assembles:
1. Session transcripts from the day (or configured period) for the target agent(s)
2. The agent's SOUL.md (identity context — what matters to this agent)
3. Recent promotion candidates (what's already been flagged)
4. Summary of existing memories (via search for "recent learnings")

**Scope configuration:**

```yaml
agents:
  lead:
    memory:
      review:
        enabled: true
        cron: "0 18 * * *"
        model: "anthropic/claude-sonnet-4-6"
        aggressiveness: medium    # low | medium | high
        scope: reports            # self | reports | all
```

| Scope | What it reviews |
|-------|----------------|
| `self` | Only this agent's own sessions |
| `reports` | This agent's sessions + all direct reports' sessions |
| `all` | All agents in the project |

Default for managers: `reports` (extract learnings from employees on their behalf).
Default for employees: `self` (review own sessions — but disabled by default, manager handles it).

**Aggressiveness:**

| Level | Extraction behavior |
|-------|-------------------|
| `low` | Only explicit decisions, error resolutions, task outcomes |
| `medium` | Learnings, patterns, reusable context, observations |
| `high` | Everything potentially useful including hunches and partial insights |

Aggressiveness is injected into the review agent's nudge prompt as guidance. The agent interprets it.

**Session transcript access:**

The memory review agent needs session transcripts. OpenClaw stores transcripts as JSONL files in the agent's session directory. The `memory_review_context` source reads these files:

1. List session files modified today (or in the configured window)
2. Parse JSONL to extract assistant and user messages
3. Summarize/truncate long transcripts to fit context window
4. Present as structured sections: "Session 1 (agent: frontend, task: Fix login bug): [transcript]"

If transcripts are too large for the context window, the source summarizes older sessions and includes recent ones in full. Priority: most recent sessions get full transcripts.

**Interaction with existing systems:**

- Memories written by the review agent feed into the **retrieval tracking** system (Phase 8)
- Frequently-retrieved memories bubble up as **promotion candidates** (Phase 8)
- Manager reviews candidates in their reflection briefing and promotes to skills/SOUL.md (Phase 8)
- The full lifecycle: session → extraction → memory → retrieval tracking → promotion → skill

**Cost:**

At Sonnet pricing (~30 cents/session), a daily memory review costs ~30 cents per agent that has it enabled. For a 5-agent team where only the manager runs the review: 30 cents/day. For the review to cover all employees' sessions too (scope: reports), still one session, just more input — maybe 50 cents/day.

Users can see extraction cost in their budget dashboard and tune aggressiveness/model accordingly.

---

## Memory Config Type

```typescript
type MemoryGovernanceConfig = {
  instructions?: boolean | string;  // true = role default, string = custom, false = disable
  expectations?: boolean;           // true = role default expectations, false = none
  review?: {
    enabled?: boolean;
    cron?: string;
    model?: string;
    aggressiveness?: "low" | "medium" | "high";
    scope?: "self" | "reports" | "all";
  };
};
```

Added to `AgentConfig`:
```typescript
export type AgentConfig = {
  // ... existing fields ...
  memory?: MemoryGovernanceConfig;
};
```

---

## Architecture

```
Clawforce Memory Governance
├── Memory Instructions (prompt injection)
│   ├── Manager: search first, write decisions, use tools not memory.md
│   └── Employee: write via tools, learnings extracted automatically
│
├── Memory Expectations (compliance enforcement)
│   ├── Manager: must call memory_search ≥1 per session
│   └── Employee: none (not forced to interact)
│
├── Memory Review Job (daily extraction agent)
│   ├── Schedule: configurable cron (default 6pm)
│   ├── Model: configurable (default Sonnet)
│   ├── Scope: self / reports / all
│   ├── Aggressiveness: low / medium / high
│   ├── Input: session transcripts + SOUL.md + existing memories
│   └── Output: memories written to RAG via OpenClaw tools
│
└── Existing Phase 8 Pipeline
    ├── Ghost recall (per-turn, reader — already built)
    ├── Retrieval tracking (feeds promotion — already built)
    ├── Promotion pipeline (memory → skill/SOUL.md — already built)
    └── Demotion/flagging (wrong knowledge correction — already built)

OpenClaw Memory Infrastructure (delegated)
├── RAG vector store
├── memory_search / memory_get tools
├── memory/ directory storage
├── Embeddings (OpenAI, Gemini, Voyage, etc.)
└── memoryFlush timing (compaction thresholds)
```

## Files Changed

### Create
- `src/context/sources/memory-instructions.ts` — role-based memory instruction source
- `src/memory/review-context.ts` — session transcript assembly for review job
- `test/context/memory-instructions.test.ts`
- `test/memory/review-context.test.ts`

### Modify
- `src/types.ts` — add `MemoryGovernanceConfig`, add `memory?` to `AgentConfig`
- `src/presets.ts` — add `memory_review` job preset, add `memory_instructions` to briefing arrays, add memory_search expectation to manager
- `src/profiles.ts` — respect `memory.expectations` flag (strip memory expectations if false)
- `src/context/assembler.ts` — add `memory_instructions` and `memory_review_context` source cases
- `src/config-validator.ts` — validate memory governance config
- `src/project.ts` — parse `memory` config field, add to VALID_SOURCES
- `src/streams/builtin-manifest.ts` — register new sources
- `src/jobs.ts` — ensure memory_review job preset fields (sessionTarget, model) are forwarded to cron payload
- `src/index.ts` — export new modules and types

## Non-Goals

- Building a new memory storage system (OpenClaw owns this)
- Replacing ghost recall (already works as the reader)
- Automatic memory pruning/decay (future initiative)
- Cross-agent shared memory pools (future initiative)

## Dependencies

- Phase 8 complete (promotion/demotion pipeline) ✅
- OpenClaw memory tools accessible ✅
- **Session transcript access** — OpenClaw stores transcripts as JSONL. Internal APIs exist (`resolveSessionTranscriptsDirForAgent`, `listSessionFilesForAgent` in OpenClaw internals). Clawforce's adapter already uses internal OpenClaw imports (e.g., line 1043: `"openclaw/dist/plugin-sdk/agents/tools/memory-tool.js"`), so this pattern is possible but fragile. Verify import paths during implementation. Fallback: if transcripts are inaccessible, the review job logs a warning and skips extraction for that session.
