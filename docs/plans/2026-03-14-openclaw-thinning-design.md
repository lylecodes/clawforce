# OpenClaw Thinning Initiative — Design Spec

> Last updated: 2026-03-14

## Overview

Formalize the boundary between Clawforce (governance layer) and OpenClaw (runtime platform). Strip runtime config from Clawforce, delegate plumbing to OpenClaw primitives, keep governance control where OpenClaw can't do the job.

**Guiding principle:** Delegate when OpenClaw does the job. Keep Clawforce control when it doesn't.

**Architecture decision:** Clawforce is a governance/organizational layer that composes with OpenClaw agents. It does NOT own full agent definitions. OpenClaw owns runtime (model, tools, compaction mechanics). Clawforce owns organizational (title, reports_to, budget, expectations, trust, compliance).

---

## Part 1: Strip Runtime Config

### Problem

Clawforce's `GlobalAgentDef` and `AgentConfig` carry runtime fields (`model`, `provider`, `tools`, `compaction` thresholds) that belong in OpenClaw's agent config. Users would define agents in two places. Clawforce forwards these to OpenClaw at init — pure passthrough that adds complexity without value.

### Design

**Remove from `GlobalAgentDef`:** `model`, `provider`

**Remove from `AgentConfig`:** `model`, `provider`

**Keep on `AgentConfig`:**
- `persona` — organizational identity (injected via `before_prompt_build`)
- `channel` — organizational routing decision (where to send notifications)
- `tools` — stays because it serves a governance purpose: the skill-matched assignment strategy (`src/assignment/engine.ts`) uses `config.tools` to score agents against task tags. This is organizational (what the agent is capable of), not just runtime passthrough.
- `compaction` — Clawforce's `boolean | CompactionConfig` that controls *which files* to update. This is organizational (what to preserve for this agent's role). OpenClaw's compaction config handles *how* compaction works (thresholds, safeguard mode).

**Also remove:** `GlobalDefaults.model` from `src/config/schema.ts` — the fallback model application in `init.ts` becomes dead code. Model defaults belong in OpenClaw's agent defaults.

**Hard cut migration:** Fields are removed. Validation rejects `model` and `provider` with a clear error message: "model/provider are runtime config — set them in OpenClaw's agent config (~/.openclaw/ agents section), not Clawforce."

**When Clawforce needs runtime info** (cost estimation needs model name, capacity planning needs rate limits): read from OpenClaw via `api.runtime.config.loadConfig()` → `config.agents` → match by agent ID. New utility: `src/config/openclaw-reader.ts`.

### Affected Presets

The `BUILTIN_AGENT_PRESETS` in `presets.ts` currently don't set `model` or `tools` — they're already clean. No preset changes needed.

The `applyProfile()` function in `profiles.ts` may reference these fields — needs audit and cleanup.

---

## Part 2: Memory Flush

### Problem

Clawforce's `flush-tracker.ts` counts agent turns and triggers memory flush via `injectAgentMessage()`. OpenClaw has native `memoryFlush` with token-based thresholds (better than turn counting). But OpenClaw's flush prompt is global-only — no per-agent customization.

### Design

**Delete:** Turn counting logic from `flush-tracker.ts`.

**Delegate to OpenClaw:** Flush timing. OpenClaw's `agents.defaults.compaction.memoryFlush` handles when to trigger (softThresholdTokens, forceFlushTranscriptBytes).

**Keep in Clawforce:** Per-agent flush prompt injection via `injectAgentMessage()`. When a flush is needed, Clawforce builds a per-agent prompt based on the agent's `CompactionConfig.files` targets (e.g., "Update SOUL.md with learnings, review task log"). This stays because OpenClaw's prompt config is global-only — can't customize per agent.

**Net result:** Clawforce's flush code shrinks from turn counting + timing + prompt to just prompt generation. Timing delegated to OpenClaw.

### Configuration

Clawforce sets OpenClaw's global memoryFlush to enabled during init:

```typescript
// During gateway_start, ensure memoryFlush is enabled in OpenClaw config
agents.defaults.compaction.memoryFlush.enabled = true;
```

Clawforce's per-agent flush prompt fires via `injectAgentMessage()` at the appropriate time — triggered by OpenClaw's lifecycle (the existing `agent_end` hook or a new integration point when flush is needed).

**Future:** When OpenClaw adds per-agent compaction config, migrate the prompt injection to native config. Contribute this upstream.

---

## Part 3: Cost Data

### Problem

Clawforce captures `event.usage` from `llm_output` hook, calculates cost via `pricing.ts` (its own pricing table), and writes to `cost_records`. OpenClaw already computes cost data natively via `loadSessionCostSummary()` and `loadCostUsageSummary()`.

### Design

**Keep as fallback:** `pricing.ts` — retains the `BUILTIN_PRICING` table and `calculateCostCents()` as fallback when OpenClaw's cost API is unavailable. Note: `pricing.ts` already dynamically loads from OpenClaw's model registry via `registerBulkPricing()` at gateway_start — the hardcoded table is only a fallback. No deletion needed; it's already integrated.

**Modify:** `cost.ts` — Primary path: read cost from OpenClaw's `loadSessionCostSummary()` after each session. Fallback path: existing `llm_output` usage-based calculation via `pricing.ts` (if API unavailable).

**Keep:** `cost_records` table and `daily_spent_cents` counter. Budget enforcement needs O(1) access to daily spend — can't query OpenClaw's API on every dispatch gate (hot path).

**Keep:** `recordCost()` function signature — callers don't change. The implementation changes from "calculate from tokens" to "read from OpenClaw."

**Integration point:** The `agent_end` hook already fires after each session. Clawforce already uses it for compliance. Add cost recording here: call `loadSessionCostSummary()` for the ended session, record to `cost_records`.

**Fallback:** If `loadSessionCostSummary()` is unavailable or returns no data, fall back to the existing `llm_output` usage-based calculation via `pricing.ts`. This keeps the system robust.

**Hard prerequisite:** Verify that `loadSessionCostSummary()` is accessible from plugin context during implementation. It appears in OpenClaw's exported types but is not currently called anywhere in Clawforce. If inaccessible, this part defers entirely and the existing `llm_output` + `pricing.ts` path remains primary.

**Note:** `JobDefinition.model` and `PlannedItem.model` are kept — these are governance-level overrides (a job or plan item specifying which model to use for a task). They feed into `openclaw-reader.ts` and the dispatch payload, not into agent config. The model value flows from OpenClaw's agent config by default; job/plan overrides are intentional governance decisions.

---

## Part 4: Cron Types

### Problem

Clawforce defines `CronJobRecord` and `CronServiceLike` interfaces that mirror OpenClaw's cron system types.

### Design

**Delete:** Clawforce's type redefinitions.

**Import:** Cron types from OpenClaw's plugin-sdk directly.

**Keep:** `manager-cron.ts` orchestration logic — it decides when and why to schedule (governance). The cron primitives it calls (`context.cron.add()`, `.list()`, `.update()`) are already OpenClaw's.

---

## Part 5: Channel Delivery

### Problem

Clawforce uses `sendMessageTelegram()` directly and has three custom notifier setter patterns (`setApprovalNotifier` in `src/approval/notify.ts`, `setChannelNotifier` in `src/channels/notify.ts`, `setMessageNotifier` in `src/messaging/notify.ts`). OpenClaw has full channel APIs for 7 channels.

### Design

**Replace:** Custom notifier pattern with direct `runtime.channel.*` API calls.

**Support:** Multi-channel delivery natively. An agent configured with `channel: "slack"` gets notifications via `runtime.channel.slack.sendMessageSlack()`. Today only Telegram works.

**Keep:** Clawforce's channel routing logic (`resolveApprovalChannel`) — the decision of which channel to use per agent is organizational.

**New:** `src/channels/deliver.ts` — thin adapter that takes `(channel, message, target)` and dispatches to the correct `runtime.channel.*` API. Replaces the setter pattern.

---

## Part 6: OpenClaw Config Reader

### Problem

After stripping runtime fields, Clawforce needs to read model/tools info from OpenClaw when needed (cost estimation, capacity planning, slot calculation).

### Design

**New module:** `src/config/openclaw-reader.ts`

```typescript
getAgentModel(agentId: string): string | null
getAgentTools(agentId: string): string[] | null
getModelPricing(model: string): { inputPer1M: number, outputPer1M: number } | null
getProviderRateLimits(provider: string): { rpm: number, tpm: number } | null
```

**Implementation:** Calls `api.runtime.config.loadConfig()` (cached per session, refreshed on config change). Reads from `config.agents.list[]` for per-agent settings, `config.agents.defaults` for fallbacks, `config.models.providers[]` for pricing and rate limits.

**Used by:** Cost engine (model name for estimation), capacity sources (rate limits), budget guide (model costs), slot calculator.

---

## Architecture After Thinning

```
Clawforce (Governance)
├── Org Model: title, reports_to, department, team, persona
├── Task Lifecycle: state machine, assignment, verification, compliance
├── Budget: enforcement, allocation, cascading, forecasting
├── Policy: expectations, performance, enforcement actions
├── Trust: evolution, earned autonomy, tier adjustment
├── Goals: hierarchy, initiatives, completion cascade
├── Communication: protocols, meetings, channels (routing)
├── Data Streams: catalog, params, custom SQL, routing
├── Knowledge: ghost recall, retrieval tracking, promotion/demotion
├── Compaction: per-agent file targets, flush prompt generation
├── Config: organizational schema, presets, inference, validation
│
├── Reads from OpenClaw (via openclaw-reader.ts):
│   ├── Agent model/tools (for cost estimation)
│   ├── Model pricing (for budget guidance)
│   └── Provider rate limits (for capacity planning)
│
└── Delegates to OpenClaw:
    ├── Memory flush timing (native memoryFlush thresholds)
    ├── Cost computation (loadSessionCostSummary)
    ├── Cron primitives (CronService)
    ├── Channel delivery (runtime.channel.*)
    └── Compaction mechanics (thresholds, safeguard mode)
```

## Files Changed

### Delete
- Turn counting logic from `src/memory/flush-tracker.ts` (keep prompt generation)
- `CronJobRecord` / `CronServiceLike` type redefinitions (in `src/manager-cron.ts` AND `adapters/openclaw.ts`)

### Create
- `src/config/openclaw-reader.ts` — cached reader for OpenClaw agent runtime config. Cache strategy: load once at gateway_start, invalidate on config watcher reload event. Used on warm paths (cost estimation, capacity), not hot paths (dispatch gates use own counters).
- `src/channels/deliver.ts` — multi-channel delivery adapter via `runtime.channel.*`

### Modify
- `src/config/schema.ts` — remove `model`, `provider` from `GlobalAgentDef`; remove `model` from `GlobalDefaults`
- `src/types.ts` — remove `model`, `provider` from `AgentConfig`; keep `tools`, `compaction`, `persona`, `channel`
- `src/config/init.ts` — remove `global.defaults.model` fallback application; stop forwarding model/provider to OpenClaw
- `src/config-validator.ts` — reject `model`/`provider` runtime fields with migration error message
- `src/cost.ts` — primary path: read cost from `loadSessionCostSummary()`; fallback: existing `llm_output` + `pricing.ts`
- `src/pricing.ts` — keep as fallback infrastructure; already dynamically loads from OpenClaw
- `src/scheduling/cost-engine.ts` — use `openclaw-reader.ts` for model info
- `src/scheduling/slots.ts` — use `openclaw-reader.ts` for rate limits
- `src/context/assembler.ts` — capacity/cost sources use openclaw-reader
- `src/approval/notify.ts` — replace setter pattern with `deliver.ts`
- `src/approval/channel-router.ts` — use `deliver.ts` for multi-channel
- `src/messaging/notify.ts` — replace setter pattern with `deliver.ts`
- `src/channels/notify.ts` — replace setter pattern with `deliver.ts` (if exists)
- `src/manager-cron.ts` — import cron types from OpenClaw
- `adapters/openclaw.ts` — stop syncing model in `buildOpenClawAgentEntry()`, remove inline `CronServiceLike` redefinition
- `src/agent-sync.ts` — remove `config.model` read from `buildOpenClawAgentEntry()` (model no longer on AgentConfig)
- `src/events/router.ts` — read model for dispatch payloads via `openclaw-reader.ts` instead of `agentEntry.config.model`
- `src/profiles.ts` — remove `model` references from profile application
- `src/presets.ts` — verify no model/provider defaults (currently clean)
- `src/index.ts` — update re-exports (remove CronServiceLike, update notifier exports)

### Tests to Update
- Any test that sets `model` on AgentConfig or GlobalAgentDef
- Cost recording tests (new data source)
- Channel notification tests (new delivery mechanism)
- Config validation tests (new rejection of runtime fields)

## Non-Goals

- Dashboard (separate initiative, deferred)
- Budget system v2 / scalability hardening (separate initiative, next priority)
- Contributing per-agent compaction config upstream to OpenClaw (follow-up)
- Adopting unused hooks like `before_compaction`, `after_compaction`, `session_start/end` (considered and deferred — these are incremental improvements that don't require architectural design. Adopt them individually as features need them.)
- Renaming/restructuring `CompactionConfig` type to clarify governance vs runtime boundary (nice-to-have, not blocking)

## Dependencies

- OpenClaw `loadSessionCostSummary()` must be accessible from plugin context (verify during implementation)
- OpenClaw `runtime.channel.*` APIs must support the message formats Clawforce needs (inline buttons, polls — verify during implementation)
- If either dependency is blocked, fall back to existing implementation for that subsystem
