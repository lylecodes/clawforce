# OpenClaw Capabilities Audit & Clawforce Thinning Plan

> Last updated: 2026-03-13

## Executive Summary

OpenClaw provides 24 hooks, 12+ runtime APIs, full channel messaging (7 channels), native cron management, memory tools, cost tracking, and compaction management. Clawforce uses only a fraction of this and **reimplements several systems OpenClaw already handles**.

This document maps every OpenClaw capability, identifies what Clawforce duplicates, and proposes a thinning plan to focus Clawforce on its unique governance value.

---

## What OpenClaw Provides (Full Inventory)

### Hooks (24 total — Clawforce uses 8)

| Hook | What it does | Clawforce uses? |
|------|-------------|-----------------|
| `before_model_resolve` | Override model/provider selection | No |
| `before_prompt_build` | Inject context, modify system prompt | **Yes** |
| `before_agent_start` | Combined pre-run setup | No |
| `llm_input` | Observe LLM request | No |
| `llm_output` | Capture LLM response + usage | **Yes** |
| `agent_end` | End of agent turn | **Yes** |
| `before_compaction` | Pre-compaction (message count, tokens, session file) | No |
| `after_compaction` | Post-compaction state | No |
| `before_reset` | Pre-reset lifecycle | No |
| `message_received` | Inbound message (channel-scoped) | No |
| `message_sending` | Pre-send interception (can cancel) | No |
| `message_sent` | Post-send confirmation | No |
| `before_tool_call` | Tool gate + blocking | **Yes** |
| `after_tool_call` | Tool execution monitoring | **Yes** |
| `tool_result_persist` | Modify tool result before storage | No |
| `before_message_write` | Filter/modify messages before storage | No |
| `session_start` | Session lifecycle begin | No |
| `session_end` | Session lifecycle end | No |
| `subagent_spawning` | Subagent spawn initiation | No |
| `subagent_delivery_target` | Subagent target routing | No |
| `subagent_spawned` | Subagent successful spawn | No |
| `subagent_ended` | Subagent termination | **Yes** |
| `gateway_start` | Gateway initialization | **Yes** |
| `gateway_stop` | Gateway shutdown | **Yes** |

### Runtime APIs

| API | What it does | Clawforce uses? |
|-----|-------------|-----------------|
| `registerTool()` | Register agent-callable tools | **Yes** |
| `on()` | Typed hook registration | **Yes** |
| `registerGatewayMethod()` | Register gateway RPC methods | **Yes** |
| `registerCommand()` | Register slash commands | **Yes** |
| `registerService()` | Register background service | **Yes** |
| `registerChannel()` | Register messaging channel adapter | No |
| `registerHttpRoute()` | Register HTTP routes | No |
| `registerCli()` | Register CLI subcommands | No |
| `registerProvider()` | Register AI model provider | No |
| `injectAgentMessage()` | Inject message into active session | **Yes** |
| `runtime.config.loadConfig()` | Load full OpenClaw config | **Yes** |
| `runtime.config.writeConfigFile()` | Write config to disk | **Yes** |
| `runtime.tools.createMemorySearchTool()` | RAG search tool factory | **Yes** |
| `runtime.tools.createMemoryGetTool()` | Memory retrieval tool | **Yes** |
| `runtime.channel.telegram.sendMessageTelegram()` | Send Telegram message | **Yes** |
| `runtime.system.loadProviderUsageSummary()` | Live rate limit data | **NOT EXPORTED** (Clawforce has TODO) |
| `runtime.system.enqueueSystemEvent()` | Queue system event | No |
| `runtime.system.requestHeartbeatNow()` | Wake heartbeat immediately | No |
| `runtime.events.onAgentEvent()` | Subscribe to agent lifecycle | No |
| `runtime.events.onSessionTranscriptUpdate()` | Subscribe to message updates | No |
| `runtime.state.resolveStateDir()` | Get plugin state directory | No |
| `runtime.logging.getChildLogger()` | Create scoped logger | No |

### Native Config Systems

| System | OpenClaw Config | Clawforce Reimplements? |
|--------|----------------|------------------------|
| **Compaction** | `compaction.memoryFlush` — enabled, softThresholdTokens, forceFlushTranscriptBytes, custom prompt/systemPrompt | **Yes** — flush-tracker.ts, ghost turn counting |
| **Cron** | Full system — create, list, update, disable, retry policy, failure alerts, session retention | **Partially** — CronJobRecord types, manager-cron.ts builder |
| **Exec Approvals** | Security levels (deny/allowlist/full), ask modes, allowlist persistence | **Yes** — separate SQLite proposal system (different abstraction) |
| **Subagent Config** | maxSpawnDepth, maxChildrenPerAgent, maxConcurrent, archiveAfterMinutes | **Partially** — safety config spawn depth |
| **Memory** | MemorySearchManager, vector RAG, memory search/get tools | **Wraps** + adds ghost recall, retrieval tracking, promotion/demotion |
| **Channels** | 7 channel adapters (Discord, Slack, Telegram, WhatsApp, Signal, iMessage, LINE) with full APIs | **Uses Telegram only** via direct API call |

---

## Thinning Plan

### Tier 1: Stop Reimplementing (High Impact, Low Risk)

#### 1.1 Memory Flush → Use OpenClaw's native `memoryFlush`

**Current:** Clawforce's `flush-tracker.ts` counts turns and triggers memory flush via `injectAgentMessage()`. Ghost turn system manages the timing.

**OpenClaw native:** `compaction.memoryFlush` config with:
- `enabled: boolean`
- `softThresholdTokens: number` (when to trigger)
- `forceFlushTranscriptBytes: number | string` (force at transcript size)
- `prompt: string` (custom flush prompt)
- `systemPrompt: string` (system prompt for flush turn)

**Action:**
- Remove Clawforce's flush-tracker.ts turn counting
- Configure OpenClaw's `memoryFlush` via agent defaults
- Keep Clawforce's ghost recall (adds unique LLM-based relevance triage) — this runs on `before_prompt_build`, not compaction
- Keep Clawforce's retrieval tracking and promotion/demotion (unique knowledge lifecycle)

**Risk:** Low — OpenClaw's system is more mature and configurable.

#### 1.2 Cron Type Duplication → Use OpenClaw's CronService directly

**Current:** Clawforce defines its own `CronJobRecord` type and `CronServiceLike` interface that mirror OpenClaw's cron system. `manager-cron.ts` wraps the captured cron service.

**OpenClaw native:** Full cron system via `context.cron` with create, list, update, disable, retry configuration, failure alerting, session retention policies.

**Action:**
- Remove Clawforce's `CronJobRecord` and `CronServiceLike` type redefinitions
- Import cron types from OpenClaw's plugin-sdk directly
- Keep `manager-cron.ts` orchestration logic (decides WHEN to schedule) but delegate the cron primitives to OpenClaw

**Risk:** Low — Clawforce already captures `context.cron` at gateway_start.

#### 1.3 Cost Capture → Use OpenClaw's cost system

**Current:** Clawforce captures `event.usage` from `llm_output` hook and records to its own `cost_records` table via `recordCostFromLlmOutput()`.

**OpenClaw native:** `loadSessionCostSummary()` and `loadCostUsageSummary()` provide cost data without manual capture.

**Action:**
- Stop capturing raw cost data from `llm_output` hook
- Read cost data from OpenClaw's cost APIs when needed (budget checks, forecasting)
- Keep Clawforce's budget enforcement, allocation, and forecasting (unique governance layer on top of cost data)

**Risk:** Medium — need to verify OpenClaw's cost APIs provide per-session granularity Clawforce needs for initiative tracking.

### Tier 2: Consolidate (Medium Impact, Medium Risk)

#### 2.1 Channel Messaging → Use OpenClaw's channel APIs

**Current:** Clawforce uses `sendMessageTelegram()` directly for approval notifications and has custom notifier setter patterns.

**OpenClaw native:** Full channel APIs for Discord, Slack, Telegram, WhatsApp, Signal, iMessage, LINE — all with consistent interfaces.

**Action:**
- Replace custom notifier setter pattern with direct `runtime.channel.*` API calls
- Support multi-channel notifications natively (not just Telegram)
- Keep Clawforce's channel routing logic (which agent gets which channel) but delegate message delivery to OpenClaw

**Risk:** Medium — need to verify channel APIs support the message formats Clawforce needs (inline buttons, polls, etc.).

#### 2.2 Leverage Unused Hooks

**Currently unused hooks that could improve Clawforce:**

| Hook | Could replace/improve |
|------|----------------------|
| `before_compaction` | Inject Clawforce-specific compaction instructions (currently done via context injection, which is less precise) |
| `after_compaction` | Track compaction events for audit/cost optimization |
| `session_start` / `session_end` | Replace manual session lifecycle tracking |
| `subagent_spawning` | Control subagent configuration before spawn (inject Clawforce context, enforce budget gates) |
| `message_received` | Channel-aware message routing without custom gateway methods |
| `message_sending` | Gate outbound messages (approval enforcement on communication actions) |

**Action:** Incrementally adopt useful hooks as Clawforce features need them. No big-bang migration.

### Tier 3: Request from OpenClaw (Blocked)

#### 3.1 Provider Usage Summary

Clawforce has a TODO: `loadProviderUsageSummary()` is not exported from the plugin-sdk public API. This would give real-time rate limit data for capacity planning.

**Action:** Request OpenClaw expose this in the next SDK release.

### Tier 4: Keep as Clawforce-Specific (No Change)

These are Clawforce's unique value — do NOT delegate to OpenClaw:

| System | Why it stays |
|--------|-------------|
| **Task lifecycle** (tasks/ops.ts, dispatch/) | Core governance: state machine, assignment, verification, compliance |
| **Policy engine** (enforcement/) | Expectations, compliance checking, retry/escalation logic |
| **Org model** (project.ts, org.ts) | Manager/employee hierarchy, reporting chains, departments |
| **Budget system** (budget.ts, scheduling/) | Cascading budgets, initiative allocation, cost forecasting |
| **Goal hierarchy** (goals/) | Decomposition, initiative tracking, completion cascade |
| **Approval workflows** (approval/) | Task-level proposals — different abstraction from OpenClaw's exec-level approvals |
| **Communication** (messaging/, channels/, meetings) | Structured protocols, agent DMs, meetings |
| **Trust evolution** (trust/) | Earned autonomy, progressive trust, tier adjustment |
| **Data streams** (streams/) | Catalog, parameterized sources, custom SQL, routing |
| **Config system** (config/) | Domain-based config, presets, inference, quality validation |
| **Knowledge lifecycle** (memory/promotion, memory/demotion) | Promotion/demotion pipeline, skill cap enforcement |

---

## Architecture After Thinning

```
┌─────────────────────────────────────────────────┐
│                  Clawforce                       │
│  (Governance Layer — Unique Value)               │
│                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Org Model│ │  Budget  │ │ Task Lifecycle   │ │
│  │ & Config │ │ & Cost   │ │ & Compliance     │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │  Trust   │ │  Goals   │ │ Communication    │ │
│  │Evolution │ │& Initiat.│ │ & Protocols      │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │  Data    │ │ Knowledge│ │ Ghost Recall     │ │
│  │ Streams  │ │Lifecycle │ │ & Retrieval Track│ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│                                                  │
│  ═══════════ Delegates to OpenClaw ════════════  │
│                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Memory   │ │  Cron    │ │ Channel Delivery │ │
│  │  Flush   │ │Primitives│ │ (7 channels)     │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │  Cost    │ │ Session  │ │ Compaction       │ │
│  │ Capture  │ │Lifecycle │ │ (native hooks)   │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
└─────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│                  OpenClaw                        │
│  (Runtime Platform — Plumbing)                   │
│                                                  │
│  24 hooks │ 7 channels │ Cron │ Memory RAG      │
│  Cost tracking │ Sessions │ Tools │ Config       │
└─────────────────────────────────────────────────┘
```

## Implementation Priority

1. **Now (during Phase 9):** Note thinning opportunities but don't refactor mid-phase
2. **Phase 10 or dedicated initiative:** Execute Tier 1 thinning (memory flush, cron types, cost capture)
3. **Phase 10+:** Execute Tier 2 consolidation (channels, hooks)
4. **Ongoing:** Request OpenClaw SDK exports as needed (Tier 3)
