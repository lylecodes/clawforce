# Phase 7.4: Autonomous Scheduling — Design

## Goal

Coordination agents plan their own dispatch cadence. They create named dispatch plans, estimate costs, adjust their wake frequency, and reason about rate limit capacity. No new scheduler infrastructure — context + enforcement.

## Key Decisions

1. **Dispatch plans are first-class** — New `dispatch_plans` table. Plans are queryable, auditable, and show up in briefings. Coordination agent creates one per wake cycle.
2. **Agent-driven adaptive wake** — Coordination agent decides its own cron frequency during reflection, calls `job_update`. Configurable bounds are the safety net.
3. **Cost estimation uses fallback chain** — Initiative + agent + model (most precise), falls back to initiative + model, then initiative only, then global default. No precomputed stats table — query `cost_records` on the fly.
4. **Slot calculator gives concrete numbers** — System computes "you can start N more Opus sessions" from rate limits + active sessions + historical token usage. Agent gets answers, not raw data.
5. **Priority on goals (P1-P4)** — Separate from allocation. Allocation = how much to spend, priority = what order to work on.
6. **Ship all 7 features together** — They're more valuable as a coherent autonomous scheduling story than piecemeal.

## Architecture

### 1. Priority on Goals

Add `priority` field (P1-P4) to Goal type, matching the existing task priority enum. Tasks inherit priority from their linked goal if not explicitly set.

```typescript
export type Goal = {
  // ... existing fields ...
  priority?: "P1" | "P2" | "P3" | "P4";
};
```

Migration: `ALTER TABLE goals ADD COLUMN priority TEXT`

Dispatch ordering: when a coordination agent queries the task board, tasks are ordered by priority (P1 first). Goal priority cascades to tasks that don't have an explicit priority set.

### 2. Cost Averages Engine

Query function over `cost_records` with a fallback chain for precision:

```
getCostEstimate(projectId, initiativeId, agentId, model)
  → try: initiative + agent + model (≥3 sessions)
  → try: initiative + model (≥3 sessions)
  → try: initiative only (≥3 sessions)
  → fallback: global average across all sessions
  → fallback: hardcoded default (150 cents)
```

Returns `{ averageCents: number, sessionCount: number, confidence: "high" | "medium" | "low" }`.

- `high` = initiative + agent + model with ≥10 sessions
- `medium` = initiative + model or ≥3 sessions at any level
- `low` = global fallback or <3 sessions

No new table. Queries `cost_records` joined with `tasks` (for goal_id) and `goals` (for initiative tree). Results can be cached in-memory per coordination cycle since they don't change within a single wake.

### 3. Dispatch Plans

New `dispatch_plans` table:

```sql
CREATE TABLE dispatch_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',  -- planned, executing, completed, abandoned
  planned_items TEXT NOT NULL,  -- JSON array
  actual_results TEXT,          -- JSON array (filled on completion)
  estimated_cost_cents INTEGER NOT NULL DEFAULT 0,
  actual_cost_cents INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
```

Each planned item in the JSON array:

```typescript
type PlannedItem = {
  initiative_id?: string;
  agent_id: string;
  model?: string;
  task_title: string;
  estimated_cost_cents: number;
  confidence: "high" | "medium" | "low";
  priority: "P1" | "P2" | "P3" | "P4";
};
```

Actual results (filled when plan completes):

```typescript
type ActualResult = {
  planned_index: number;       // which planned item this corresponds to
  task_id?: string;            // the task that was created (null if skipped)
  actual_cost_cents?: number;
  status: "dispatched" | "skipped" | "failed";
  skip_reason?: string;
};
```

CRUD via ops-tool actions: `plan_create`, `plan_complete`, `plan_abandon`, `plan_list`.

Lifecycle:
1. Coordination agent wakes → creates plan with estimated items
2. Agent dispatches tasks per plan → status moves to `executing`
3. At end of cycle, agent completes plan → actual results filled in
4. Next cycle: previous plan visible in briefing for review

### 4. Cost Forecasting Briefing

New `cost_forecast` context source for coordination agents. Computed from cost averages + initiative spend + time remaining in day.

Output format:

```
## Cost Forecast

| Initiative      | Allocated | Spent  | Remaining | Burn Rate  | Exhausts At |
|-----------------|-----------|--------|-----------|------------|-------------|
| ui-improvements | $8.00     | $3.20  | $4.80     | $1.60/hr   | ~3:00 PM    |
| outreach        | $6.00     | $1.80  | $4.20     | $0.90/hr   | —           |
| Reserve         | $6.00     | $0.40  | $5.60     | —          | —           |

Avg session cost: UI/Opus $2.10 (high), UI/Sonnet $0.45 (medium), Outreach/Sonnet $0.38 (high)
```

Burn rate = today's spend / hours elapsed since first cost record today. Exhaustion = remaining / burn rate, shown only if projected to exhaust before midnight.

### 5. Pre-Dispatch Cost Estimation

When building a dispatch plan, each item gets `estimated_cost_cents` from the cost averages engine. The plan total = sum of estimates.

The coordination agent sees: "This plan costs ~$6.20 (3 UI/Opus @ $2.10 + 2 outreach/Sonnet @ $0.38). You have $8.40 remaining across initiatives."

No system enforcement on estimates — the hard gate on initiative allocation already blocks overspend. Estimates are for planning, not gating.

### 6. Adaptive Wake Frequency

Coordination agent adjusts its own cron schedule via existing `job_update` ops-tool action.

New config fields on manager preset:

```yaml
agents:
  eng-lead:
    extends: manager
    scheduling:
      adaptive_wake: true
      wake_bounds: ["*/15 * * * *", "*/120 * * * *"]  # fastest, slowest
```

Bounds enforcement in ops-tool: when `job_update` modifies a coordination agent's own wake job, validate the new cron expression falls within `wake_bounds`. If outside bounds, clamp to nearest bound.

The agent decides when to adjust based on:
- Pending task count
- Budget remaining vs time remaining in day
- Recent dispatch failures (rate limits, budget exhaustion)
- No pending work → sleep longer
- Lots of pending P1 tasks → wake more often

No system automation — the agent owns the decision. OODA framework already includes this kind of reasoning.

### 7. Rate-Aware Slot Calculator

System function that computes available dispatch slots:

```typescript
type SlotAvailability = {
  model: string;
  availableSlots: number;
  currentActive: number;
  rpmLimit: number;
  rpmUsed: number;
  tpmLimit: number;
  tpmUsed: number;
  avgTokensPerSession: number;
};

function getAvailableSlots(projectId: string): SlotAvailability[];
```

Computation:
1. Get rate limits from resource config (already in 7.2)
2. Count active sessions per model (from dispatch queue / active tasks)
3. Get average tokens per session from cost_records (per model)
4. Available slots = floor((rpmLimit - rpmUsed) / avgRpmPerSession) bounded by TPM similarly

Surfaced in briefing as:

```
## Available Capacity
- claude-opus-4-6: 2 slots (4/6 active, ~15k tok/session)
- claude-sonnet-4-6: 5 slots (3/8 active, ~8k tok/session)
```

## Config Format

All features ship as defaults on the manager preset:

```yaml
agents:
  eng-lead:
    extends: manager
    scheduling:
      adaptive_wake: true
      planning: true
      wake_bounds: ["*/15 * * * *", "*/120 * * * *"]
    briefing:
      - cost_forecast
      - available_capacity
      # initiative_status already in manager default
```

Users who don't want autonomous scheduling can disable:

```yaml
agents:
  eng-lead:
    extends: manager
    scheduling:
      adaptive_wake: false
      planning: false
```

## Code Changes

### New files
- `src/scheduling/cost-engine.ts` — Cost averages with fallback chain, slot calculator
- `src/scheduling/plans.ts` — Dispatch plan CRUD

### Modified files
- `src/types.ts` — Goal priority field, PlannedItem/ActualResult types, DispatchPlan type, scheduling config types
- `src/migrations.ts` — V25: goals priority column, dispatch_plans table
- `src/goals/ops.ts` — Priority field in rowToGoal, create, update
- `src/tools/goal-tool.ts` — Priority in schema
- `src/tools/ops-tool.ts` — Plan CRUD actions, wake bounds enforcement on job_update
- `src/context/assembler.ts` — cost_forecast and available_capacity source resolvers
- `src/dispatch/dispatcher.ts` — Task ordering by priority (goal-inherited)
- `src/profiles.ts` — Manager preset defaults for scheduling config
- `src/project.ts` — Parse scheduling config, validate wake_bounds
- `src/skills/topics/goals.ts` — Priority documentation
- `src/index.ts` — Export new modules

## Testing Strategy

- Unit: cost engine fallback chain (all levels + global default)
- Unit: cost engine confidence levels
- Unit: dispatch plan CRUD (create, complete, abandon)
- Unit: priority on goals (field addition, inheritance to tasks)
- Unit: slot calculator (various utilization levels)
- Unit: adaptive wake bounds enforcement
- Unit: cost forecast computation (burn rate, exhaustion time)
- Integration: coordination agent creates plan → dispatches → completes plan with actuals
- Integration: briefing shows cost forecast + available capacity
- Integration: task ordering respects goal priority
