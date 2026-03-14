# Budget System v2 — Design Spec

> Last updated: 2026-03-14

## Overview

Enterprise-grade budget system for Clawforce. Three budget dimensions (cents, tokens, requests) enforced across time windows (hourly, daily, monthly). Counter-based O(1) enforcement for time windows; session/task limits remain per-record checks (bounded scope). Pre-flight plan validation with soft reservations. Multi-day forecasting for manager reasoning. Scales from $50/day solo to $50k/day enterprise.

**Guiding principle:** Budget enforcement is Clawforce's competitive moat. No other agent framework does this. Design for the most mature, enterprise-ready solution.

---

## Part 1: Dual Budget Schema

### Problem

Current system is cents-only with O(n) table scans for hourly/monthly checks. No token budgets. No request counting. Doesn't scale past ~$1k/day.

### Design

**Three budget dimensions:**
- `cents` — dollar cost control ("don't spend more than $100/day")
- `tokens` — capacity control ("don't exceed 5M tokens/day regardless of model pricing")
- `requests` — request-rate control ("max 500 API calls/day" for flat-rate or per-request providers)

Each dimension is independent. Any dimension can gate dispatch. "Under budget but over token quota" is a valid block.

**Five time windows:** hourly, daily, monthly, session, task. Each window has limits and counters for all three dimensions.

**BudgetConfigV2 type (new):**

```typescript
type BudgetWindowConfig = {
  cents?: number;
  tokens?: number;
  requests?: number;
};

type BudgetConfigV2 = {
  hourly?: BudgetWindowConfig;
  daily?: BudgetWindowConfig;
  monthly?: BudgetWindowConfig;
  session?: BudgetWindowConfig;
  task?: BudgetWindowConfig;
};
```

**Old `BudgetConfig` preserved** with `@deprecated` tag. Adapter function `normalizeBudgetConfig(old: BudgetConfig | BudgetConfigV2) → BudgetConfigV2` maps flat fields to nested:
```typescript
// { dailyLimitCents: 5000 } → { daily: { cents: 5000 } }
```
Called at config load time. All internal code uses `BudgetConfigV2`. Old configs work without changes.

**YAML config:**

```yaml
budget:
  daily: { cents: 10000, tokens: 5000000 }
  hourly: { cents: 2000, tokens: 1000000 }
  monthly: { cents: 200000 }
```

All fields optional. Old configs (`dailyLimitCents: 5000`) continue to work via migration mapping.

**Database schema (new columns on `budgets` table):**

```sql
-- Cost counters (daily already exists, add hourly + monthly)
hourly_limit_cents    INTEGER,
hourly_spent_cents    INTEGER NOT NULL DEFAULT 0,
monthly_limit_cents   INTEGER,
monthly_spent_cents   INTEGER NOT NULL DEFAULT 0,

-- Token counters (all new)
hourly_limit_tokens   INTEGER,
hourly_spent_tokens   INTEGER NOT NULL DEFAULT 0,
daily_limit_tokens    INTEGER,
daily_spent_tokens    INTEGER NOT NULL DEFAULT 0,
monthly_limit_tokens  INTEGER,
monthly_spent_tokens  INTEGER NOT NULL DEFAULT 0,

-- Request counters (all new)
hourly_limit_requests  INTEGER,
hourly_spent_requests  INTEGER NOT NULL DEFAULT 0,
daily_limit_requests   INTEGER,
daily_spent_requests   INTEGER NOT NULL DEFAULT 0,
monthly_limit_requests INTEGER,
monthly_spent_requests INTEGER NOT NULL DEFAULT 0,

-- Window boundaries (daily_reset_at exists, add hourly + monthly)
hourly_reset_at       INTEGER,
monthly_reset_at      INTEGER,

-- Reservation hold (new)
reserved_cents        INTEGER NOT NULL DEFAULT 0,
reserved_tokens       INTEGER NOT NULL DEFAULT 0,
reserved_requests     INTEGER NOT NULL DEFAULT 0
```

**Cost recording update:** `recordCost()` increments all active counters atomically:
- `hourly_spent_cents += costCents`
- `daily_spent_cents += costCents`
- `monthly_spent_cents += costCents`
- Same for tokens (input + output + cache) and requests (+1)

**Backward compatibility:** Existing `dailyLimitCents`, `sessionLimitCents`, `taskLimitCents` columns remain. The old `checkBudget()` path reads these. New `checkBudgetV2()` reads the expanded schema. Migration maps old → new. Both paths work during transition.

**Migration note:** `hourly_limit_cents` and `monthly_limit_cents` already exist from migration V23. The new migration must use `safeAlterTable()` for those two columns to handle the "duplicate column name" error gracefully. All other columns are genuinely new.

**DispatchPlan type update:** Add `estimatedTokens` to both `PlannedItem` and `DispatchPlan` types alongside existing `estimatedCostCents`. Pre-flight validation checks both.

---

## Part 2: Lazy Reset Mechanism

### Problem

Daily reset requires manual `resetDailyBudgets()` call. If nobody calls it, counters accumulate forever. Hourly and monthly resets don't exist at all.

### Design

**Self-healing lazy reset:** Every budget read checks if the window has elapsed. If so, reset inline before returning.

```typescript
function ensureWindowsCurrent(budget: BudgetRow, now: number): void {
  let dirty = false;

  if (budget.hourly_reset_at && now >= budget.hourly_reset_at) {
    budget.hourly_spent_cents = 0;
    budget.hourly_spent_tokens = 0;
    budget.hourly_spent_requests = 0;
    budget.hourly_reset_at = getNextHourBoundary(now);
    dirty = true;
  }

  if (now >= budget.daily_reset_at) {
    budget.daily_spent_cents = 0;
    budget.daily_spent_tokens = 0;
    budget.daily_spent_requests = 0;
    budget.daily_reset_at = getNextMidnightUTC(now);
    dirty = true;
  }

  if (budget.monthly_reset_at && now >= budget.monthly_reset_at) {
    budget.monthly_spent_cents = 0;
    budget.monthly_spent_tokens = 0;
    budget.monthly_spent_requests = 0;
    budget.monthly_reset_at = getNextMonthBoundaryUTC(now);
    dirty = true;
  }

  if (dirty) persistBudgetReset(budget);
}
```

**Properties:**
- No cron dependency — resets happen naturally on first access after window boundary
- Self-healing — even if system was down for hours, first check catches up
- **Serialized via conditional UPDATE** — uses `WHERE hourly_reset_at = ? AND hourly_reset_at <= ?` so only one process wins the reset in concurrent scenarios. Clawforce uses `DatabaseSync` (synchronous) but multiple agent sessions can interleave. The conditional UPDATE ensures idempotent reset.
- All three dimensions reset together per window
- Slight latency on first check after boundary (one extra DB write) — negligible
- **Reservations are NOT reset on window boundaries** — reservations represent active plan holds and persist until plan completes/abandons. See Part 3 for reservation cleanup.

---

## Part 3: Pre-flight Validation + Soft Reservations

### Problem

Dispatch plans estimate costs but don't validate total fits in budget before starting. No reservation mechanism — other dispatches can steal budget mid-plan.

### Design

**Pre-flight check:** Before a plan transitions to `executing`:

```typescript
function validatePlanBudget(plan: DispatchPlan, projectId: string): ValidationResult {
  const budget = getCurrentBudget(projectId); // triggers lazy reset
  const remaining = {
    cents: (budget.daily_limit_cents ?? Infinity) - budget.daily_spent_cents - budget.reserved_cents,
    tokens: (budget.daily_limit_tokens ?? Infinity) - budget.daily_spent_tokens - budget.reserved_tokens,
  };

  if (plan.estimated_cost_cents > remaining.cents) {
    return { ok: false, reason: `Plan costs ~$${(plan.estimated_cost_cents/100).toFixed(2)}, $${(remaining.cents/100).toFixed(2)} remaining` };
  }
  if (plan.estimated_tokens > remaining.tokens) {
    return { ok: false, reason: `Plan uses ~${plan.estimated_tokens} tokens, ${remaining.tokens} remaining` };
  }
  return { ok: true };
}
```

**Soft reservation:** On plan start:
```sql
UPDATE budgets SET
  reserved_cents = reserved_cents + ?,
  reserved_tokens = reserved_tokens + ?
WHERE project_id = ? AND agent_id IS NULL
```

Other dispatches see reduced available budget: `available = limit - spent - reserved`.

**Per-item settlement:** As each plan item completes:
1. Actual cost/tokens recorded to spent counters (existing `recordCost()` path)
2. Reservation reduced by the item's estimated amount:
```sql
UPDATE budgets SET
  reserved_cents = MAX(0, reserved_cents - ?),
  reserved_tokens = MAX(0, reserved_tokens - ?)
```

**Plan completion/abandonment:** Release remaining reservation immediately.

**Properties:**
- Reservations are advisory (help managers plan)
- Per-item dispatch gate is still enforced (hard stop)
- If actual < estimated: budget freed naturally as items settle
- If actual > estimated: dispatch gate catches overruns, reservation was optimistic but harmless
- `MAX(0, ...)` prevents negative reservations from rounding

**Crash recovery:** If a process crashes mid-plan, reserved amounts would be permanently locked. Fix: dispatch plans have `started_at` timestamps. The existing periodic sweep service checks for plans in `executing` state older than a configurable TTL (default: 4 hours). Stale plans are force-abandoned, releasing reservations. Mirrors existing stuck-agent detection pattern.

**Reservation window scoping:** Reservations use a single set of counters (not per-window). When hourly resets, `hourly_spent_*` zeroes but `reserved_*` stays — correct, the plan is still running. The remaining calculation `limit - spent - reserved` naturally handles this.

**Pre-flight checks daily window only** — deliberate simplification. Per-item dispatch gate enforces hourly/monthly. Pre-flight is optimistic; per-item is exact.

---

## Part 4: Enhanced Forecasting

### Problem

Current budget guidance shows single-day burn rate only. Enterprise managers need trend data for strategic decisions.

### Design

**New module:** `src/budget/forecast.ts`

Three levels of forecasting data, computed from `cost_records` history:

**Daily snapshot** (`computeDailySnapshot()`):
- Per-dimension utilization % (cents, tokens, requests)
- Sessions remaining (average cost per session)
- Exhaustion ETA (current burn rate extrapolated)
- Per-initiative breakdown with allocation vs spend

**7-day trend** (`computeWeeklyTrend()`):
- Daily spend average with direction (up/down/stable %)
- Per-initiative velocity vs allocation
- Token utilization trend
- Cost-per-task trend (efficiency metric)

**30-day projection** (`computeMonthlyProjection()`):
- Projected monthly total at current trajectory
- Days until monthly budget exhaustion
- Per-initiative projection vs allocation

**Integration:** The existing `budget_guidance` briefing source (shipped in Phase 9) calls these functions and formats the output for manager reflection. The manager agent reasons about the data — no hardcoded recommendation logic in the budget system.

**Query performance:** Aggregations run against `cost_records` (GROUP BY date, initiative). Called once per manager reflection cycle (every 30+ minutes), not on the dispatch hot path. Acceptable at enterprise scale.

**Types:**

```typescript
type DailyBudgetSnapshot = {
  cents: { limit: number; spent: number; reserved: number; remaining: number; utilization: number };
  tokens: { limit: number; spent: number; reserved: number; remaining: number; utilization: number };
  requests: { limit: number; spent: number; reserved: number; remaining: number; utilization: number };
  sessionsRemaining: number;
  exhaustionEta: Date | null;
  initiatives: Array<{
    id: string;
    name: string;
    allocation: number;
    spent: { cents: number; tokens: number };
    utilization: number;
  }>;
};

type WeeklyTrend = {
  dailyAverage: { cents: number; tokens: number; requests: number };
  direction: { cents: "up" | "down" | "stable"; tokens: "up" | "down" | "stable" };
  changePercent: { cents: number; tokens: number };
  perInitiative: Array<{
    id: string;
    name: string;
    dailyAverage: number;
    allocation: number;
    overUnder: number;
  }>;
};

type MonthlyProjection = {
  projectedTotal: { cents: number; tokens: number };
  monthlyLimit: { cents: number | null; tokens: number | null };
  exhaustionDay: number | null;
  perInitiative: Array<{
    id: string;
    projectedTotal: number;
    allocation: number;
    onTrack: boolean;
  }>;
};
```

---

## Part 5: Cascading Budget Improvements

### Problem

Current cascading only works for daily cents. Doesn't handle tokens, requests, or hourly/monthly windows.

### Design

Extend `allocateBudget()` to support all dimensions and windows:

```typescript
type BudgetAllocation = {
  projectId: string;
  parentAgentId: string;
  childAgentId: string;
  daily?: BudgetWindowConfig;   // { cents?, tokens?, requests? }
  hourly?: BudgetWindowConfig;
  monthly?: BudgetWindowConfig;
};
```

**Validation:** At allocation time, for each dimension in each window:
```
sum(all children's allocations for dimension) <= parent's limit for dimension
```

If parent has `daily.cents: 10000` and allocates `3000` to child A and `4000` to child B, the next allocation can be at most `3000`.

**Unallocated remainder** = parent's own operational budget (coordination cycles, reflection).

**No transitive validation:** A→B→C allocations are independent. B's allocation to C is validated against B's limit, not A's. This keeps the system simple and matches how real org budgets work (each manager owns their allocation).

**ops-tool update:** `allocate_budget` action extended:
```typescript
// Existing
parent_agent_id, child_agent_id, daily_limit_cents

// v2
parent_agent_id, child_agent_id, allocation_config (JSON with daily/hourly/monthly × cents/tokens/requests)
```

Backward compatible — old `daily_limit_cents` param still works, mapped to `{ daily: { cents: value } }`.

---

## Part 6: Budget Enforcement Flow

### Pre-dispatch gate (updated)

The dispatch gate becomes:

```
1. Lazy-reset all windows (ensureWindowsCurrent)
2. For each active window (hourly, daily, monthly):
   a. Check cents: spent + reserved >= limit → BLOCK
   b. Check tokens: spent + reserved >= limit → BLOCK
   c. Check requests: spent + reserved >= limit → BLOCK
3. Check session/task limits (if applicable)
4. Check initiative allocation (if task has goal with allocation)
5. Check cost circuit breaker (1.5x multiplier, all dimensions)
```

Any single dimension in any single window can block dispatch. The gate returns the specific reason: "Daily token budget exceeded (4.8M / 5M)".

**Performance:** All checks are O(1) reads from the `budgets` table counters. No `cost_records` scans on the hot path.

---

## Part 7: Provider Rate Limits

### Not part of the budget system

Provider rate limits (RPM, TPM, 5-hour rolling windows, per-tier caps) are handled separately:

- **Proactive:** Existing `isProviderThrottled()` checks utilization before dispatch
- **Reactive:** 429 responses trigger backoff/retry
- **Visibility:** Provider utilization surfaced in manager briefing via `available_capacity` source

Clawforce does not model provider-specific rate limit schemes. It observes utilization and throttles when hot.

When OpenClaw exposes `loadProviderUsageSummary()` in the plugin-sdk, Clawforce will read from that instead of tracking its own counters. Until then, the existing `src/rate-limits.ts` path stays.

---

## Architecture

```
Budget Enforcement (hot path, O(1))
├── checkBudgetV2()
│   ├── ensureWindowsCurrent() — lazy reset
│   ├── Per-window checks (hourly/daily/monthly)
│   │   ├── cents: spent + reserved < limit
│   │   ├── tokens: spent + reserved < limit
│   │   └── requests: spent + reserved < limit
│   ├── Session/task limits
│   ├── Initiative allocation check
│   └── Circuit breaker (1.5x)
│
├── recordCostV2() — atomic counter increment
│   ├── hourly_spent_{cents,tokens,requests} += delta
│   ├── daily_spent_{cents,tokens,requests} += delta
│   └── monthly_spent_{cents,tokens,requests} += delta
│
└── Plan reservation
    ├── reserveBudget() — on plan start
    ├── settlePlanItem() — per-item actual vs estimated
    └── releasePlanReservation() — on complete/abandon

Budget Planning (warm path, called per reflection)
├── computeDailySnapshot()
├── computeWeeklyTrend()
├── computeMonthlyProjection()
└── budget_guidance briefing source

Budget Allocation
├── allocateBudget() — parent→child, all dimensions
├── validateAllocation() — sum(children) <= parent
└── getBudgetStatus() — per-agent breakdown
```

## Files Changed

### Create
- `src/budget/forecast.ts` — trend analysis and projection computation
- `src/budget/reset.ts` — lazy reset logic
- `src/budget/reservation.ts` — plan reservation lifecycle
- `src/budget/check-v2.ts` — new enforcement gate with all dimensions
- `test/budget/forecast.test.ts`
- `test/budget/reset.test.ts`
- `test/budget/reservation.test.ts`
- `test/budget/check-v2.test.ts`

### Modify
- `src/types.ts` — new `BudgetConfig`, `BudgetWindowConfig` types
- `src/migrations.ts` — new migration adding columns to `budgets` table
- `src/cost.ts` — `recordCost()` increments all window counters + tokens + requests
- `src/budget.ts` — `setBudget()` supports new schema, `checkBudget()` delegates to v2
- `src/budget-windows.ts` — replaced by `check-v2.ts` (delete or thin wrapper)
- `src/budget-cascade.ts` — extended for all dimensions
- `src/dispatch/dispatcher.ts` — use `checkBudgetV2()` instead of separate daily + multi-window checks
- `src/scheduling/plans.ts` — pre-flight validation + reservation lifecycle
- `src/context/sources/budget-guidance.ts` — call forecast module for richer data
- `src/tools/ops-tool.ts` — extend `allocate_budget` action with new params
- `src/safety.ts` — extend circuit breaker to check all dimensions (currently daily cents only)
- `src/budget-windows.ts` — callers (`budget-guidance.ts`, ops-tool `introspect`) updated to use new check functions
- `src/goals/ops.ts` — consider adding `goal_id` index on `cost_records` for efficient initiative forecasting

### Backward Compatibility
- Old `BudgetConfig` preserved with `@deprecated` tag. New `BudgetConfigV2` used internally.
- `normalizeBudgetConfig()` adapter maps old flat fields to new nested structure at config load.
- Old `checkBudget()` signature preserved — delegates to `checkBudgetV2()` for time windows, keeps existing O(n) path for session/task limits (bounded scope, acceptable).
- Existing tests pass without changes — old `BudgetConfig` type still valid, adapter handles mapping.

## Non-Goals

- Provider rate limit modeling (reactive, not proactive)
- Automatic budget recommendations (manager agent reasons)
- Multi-currency support (cents = universal, users convert)
- Real-time budget dashboard (separate dashboard initiative)

## Dependencies

- Phase 9 complete (budget_guidance source exists) ✅
- Thinning complete (clean architecture) ✅
- No OpenClaw dependencies (budget is fully Clawforce-owned)
