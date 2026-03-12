# Phase 8: Memory & Knowledge Lifecycle — Design

## Goal

Build a knowledge lifecycle: memories get tracked, frequently-used ones get promoted to structured knowledge, wrong knowledge gets flagged and corrected, and behavioral rules stay salient throughout sessions via periodic re-injection.

## Key Decisions

1. **Promotion targets are context-dependent** — Identity memories → SOUL.md, domain knowledge → skill topic, project knowledge → project docs. Manager decides target during reflection.
2. **Retrieval tracking via ghost turn hook** — The ghost turn already calls memory_search. Hook into results to count retrievals per memory. No extra LLM calls.
3. **Search query dedup via hash** — Before executing a memory search, check if the same query was already run this session. Skip if duplicate. Zero LLM cost.
4. **Ghost turn re-injects expectations every turn** — Rules injected at session start decay as context grows. The ghost turn (which already runs before each turn) re-injects compressed behavioral expectations. Pure string concatenation, no extra LLM cost.
5. **Demotion via explicit tool action** — `flag_knowledge` ops-tool action creates a review item. Agent flags wrong knowledge explicitly, manager reviews during reflection.
6. **Manager reviews promotions during reflection** — Promotion candidates surfaced in reflection briefing. No dedicated knowledge agent needed.
7. **Skill cap is configurable lint warning** — Soft cap per agent, not a hard gate. Warning in `clawforce lint` and manager briefing.
8. **Composable prompt layers** — Base (Clawforce-wide) → project → role → agent. Ghost turn pulls from these layers for re-injection. Future: users define cross-project base rules in global config.

## Architecture

### Retrieval Tracking

New `memory_retrieval_stats` table:

```sql
CREATE TABLE memory_retrieval_stats (
  memory_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  retrieval_count INTEGER NOT NULL DEFAULT 1,
  first_retrieved_at INTEGER NOT NULL,
  last_retrieved_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, project_id, agent_id)
);
```

**Hook point:** After `runGhostRecall()` or `runCronRecall()` returns results in the adapter's `before_prompt_build` hook, parse memory IDs from results and call `trackRetrieval()` for each.

**Data flow:**
1. Ghost turn executes memory_search → gets results
2. Parse memory IDs from result content (OpenClaw memory results include IDs)
3. Upsert into `memory_retrieval_stats` (increment count, update last_retrieved_at)
4. Continue with normal ghost turn flow (inject recalled memories)

### Search Query Dedup

New `memory_search_log` table:

```sql
CREATE TABLE memory_search_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  query_text TEXT NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

**Hook point:** In `runGhostRecall()` / `runCronRecall()`, before executing each `memory_search` call, hash the query and check `memory_search_log` for the same `(session_key, query_hash)`. Skip if found.

After executing a search, log it: `logSearchQuery(projectId, agentId, sessionKey, query, resultCount)`.

Index: `CREATE INDEX idx_search_log_session ON memory_search_log (session_key, query_hash)`.

### Ghost Turn Rule Re-injection

Extend the ghost turn's `prependContext` to include behavioral expectations alongside recalled memories.

**Source layers (composable):**
1. Agent's `expectations` config (already exists in presets)
2. Future: project-level rules, base Clawforce rules

**Format:** Compressed bullet points, injected as a `## Expectations Reminder` section.

**Config:**
```yaml
agents:
  frontend:
    ghost_recall:
      inject_expectations: true  # default true
```

**Implementation:** In the adapter's `before_prompt_build` hook, after ghost turn recall, also append the agent's expectations to `prependContext`. Pull expectations from the resolved agent config (already available in the hook).

### Promotion Pipeline

**Threshold:** Retrieved 10+ times across 5+ distinct sessions (configurable per project).

```yaml
knowledge:
  promotion_threshold:
    min_retrievals: 10
    min_sessions: 5
```

**Detection:** A function `checkPromotionCandidates(projectId)` queries `memory_retrieval_stats` for memories exceeding the threshold that aren't already in `promotion_candidates`. Creates candidates with a suggested target determined by heuristic:

- Content mentions agent name/identity/preferences → `soul`
- Content is domain-specific knowledge → `skill`
- Content is project-wide info → `project_doc`
- Default: `skill` (safest bet)

**Trigger:** Called during the manager's `reflect` job (or as a cron task). Not real-time — batch check during reflection.

**New `promotion_candidates` table:**

```sql
CREATE TABLE promotion_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  memory_content TEXT NOT NULL,
  retrieval_count INTEGER NOT NULL,
  session_count INTEGER NOT NULL,
  suggested_target TEXT NOT NULL,  -- 'soul' | 'skill' | 'project_doc'
  target_agent_id TEXT,            -- which agent's SOUL.md (null for project_doc)
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | dismissed
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
```

**Briefing source:** New `knowledge_candidates` context source showing pending promotions and knowledge flags. Added to manager's default reflection briefing.

### Promotion Execution

When manager calls `approve_promotion`:

1. Read the candidate record
2. Based on `suggested_target` (or manager override):
   - **soul** — Append to agent's SOUL.md file (`projects/<project>/agents/<agentId>/SOUL.md`). Create file if missing.
   - **skill** — Write a markdown file to project skills directory, register via `registerCustomSkills`.
   - **project_doc** — Append to `projects/<project>/knowledge/learnings.md`.
3. Mark candidate as `approved` with timestamp
4. Emit event for audit trail

New ops-tool actions: `approve_promotion`, `dismiss_promotion`

### Knowledge Demotion

**New `knowledge_flags` table:**

```sql
CREATE TABLE knowledge_flags (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  source_type TEXT NOT NULL,    -- 'soul' | 'skill' | 'project_doc'
  source_ref TEXT NOT NULL,     -- file path or topic name
  flagged_content TEXT NOT NULL,
  correction TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',  -- low | medium | high
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | resolved | dismissed
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
```

**Tool action:** `clawforce_ops flag_knowledge` — agent provides source_type, source_ref, flagged_content, correction, severity.

**Review:** Surfaced alongside promotion candidates in `knowledge_candidates` briefing source.

**Resolution:** Manager calls `resolve_flag` (applies correction to source) or `dismiss_flag` (marks as dismissed).

When resolving:
- **soul** — Edit the SOUL.md file, replace flagged content with correction
- **skill** — Update the skill topic file
- **project_doc** — Update the knowledge file

### Configurable Skill Cap

**Config:**
```yaml
agents:
  frontend:
    skill_cap: 8
```

**Defaults:**
- Manager preset: 12
- Employee preset: 8

**Warning surfaces:**
- `clawforce lint` — "Agent 'frontend' has 9 skills (cap: 8). Consider splitting into specialists."
- Manager reflection briefing — same warning in `knowledge_candidates` source
- Config validator — warning severity (not error, doesn't block activation)

**Counting:** `getTopicList(preset, projectId).length` — counts built-in topics for that preset + custom topics registered for the project.

## Config Format

```yaml
knowledge:
  promotion_threshold:
    min_retrievals: 10
    min_sessions: 5

agents:
  eng-lead:
    extends: manager
    skill_cap: 12
    ghost_recall:
      inject_expectations: true

  frontend:
    extends: employee
    skill_cap: 8
```

## Code Changes

### New files
- `src/memory/retrieval-tracker.ts` — trackRetrieval, checkPromotionCandidates
- `src/memory/search-dedup.ts` — logSearchQuery, isDuplicateQuery
- `src/memory/promotion.ts` — Promotion/demotion CRUD, execution (SOUL.md/skill/doc writes)

### Modified files
- `src/migrations.ts` — V26: memory_retrieval_stats, memory_search_log, promotion_candidates, knowledge_flags tables
- `src/types.ts` — PromotionCandidate, KnowledgeFlag types, KnowledgeConfig, skill_cap on AgentConfig
- `src/memory/ghost-turn.ts` — Hook retrieval tracking, search dedup, expectations re-injection
- `src/tools/ops-tool.ts` — flag_knowledge, approve_promotion, dismiss_promotion, resolve_flag, dismiss_flag actions
- `src/context/assembler.ts` — knowledge_candidates briefing source
- `src/project.ts` — Parse knowledge config, skill_cap
- `src/config-validator.ts` — Skill cap lint warning
- `src/presets.ts` — Default skill_cap per preset
- `src/skills/topics/memory.ts` — Updated documentation
- `src/index.ts` — Export new modules
- `adapters/openclaw.ts` — Hook retrieval tracking + expectations re-injection into before_prompt_build

## Testing Strategy

- Unit: retrieval tracking (upsert counts, threshold check)
- Unit: search dedup (hash match, skip duplicate, different session allows)
- Unit: expectations re-injection (format, config toggle)
- Unit: promotion candidate detection (threshold crossing)
- Unit: promotion execution (SOUL.md write, skill registration, project doc append)
- Unit: knowledge flag CRUD (create, resolve, dismiss)
- Unit: skill cap warning (under/over cap, lint output)
- Integration: ghost turn with retrieval tracking + dedup
- Integration: promotion pipeline end-to-end (retrieve → track → candidate → approve → written)
- Integration: demotion flow (flag → review → resolve → source updated)
