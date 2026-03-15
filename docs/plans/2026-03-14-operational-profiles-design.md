# Operational Profiles — Design Spec

> Last updated: 2026-03-14

## Overview

Abstracted operational levels (low/medium/high/ultra) that configure all operational knobs with a single choice. Includes cost preview engine and smart recommendation based on team size and budget. Users pick a level and everything works — or override individual settings for fine-tuning.

**Principle:** Users shouldn't need to understand 20+ config knobs. Pick a level, see the cost, go. Power users override anything they want.

---

## Profile Definitions

| Setting | Low | Medium | High | Ultra |
|---------|-----|--------|------|-------|
| Manager session | Isolated (fresh per wake) | Main (8h persistent) | Main (24h, 1M context) | Main (24h, Opus) |
| Coordination frequency | Every 2h | Every 30m | Every 15m | Every 10m |
| Manager model (recommended) | Haiku | Sonnet | Sonnet | Opus |
| Employee model (recommended) | Haiku | Haiku | Sonnet | Sonnet |
| Memory review | Weekly (Sunday 6pm) | Daily (6pm) | Daily + mid-day (12pm, 6pm) | Every session end |
| Memory aggressiveness | low | medium | high | high |
| Ghost recall intensity | low (90s cooldown, 2 searches) | medium (30s, 3 searches) | high (10s, 4 searches) | high (10s, 4 searches) |
| Memory expectations | None | Manager: search min 1 | Manager: search min 1 | Manager: search min 2 |
| Standup | None | Daily (9am) | Daily + afternoon (9am, 2pm) | 3x daily (9am, 12pm, 4pm) |
| Reflection | Weekly (Friday 9am) | Weekly (Friday 9am) | Twice weekly (Wed, Fri 9am) | Daily (6pm) |
| Adaptive wake | Off | On (30m-120m bounds) | On (15m-120m bounds) | On (10m-60m bounds) |
| Compaction | Off | On (employee default files) | On (all agents, custom files) | On (all agents, aggressive) |
| Session reset | N/A (isolated) | After 8h inactivity | Nightly (11:59pm) | Nightly (11:59pm) |
| Estimated ops cost | ~$5/day | ~$25/day | ~$80/day | ~$200+/day |

---

## Config

### Domain-level

```yaml
# Pick a level — sets all defaults
operational_profile: medium

# Override anything
memory:
  review:
    cron: "0 12,18 * * *"   # override just this
scheduling:
  adaptive_wake: false        # override just this
```

### Type

```typescript
type OperationalProfile = "low" | "medium" | "high" | "ultra";

type OperationalProfileConfig = {
  profile: OperationalProfile;
  // All fields below are auto-set by profile but user can override any
  coordination: {
    sessionTarget: "isolated" | "main";
    sessionPersistHours?: number;
    cronSchedule: string;
    adaptiveWake: boolean;
    wakeBounds?: [string, string];
  };
  memory: {
    reviewSchedule: string;
    reviewAggressiveness: "low" | "medium" | "high";
    ghostRecallIntensity: "low" | "medium" | "high";
    expectations: boolean;
  };
  meetings: {
    standupSchedule?: string;
    reflectionSchedule: string;
  };
  models: {
    managerRecommended: string;
    employeeRecommended: string;
  };
  sessionReset?: {
    enabled: boolean;
    schedule?: string;
  };
};
```

---

## Expansion Logic

New module: `src/profiles/operational.ts`

### `expandProfile(profile: OperationalProfile) → OperationalProfileConfig`

Expands a profile name to the full config. Pure function, no side effects.

### `applyProfileToAgents(profile: OperationalProfileConfig, agents: Record<string, AgentConfig>, domain: DomainConfig) → void`

Applies the profile's settings to all agents in the domain:

1. **Manager agents** get:
   - Coordination job updated: `sessionTarget`, `cron`, `wakeMode`
   - Reflection job added/updated with profile schedule
   - Standup job added/updated (if profile has standups)
   - Memory review job added/updated with profile schedule + aggressiveness
   - Memory expectations set/stripped based on profile
   - Session reset job added (for High/Ultra)

2. **Employee agents** get:
   - Ghost recall intensity set
   - Memory instructions updated
   - Compaction settings applied

Profile settings are applied as **defaults** — any explicit agent config overrides the profile. Same inheritance pattern as presets.

### `normalizeDomainProfile(domain: DomainConfig, global: GlobalConfig) → DomainConfig`

Called during `initializeAllDomains()`. If `domain.operational_profile` is set:
1. Expand profile to full config
2. Apply to all agents in the domain (respecting per-agent overrides)
3. Return the enriched domain config

**Important:** `normalizeDomainProfile` is a **pure config transformation** — it expands the profile into agent config fields and job definitions. It does NOT register cron jobs. Cron registration happens downstream in the adapter layer (`adapters/openclaw.ts`) via `registerManagerCron()`, which already reads jobs from agent config and registers them with OpenClaw's cron service. The profile expansion just ensures the right jobs exist in the config before the adapter processes them.

---

## Cost Preview Engine

New module: `src/profiles/cost-preview.ts`

### `estimateProfileCost(profile, agents) → ProfileCostEstimate`

```typescript
type CostBucket = {
  name: string;           // "Management" | "Execution" | "Intelligence"
  totalCents: number;
  items: CostLineItem[];
};

type CostLineItem = {
  label: string;          // "CEO coordination (Sonnet × 6 cycles)"
  cents: number;
};

type ProfileCostEstimate = {
  profile: OperationalProfile;
  dailyCents: number;
  monthlyCents: number;
  buckets: CostBucket[];
  fitsInBudget: boolean;
  headroomCents: number;
  headroomPercent: number;
};
```

**Calculation:**

For each agent, based on profile + role:

**Management bucket:**
- Manager coordination: `cycles_per_day × cost_per_cycle`
  - Cycles: 24h / coordination_interval (e.g., 30m = 48, but bounded by session hours)
  - Cost per cycle: uses MODEL_COSTS from budget-guide.ts (Opus: 150¢, Sonnet: 30¢, Haiku: 8¢ per session). A "coordination cycle" is one session. For multi-turn persistent sessions (High/Ultra), each coordination wake is NOT a new session — it's a continuation. Cost is based on incremental tokens per wake (~2-5k tokens), estimated at roughly 20% of a fresh session cost. The cost preview engine should define `CYCLE_COST_MULTIPLIER` per profile: isolated sessions = 1.0x MODEL_COSTS, persistent sessions = 0.2x MODEL_COSTS per wake.
- Standup: `participants × cost_per_turn` (each turn = one dispatch)
- Reflection: `cost_per_session / frequency` (amortized daily)

**Execution bucket:**
- Employee sessions: `sessions_per_day × cost_per_session`
  - Default 4 sessions/day per employee
  - Cost from MODEL_COSTS based on recommended model

**Intelligence bucket:**
- Memory review: `cost_per_review × reviews_per_day`
- Ghost recall: `cost_per_triage × turns_per_day` (Haiku triage, ~$0.02/turn)
- Briefing assembly: `tokens_per_session × sessions × cost_per_token` (input token overhead)

### `recommendProfile(teamSize, budgetCents, agentRoles?) → ProfileRecommendation`

```typescript
type ProfileRecommendation = {
  recommended: OperationalProfile;
  reason: string;
  allProfiles: Array<{
    profile: OperationalProfile;
    estimatedCents: number;
    fitsInBudget: boolean;
    headroomPercent: number;
  }>;
};
```

Logic:
1. Estimate cost for each profile level
2. Filter to profiles that fit within budget (with at least 30% headroom for actual task work)
3. Pick the highest profile that fits
4. If none fit: recommend Low with a warning

Example output:
```
Recommended: MEDIUM
Reason: "Fits your $150/day budget with 70% headroom for tasks.
        High would cost ~$80/day (47% headroom — tight for 10 agents)."

All profiles:
  Low:    $5/day   ✓ (97% headroom)
  Medium: $25/day  ✓ (83% headroom) ← recommended
  High:   $80/day  ✓ (47% headroom)
  Ultra:  $200/day ✗ (exceeds budget)
```

---

## Init Wizard Integration

The existing init flow (`src/config/init-flow.ts`) adds a new question after budget:

```typescript
{
  id: "operational_profile",
  type: "choice",
  prompt: "Pick an operational level",
  description: "Controls how intensively your agents coordinate, remember, and communicate.",
  choices: ["low", "medium", "high", "ultra"],
  // Dynamic: show cost preview per choice, highlight recommended
}
```

`getBudgetGuidance()` updated to include profile recommendation when team composition and budget are known.

`buildConfigFromAnswers()` updated to include `operational_profile` in domain config.

---

## Manager Session Lifecycle (High/Ultra)

For profiles with persistent sessions (`sessionTarget: "main"`):

### Jobs generated by profile expansion:

```typescript
// Coordination job (all profiles)
coordination: {
  extends: "triage",
  cron: "*/30 * * * *",        // from profile
  sessionTarget: "main",        // High/Ultra only
  wakeMode: "next-heartbeat",   // High/Ultra only
}

// Memory review (isolated — reads transcripts from main session)
memory_review: {
  extends: "memory_review",
  cron: "0 18 * * *",          // from profile
  sessionTarget: "isolated",    // always isolated
}

// Session reset (High/Ultra only)
session_reset: {
  cron: "59 23 * * *",
  sessionTarget: "main",
  nudge: "End of day. Your session will reset. Key learnings have been extracted by the memory review job.",
  // Regular daily cron, not deleteAfterRun — runs every night at 11:59pm
}

// Standup (Medium+)
standup: {
  cron: "0 9 * * MON-FRI",
  sessionTarget: "isolated",    // meeting runs in its own session
}

// Reflection (all profiles)
reflection: {
  extends: "reflect",
  cron: "0 9 * * FRI",         // from profile
}
```

### Daily cycle (High profile):

```
8:00 AM  — Fresh main session starts (ghost recall loads yesterday's memories)
8:15 AM  — First coordination cycle (injects into main session)
9:00 AM  — Standup meeting (isolated session, transcript shared)
9:15-5:45 — Coordination cycles every 15m (all in main session)
6:00 PM  — Memory review fires (isolated, reads today's transcripts)
11:59 PM — Session reset job ends main session
           Next morning: fresh session, cycle repeats
```

---

## Files Changed

### Create
- `src/profiles/operational.ts` — profile definitions, expansion, application
- `src/profiles/cost-preview.ts` — cost estimation, three-bucket breakdown, recommendation
- `test/profiles/operational.test.ts`
- `test/profiles/cost-preview.test.ts`

### Modify
- `src/types.ts` — add `OperationalProfile`, `OperationalProfileConfig`, `ProfileCostEstimate`, etc.
- `src/config/schema.ts` — add `operational_profile` to `DomainConfig`
- `src/config/init.ts` — call `normalizeDomainProfile()` during initialization
- `src/config/init-flow.ts` — add profile question, add `operational_profile` to `InitAnswers` type, update `buildConfigFromAnswers`
- `src/config/wizard.ts` — add `operational_profile` to `InitDomainOpts` for domain scaffolding
- `src/config/budget-guide.ts` — integrate profile recommendation into `getBudgetGuidance()`
- `src/config-validator.ts` — validate `operational_profile` field
- `src/index.ts` — export new modules

### Backward Compatibility
- `operational_profile` is optional. Domains without it work exactly as before.
- All profile settings can be overridden per-agent.
- No breaking changes to existing configs.

## Non-Goals
- Custom profile definitions (user-defined profiles beyond the 4 levels) — future
- Per-agent profile overrides (agent-level profiles vs domain-level) — future
- Auto-adjusting profile based on performance (e.g., "you're running Low but your agents keep failing, consider Medium") — future but interesting

## Dependencies
- Memory governance complete ✅ (memory review job, instructions, expectations)
- Budget v2 complete ✅ (cost engine, forecasting)
- Phase 7.4 complete ✅ (scheduling, adaptive wake, dispatch plans)
- Ghost recall intensity presets already exist in ghost-turn.ts ✅
