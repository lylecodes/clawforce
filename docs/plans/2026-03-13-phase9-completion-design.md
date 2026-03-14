# Phase 9 Completion — Design Spec

> Last updated: 2026-03-13

## Overview

Complete the remaining Phase 9 (UX Overhaul) items from ROADMAP-v2.md. Dashboard (9.6) is deferred to a separate pass. Five items in scope:

- **9.1** Minimal viable config (role inference, smart defaults)
- **9.2** Interactive setup (finish CLI wizard)
- **9.4** Budget guidance (init-time + runtime)
- **9.8** Data streams (catalog, parameterized sources, custom SQL, multi-output routing)
- **9.9** Human onboarding (welcome, digest, intervention as manager briefing sources)

Items 9.3 (config quality feedback), 9.5 (config hot-reload), and 9.7 (cron schedule automation) are already complete.

---

## 9.1 — Minimal Viable Config

### Problem

Users must specify `extends: manager` or `extends: employee` for every agent, plus model, briefing sources, expectations, and performance policy. A minimal config shouldn't need any of that.

### Design

New `src/config/inference.ts` module:

**`inferPreset(agentId, allAgentDefs: Record<string, GlobalAgentDef>) → "manager" | "employee"`**

- Scans the full agent map to determine role from org structure
- `GlobalAgentDef` has `[key: string]: unknown`, so `reports_to` is accessible via index signature from raw YAML
- If any other agent def has `reports_to === agentId` → manager
- If this agent def has `reports_to` set → employee
- Neither → employee (standalone worker)
- Explicit `extends:` always wins — inference is the fallback

**Type change required:** `GlobalAgentDef.extends` in `src/config/schema.ts` must become optional (`extends?: string`). When omitted, inference supplies it. The validator (`validateGlobalConfig()`) already allows missing `extends` on agent defs — only the type definition needs updating.

**Integration point:** Called in `src/config/init.ts` inside `buildWorkforceConfig()`, before `resolveConfig()` is called. This is where `GlobalAgentDef` is converted to `AgentConfig` — the right place because it has access to the full agent map for a domain and `resolveConfig()` needs `extends` to merge presets.

```typescript
// In buildWorkforceConfig(), before resolveConfig():
for (const [agentId, def] of Object.entries(agentDefs)) {
  if (!def.extends) {
    def.extends = inferPreset(agentId, agentDefs);
  }
}
```

**Smart defaults applied by inferred preset:**
- Manager: model `opus`, full operational briefing (task_board, escalations, goals, budget, team_performance, cost_forecast, available_capacity), manager expectations, manager performance policy
- Employee: model `sonnet`, focused briefing (assigned_task, memory, skills, pending_messages), employee expectations, employee performance policy

**Inference tracking:** Track which agents were inferred via a separate `Map<string, boolean>` in the init module — not injected into the config object. Available to the quality validator for "role was auto-detected" warnings.

**Minimal working config:**
```yaml
agents:
  lead:
    title: Engineering Lead
  frontend:
    title: Frontend Dev
    reports_to: lead
  backend:
    title: Backend Dev
    reports_to: lead
```

No `extends:`, no model, no briefing — all inferred.

---

## 9.2 — Interactive Setup

### Problem

The programmatic wizard (`src/config/wizard.ts`) has `scaffoldConfigDir()` and `initDomain()` but no interactive flow. Since Clawforce runs as a Claude Code plugin, the "interactive" part is the agent driving a conversation — not a traditional TUI.

### Design

New `src/config/init-flow.ts`:

**`getInitQuestions() → InitQuestion[]`**

Returns a structured sequence of questions the agent asks the human:

1. **Domain name** (text) — "What should this domain be called?"
2. **Mission** (text) — "What's the mission? One sentence."
3. **Team composition** (structured) — "How many agents? Give me names and titles."
4. **Reporting structure** (structured) — "Who reports to whom?" (skip if only 1 agent)
5. **Budget** (number) — "Daily budget in dollars?" with guidance from 9.4
6. **Model preference** (choice) — "Use recommended models (Opus for managers, Sonnet for workers) or override?"

Each question has: `id`, `type` (text | choice | number | structured), `prompt`, `default`, `validate` function.

**`buildConfigFromAnswers(answers: InitAnswers) → { global: Partial<GlobalConfig>, domain: InitDomainOpts }`**

Takes collected answers and generates:
- `GlobalConfig` partial with agent definitions (using `[key: string]: unknown` for `reports_to`)
- `InitDomainOpts` matching the existing `initDomain()` signature (name, agents list, agentPresets map)
- Roles inferred from reporting structure (9.1) — no role questions needed
- Budget settings populated from 9.4 guidance

The function outputs types that feed directly into the existing wizard API — no adapter layer needed.

**Ops-tool integration:**

Two new actions on `clawforce_ops`:
- `init_questions` — returns the question sequence as structured data
- `init_apply` — takes answers, calls `buildConfigFromAnswers()`, then `scaffoldConfigDir()` + `initDomain()`

The agent drives the conversation naturally — asks questions, collects answers, calls `init_apply`. No TUI dependency.

---

## 9.4 — Budget Guidance

### Problem

Users set `dailyLimitCents: 2000` with no idea if that's enough. No guidance at init or runtime.

### Design

**Init-time guidance:** New `src/config/budget-guide.ts`:

**`estimateBudget(teamSize, modelChoices) → BudgetEstimate`**

```typescript
type BudgetEstimate = {
  recommended: number;    // cents
  low: number;            // cents (minimum viable)
  high: number;           // cents (comfortable headroom)
  breakdown: AgentCostEstimate[];
};

type AgentCostEstimate = {
  agentId: string;
  model: string;
  sessionsPerDay: number;
  costPerSession: number; // cents
  dailyCost: number;      // cents
};
```

- Default sessions/day: ~6 for managers (coordination cycles), ~4 for employees (task sessions)
- Cost per session: derived from model pricing
- **Pricing source:** Default model costs defined in `src/config/budget-guide.ts` as a `MODEL_COSTS` map. When available, overridden by user-configured `resources.models` from project metadata (same data `resolveAvailableCapacitySource` already reads). Unknown models fall back to Sonnet pricing with a warning.
- Returns a range so the init flow can say: "Recommended: $25/day ($15 low / $40 comfortable). Breakdown: lead (opus, ~6 sessions): $9/day, frontend (sonnet, ~4 sessions): $1.20/day"
- Init-time estimation has no catalog dependency — pure computation. Can be built before the stream system.

**Runtime guidance:** New `budget_guidance` briefing source in context assembler:

- Uses historical cost data when available (from cost engine), model estimates when fresh
- Content: "Budget supports ~12 employee sessions today. Utilization: 72%. At current velocity, exhausts by 3pm."
- Added to default manager reflection briefing sources
- Registered in stream catalog (9.8) when catalog is available

---

## 9.8 — Data Streams

### Problem

29+ context sources are hardcoded, non-parameterized, single-output (briefing only). No discoverability, no user customization, no routing to other targets.

### Design

New `src/streams/` module with four capabilities:

### 9.8.1 — Stream Catalog

`src/streams/catalog.ts`:

```typescript
type StreamDefinition = {
  name: string;
  description: string;
  params?: ParamSchema[];      // accepted parameters
  sampleOutput?: string;       // example output for docs
  builtIn: boolean;            // true for system sources, false for custom
  outputTargets: OutputTarget[]; // supported targets
};

type ParamSchema = {
  name: string;
  type: "string" | "number" | "boolean" | "string[]";
  description: string;
  default?: unknown;
  required?: boolean;
};
```

- `registerStream(def: StreamDefinition)` — adds to in-memory catalog registry
- `listStreams() → StreamDefinition[]` — returns full catalog
- `getStream(name) → StreamDefinition | undefined`
- New ops-tool action: `clawforce_ops streams` — lists available streams with descriptions

**Migration approach for existing sources:** The 29+ existing sources live as case branches in `resolveSource()` switch in `src/context/assembler.ts`, with helper functions in `src/context/sources/`. Rather than refactoring each into a self-registering module (too large a change), register them via a **catalog manifest** — a single `src/streams/builtin-manifest.ts` file that calls `registerStream()` for each existing source with its metadata (name, description, params). The actual resolution logic stays in the assembler switch. This gives discoverability without a rewrite.

### 9.8.2 — Parameterized Sources

Currently briefing sources are strings: `"cost_forecast"`. Parameterization adds:

```yaml
briefing:
  - source: cost_forecast
    params: { horizon: "8h", granularity: "per_initiative" }
  - source: task_board
    params: { status: ["OPEN", "BLOCKED"], limit: 20 }
```

**Type change required:** The `ContextSource` type in `src/types.ts` is a discriminated union where `source` is a string literal union. Two changes needed:

1. Add `params?: Record<string, unknown>` to `ContextSource`
2. For custom streams, add `"custom"` to the source literal union, with a new `streamName?: string` field:
   ```typescript
   // Existing sources keep working as-is. New custom stream form:
   { source: "custom", streamName: "stale_tasks", params: { ... } }
   ```

This avoids prefix conventions (`custom:stale_tasks`) and preserves type safety on the `source` union.

- Source resolvers gain an optional `params` argument
- Backward compatible — plain string sources still work (no params = defaults)
- Params validated against the catalog's parameter schema at config load time
- Assembler updated to pass params through when resolving sources

**Also fix:** Update `VALID_SOURCES` array in `src/config-validator.ts` to include the 11 missing sources (`pending_messages`, `goal_hierarchy`, `channel_messages`, `planning_delta`, `velocity`, `preferences`, `trust_scores`, `resources`, `initiative_status`, `cost_forecast`, `available_capacity`, `knowledge_candidates`) plus new ones added in this phase.

### 9.8.3 — Custom Computed Streams

Users define their own sources backed by read-only SQL:

```yaml
streams:
  stale_tasks:
    description: "Tasks open > 48 hours"
    query: >
      SELECT id, title, created_at FROM tasks
      WHERE status = 'OPEN' AND created_at < unixepoch() - 172800
    format: table
  high_cost_agents:
    description: "Agents spending > $5/day"
    query: >
      SELECT agent_id, SUM(total_cost_cents) as cost
      FROM sessions WHERE created_at > unixepoch() - 86400
      GROUP BY agent_id HAVING cost > 500
    format: table
```

`src/streams/custom.ts`:
- `executeCustomStream(dbPath, streamDef, params?) → StreamResult`
- **Read-only enforcement:** Opens a separate `DatabaseSync` connection with `{ readOnly: true }` (Node 22+ `node:sqlite` option). This is kernel-level enforcement — `DROP`, `INSERT`, `UPDATE`, `DELETE` all fail. Does NOT reuse the main writable `getDb()` connection.
- Results formatted as: `table` (text table for briefing), `json` (structured for webhooks/dashboard), `summary` (count + highlights)
- Custom streams registered in the catalog alongside built-in sources
- Can be used in briefing config: `{ source: "custom", streamName: "stale_tasks" }`
- SQL parameterization for user-supplied params via SQLite bindings (`?` placeholders), not string concatenation
- **Resource protection:** Custom queries get a hard `LIMIT 10000` appended if no LIMIT clause present, and a statement timeout via `AbortSignal` (5 second default, configurable) to prevent expensive queries from blocking the event loop

### 9.8.4 — Multi-Output Routing

Same stream, multiple destinations:

```yaml
routing:
  cost_alert:
    source: cost_forecast
    params: { horizon: "4h" }
    condition: "exhausts_within_hours < 4"
    outputs:
      - target: briefing
      - target: telegram
        channel: eng-alerts
      - target: webhook
        url: https://hooks.example.com/budget
  daily_summary:
    source: custom
    streamName: stale_tasks
    schedule: "0 18 * * *"
    outputs:
      - target: telegram
        channel: project-updates
      - target: log
```

`src/streams/router.ts`:
- `evaluateRoutes(db, routes, context) → RoutingResult[]`
- Evaluates conditions, fans out to output adapters

**Condition expression language** (`src/streams/conditions.ts`):

Uses the `filtrex` library (MIT, ~4KB, no deps) for safe expression evaluation rather than a custom parser. Filtrex compiles expressions to JS functions with a strict whitelist — no access to globals, prototypes, or arbitrary code execution. Supports:
- Comparisons: `<`, `>`, `<=`, `>=`, `==`, `!=`
- Boolean: `and`, `or`, `not`
- Property access: automatic from context object keys
- String literals: `status == "OPEN"`
- Arithmetic: `+`, `-`, `*`, `/`
- Built-in functions (optional whitelist): `abs`, `ceil`, `floor`, `round`, `min`, `max`

Context object is the stream result — a flat `Record<string, unknown>` produced by the stream resolver. Deep property access (`result.nested.field`) flattened to top-level keys before evaluation.

Output adapters:
- `briefing` — injects into assembler (existing path)
- `telegram` — sends via existing notification infrastructure (`resolveApprovalChannel` from `src/approval/channel-router.ts`, delivery callback registered via `setApprovalNotifier` in `src/approval/notify.ts`). The adapter uses the same setter pattern — actual Telegram API delivery is handled by OpenClaw's native messaging. If Telegram is not configured, falls back to `log`.
- `webhook` — HTTP POST with JSON payload (uses `fetch`)
- `log` — writes to audit trail (`createAuditEntry`)

**Router execution via existing job system:** Schedule-based routes are registered as jobs in the existing `src/jobs.ts` system (same mechanism as manager cron, employee cron). Not a parallel scheduling mechanism — reuses the existing infrastructure. Event-triggered routes wired into the existing event-action router (Phase 2.4). On-demand: callable via ops-tool `clawforce_ops route <name>`.

### Migration Strategy

The assembler (`src/context/assembler.ts`) currently owns source resolution. Migration is incremental:
1. Build the stream catalog and manifest alongside the assembler — catalog provides metadata, assembler still resolves
2. For parameterized sources: assembler checks for `params` and passes through to resolver functions
3. For `source: "custom"`: assembler delegates to the custom stream executor
4. Plain string sources continue through the existing switch — no big-bang rewrite
5. Over time (future phases), individual sources can be migrated from switch branches to self-registering modules

---

## 9.9 — Human Onboarding

### Problem

No guided first experience. System onboards agents but not the human.

### Design

Three new briefing sources, all surfaced through manager reflection cycles. The manager communicates findings to the human via Telegram/channels — no separate notification system needed.

**New file:** `src/context/sources/onboarding.ts`

### 9.9.1 — Welcome Context

`onboarding_welcome` briefing source:

- Fires when domain has been active < 24 hours (checks domain creation timestamp)
- Injected into the first manager reflection after activation
- Content: domain name, agent count, configured channels, checklist of first-cycle actions (verify configs, run test task, confirm channel routing)
- One-shot: after first reflection, returns empty. Tracks "welcome delivered" flag in DB.
- Manager naturally communicates status to human via configured channel

### 9.9.2 — Weekly Digest

`weekly_digest` briefing source:

- Fires once per week (tracks `last_digest_at` timestamp per project in DB)
- Aggregates for the period:
  - Tasks: completed, failed, blocked, total
  - Cost: total spend, budget utilization %, cost per initiative
  - Performance: top/bottom agents by completion rate
  - Escalation count and types
  - Initiative progress vs allocation
- First-week version includes onboarding-specific tips: "Consider adding skills to agents that struggled" / "Agents with no completions may need task reassignment"
- Manager summarizes and pushes to human via Telegram

### 9.9.3 — Guided Intervention

`intervention_suggestions` briefing source:

- Pattern detection over recent history (rolling 7-day window):
  - **Repeated failure**: agent failed same task type 3+ times → suggest adding a skill, splitting the agent, or reassigning
  - **Over-budget**: agent consistently exceeds cost estimates → suggest model downgrade or reduced task volume
  - **Idle agent**: no tasks completed in 48h → suggest reassignment or deactivation
  - **Initiative drift**: initiative spend/progress mismatch → flag for budget reallocation
- Returns structured suggestions with actionable options the manager can evaluate
- Manager decides — no auto-action. Suggestions are informational.
- Each suggestion includes a `dismiss` action so the same pattern isn't re-flagged after manager acknowledges it

**Performance note:** Pattern detection queries join `audit_runs` with `tasks` over a 7-day window. Add index: `CREATE INDEX IF NOT EXISTS idx_audit_runs_agent_ended ON audit_runs(agent_id, ended_at)` to support the agent-failure-pattern query efficiently.

### DB Changes

One new table for onboarding state tracking:

```sql
CREATE TABLE IF NOT EXISTS onboarding_state (
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,           -- 'welcome_delivered', 'last_digest_at', 'dismissed_interventions'
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, key)
);
```

Simple key-value per project (matching existing `getDb(projectId)` pattern) — avoids schema changes for each new onboarding feature.

---

## Architecture Summary

```
src/
  config/
    inference.ts        # 9.1 — role inference from org structure
    init-flow.ts        # 9.2 — structured init question flow
    budget-guide.ts     # 9.4 — budget estimation at init time
  streams/
    catalog.ts          # 9.8.1 — stream registry and discovery
    builtin-manifest.ts # 9.8.1 — catalog entries for existing 29+ sources
    params.ts           # 9.8.2 — parameter validation and resolution
    custom.ts           # 9.8.3 — custom SQL stream execution (read-only DB)
    router.ts           # 9.8.4 — multi-output routing engine
    conditions.ts       # 9.8.4 — condition evaluation via filtrex
  context/
    sources/
      onboarding.ts     # 9.9 — welcome, digest, intervention sources
```

Existing files modified:
- `src/config/schema.ts` — make `GlobalAgentDef.extends` optional
- `src/config/init.ts` — call `inferPreset()` in `buildWorkforceConfig()` when no extends
- `src/context/assembler.ts` — parameterized source support, custom stream delegation
- `src/tools/ops-tool.ts` — new actions: init_questions, init_apply, streams, route
- `src/config-validator.ts` — fix VALID_SOURCES (add 11 missing), validate parameterized sources and stream configs
- `src/migrations.ts` — new migration for onboarding_state table + audit_runs index
- `src/types.ts` — add `params` and `streamName` to ContextSource, new types for streams, routing, budget estimates, init flow
- `src/profiles.ts` — add budget_guidance and onboarding sources to manager defaults

## Dependency Order

1. **9.1 Minimal Config** — no dependencies, small, self-contained. Unblocks 9.2.
2. **9.4 Budget Guidance (init-time only)** — no dependencies, pure computation. Unblocks 9.2.
3. **9.2 Interactive Setup** — depends on 9.1 + 9.4 init-time.
4. **9.8.1 Stream Catalog + Builtin Manifest** — foundation for stream system.
5. **9.8.2 Parameterized Sources** — depends on catalog. Also fix VALID_SOURCES.
6. **9.8.3 Custom Streams** — depends on catalog.
7. **9.4 Budget Guidance (runtime source)** — registers in catalog.
8. **9.9 Human Onboarding** — registers in catalog, needs migration.
9. **9.8.4 Multi-Output Routing** — depends on catalog, params, output adapters.

## New Dependencies

- `filtrex` — safe expression evaluator for routing conditions (~4KB, MIT, no deps). Add as regular dependency, pin to exact version.

## Non-Goals

- Dashboard frontend (deferred — separate pass, drag-and-drop config editor vision)
- Session-end memory extraction (Phase 8 scope)
- Custom stream mutations (read-only DB connection enforced)
- Arbitrary JS in routing conditions (filtrex whitelist only)
- Refactoring existing assembler switch into self-registering modules (future phase)
