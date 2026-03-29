# Budget-Paced Event-Driven Dispatch Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace cron-based push dispatch with event-driven, budget-paced agent execution where leads wake on events + scheduled planning, workers loop through tasks, and budget pacing spreads spend across the day.

**Architecture:** New BudgetPacer component computes pacing recommendations from budget state. Event router gains `dispatch_agent` action type for event-driven wake. Workers get board visibility and session loop capability. All configurable via domain yaml with sensible defaults.

**Tech Stack:** TypeScript, SQLite (node:sqlite), vitest for testing. Existing ClawForce infrastructure (events, budget, dispatch, briefing assembly).

**Spec:** `docs/superpowers/specs/2026-03-29-budget-paced-event-dispatch-design.md`

---

## Chunk 1: Types + Budget Pacer

### Task 1: Extend DispatchConfig types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Write failing test for new types**

```typescript
// test/budget/pacer.test.ts
import { describe, it, expect } from "vitest";
import type { DispatchConfig, DispatchAgentAction } from "../../src/types.js";

describe("dispatch config types", () => {
  it("accepts budget_pacing config", () => {
    const config: DispatchConfig = {
      mode: "event-driven",
      budget_pacing: {
        enabled: true,
        reactive_reserve_pct: 20,
        low_budget_threshold: 10,
        critical_threshold: 5,
      },
    };
    expect(config.budget_pacing?.enabled).toBe(true);
  });

  it("accepts dispatch_agent action", () => {
    const action: DispatchAgentAction = {
      action: "dispatch_agent",
      agent_role: "lead",
      model: "sonnet",
      session_type: "reactive",
    };
    expect(action.action).toBe("dispatch_agent");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/budget/pacer.test.ts`
Expected: FAIL — types don't exist yet

- [ ] **Step 3: Add types to src/types.ts**

Add `DispatchAgentAction` type near the other action types (~line 795):

```typescript
export type DispatchAgentAction = {
  action: "dispatch_agent";
  agent_role: "lead" | "worker" | "verifier" | string;
  model?: string;
  session_type?: "reactive" | "active" | "planning";
  payload?: Record<string, unknown>;
};
```

Add to `EventActionConfig` union.

Extend `DispatchConfig` (~line 167) with:

```typescript
export type BudgetPacingConfig = {
  enabled?: boolean;
  reactive_reserve_pct?: number;
  low_budget_threshold?: number;
  critical_threshold?: number;
};

export type LeadScheduleConfig = {
  planning_sessions_per_day?: number;
  planning_model?: string;
  review_model?: string;
  wake_on?: string[];
};

export type WorkerDispatchConfig = {
  session_loop?: boolean;
  max_tasks_per_session?: number;
  idle_timeout_ms?: number;
  wake_on?: string[];
};
```

Add fields to `DispatchConfig`:

```typescript
mode?: "event-driven" | "cron" | "manual";
budget_pacing?: BudgetPacingConfig;
lead_schedule?: LeadScheduleConfig;
worker?: WorkerDispatchConfig;
verifier?: { wake_on?: string[] };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/budget/pacer.test.ts`
Expected: PASS

- [ ] **Step 5: Run full suite for regressions**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/types.ts test/budget/pacer.test.ts
git commit -m "feat: add dispatch config types — budget pacing, lead schedule, worker loop, dispatch_agent action"
```

---

### Task 2: Implement BudgetPacer

**Files:**
- Create: `src/budget/pacer.ts`
- Test: `test/budget/pacer.test.ts` (extend from Task 1)

- [ ] **Step 1: Write failing tests for BudgetPacer**

Add to `test/budget/pacer.test.ts`:

```typescript
import { computeBudgetPacing, type DispatchBudget } from "../../src/budget/pacer.js";

describe("BudgetPacer", () => {
  it("computes hourly rate from remaining budget and time", () => {
    const result = computeBudgetPacing({
      dailyBudgetCents: 40000,
      spentCents: 10000,
      hoursRemaining: 15,
      reactiveReservePct: 20,
    });
    // remaining = 30000, reserve = 6000, allocatable = 24000
    // hourlyRate = 24000 / 15 = 1600
    expect(result.hourlyRate).toBe(1600);
    expect(result.reactiveReserve).toBe(6000);
  });

  it("blocks lead dispatch when budget below critical threshold", () => {
    const result = computeBudgetPacing({
      dailyBudgetCents: 40000,
      spentCents: 38500, // 96.25% spent, below 5% critical
      hoursRemaining: 8,
      criticalThreshold: 5,
    });
    expect(result.canDispatchLead).toBe(false);
    expect(result.canDispatchWorker).toBe(false);
  });

  it("allows only reactive work at low budget threshold", () => {
    const result = computeBudgetPacing({
      dailyBudgetCents: 40000,
      spentCents: 37000, // 92.5% spent, below 10% low threshold
      hoursRemaining: 8,
      lowBudgetThreshold: 10,
    });
    expect(result.canDispatchLead).toBe(true); // reactive reviews OK
    expect(result.canDispatchWorker).toBe(false); // no new work
  });

  it("computes pace delay when burning too fast", () => {
    const result = computeBudgetPacing({
      dailyBudgetCents: 40000,
      spentCents: 10000,
      hoursRemaining: 15,
      currentHourSpentCents: 3000, // spent 3000 this hour
      reactiveReservePct: 20,
    });
    // hourlyRate = 1600, but already spent 3000 this hour → over pace
    expect(result.paceDelay).toBeGreaterThan(0);
  });

  it("returns zero pace delay when under budget rate", () => {
    const result = computeBudgetPacing({
      dailyBudgetCents: 40000,
      spentCents: 10000,
      hoursRemaining: 15,
      currentHourSpentCents: 500,
      reactiveReservePct: 20,
    });
    expect(result.paceDelay).toBe(0);
  });

  it("generates recommendation string", () => {
    const result = computeBudgetPacing({
      dailyBudgetCents: 40000,
      spentCents: 10000,
      hoursRemaining: 15,
    });
    expect(result.recommendation).toContain("$");
    expect(result.recommendation.length).toBeGreaterThan(0);
  });

  it("handles zero hours remaining", () => {
    const result = computeBudgetPacing({
      dailyBudgetCents: 40000,
      spentCents: 10000,
      hoursRemaining: 0,
    });
    expect(result.canDispatchLead).toBe(false);
    expect(result.canDispatchWorker).toBe(false);
  });

  it("handles fully spent budget", () => {
    const result = computeBudgetPacing({
      dailyBudgetCents: 40000,
      spentCents: 40000,
      hoursRemaining: 10,
    });
    expect(result.canDispatchLead).toBe(false);
    expect(result.canDispatchWorker).toBe(false);
    expect(result.hourlyRate).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/budget/pacer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement BudgetPacer**

Create `src/budget/pacer.ts`:

```typescript
export type BudgetPacingInput = {
  dailyBudgetCents: number;
  spentCents: number;
  hoursRemaining: number;
  currentHourSpentCents?: number;
  reactiveReservePct?: number;
  lowBudgetThreshold?: number;
  criticalThreshold?: number;
  leadSessionCostCents?: number;
  workerSessionCostCents?: number;
};

export type DispatchBudget = {
  hourlyRate: number;
  reactiveReserve: number;
  canDispatchLead: boolean;
  canDispatchWorker: boolean;
  paceDelay: number;
  recommendation: string;
};

export function computeBudgetPacing(input: BudgetPacingInput): DispatchBudget {
  const {
    dailyBudgetCents,
    spentCents,
    hoursRemaining,
    currentHourSpentCents = 0,
    reactiveReservePct = 20,
    lowBudgetThreshold = 10,
    criticalThreshold = 5,
    leadSessionCostCents = 1500,
    workerSessionCostCents = 30,
  } = input;

  const remaining = Math.max(0, dailyBudgetCents - spentCents);
  const remainingPct = dailyBudgetCents > 0 ? (remaining / dailyBudgetCents) * 100 : 0;
  const reserve = Math.floor(remaining * (reactiveReservePct / 100));
  const allocatable = remaining - reserve;
  const hourlyRate = hoursRemaining > 0 ? Math.floor(allocatable / hoursRemaining) : 0;

  const isCritical = remainingPct <= criticalThreshold;
  const isLow = remainingPct <= lowBudgetThreshold;
  const isExhausted = remaining <= 0 || hoursRemaining <= 0;

  const canDispatchLead = !isExhausted && !isCritical && remaining >= leadSessionCostCents;
  const canDispatchWorker = !isExhausted && !isCritical && !isLow && remaining >= workerSessionCostCents;

  let paceDelay = 0;
  if (hourlyRate > 0 && currentHourSpentCents > hourlyRate) {
    const overSpend = currentHourSpentCents - hourlyRate;
    const delayMinutes = Math.min(30, Math.ceil((overSpend / hourlyRate) * 60));
    paceDelay = delayMinutes * 60_000;
  }

  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  let recommendation: string;
  if (isExhausted) {
    recommendation = `Budget exhausted. ${fmt(spentCents)} spent of ${fmt(dailyBudgetCents)} daily.`;
  } else if (isCritical) {
    recommendation = `Critical: ${fmt(remaining)} remaining (${remainingPct.toFixed(1)}%). Verifier sessions only.`;
  } else if (isLow) {
    recommendation = `Low budget: ${fmt(remaining)} remaining (${remainingPct.toFixed(1)}%). Reactive work only — reviews and failure triage.`;
  } else {
    recommendation = `Budget healthy: ${fmt(remaining)} remaining. Rate: ${fmt(hourlyRate)}/hour. Reserve: ${fmt(reserve)} for reactive work.`;
  }

  return { hourlyRate, reactiveReserve: reserve, canDispatchLead, canDispatchWorker, paceDelay, recommendation };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/budget/pacer.test.ts`
Expected: All PASS

- [ ] **Step 5: Run full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/budget/pacer.ts test/budget/pacer.test.ts
git commit -m "feat: BudgetPacer — compute pacing from budget state"
```

---

## Chunk 2: Event Dispatch Action + Dispatcher Pacing Gate

### Task 3: Add dispatch_agent event action

**Files:**
- Modify: `src/events/actions.ts`
- Test: `test/events/dispatch-agent-action.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
// Test that executeAction handles "dispatch_agent" action type
// Mock enqueue to verify it's called with correct args
```

Test that when a `dispatch_agent` action fires:
- It resolves the agent by role (e.g., "lead" → find the team lead)
- It calls `enqueue()` with the resolved agent ID
- It passes model override in payload
- It returns a successful ActionResult

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement dispatch_agent action**

In `src/events/actions.ts`, add case to `executeAction()` switch and implement `executeDispatchAgent()`:
- Resolve agent by role from the event's project config
- Call `enqueue()` from dispatch/queue.ts
- Return `{ action: "enqueued", taskId, queueItemId }`

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: dispatch_agent event action — wire events to agent dispatch"
```

---

### Task 4: Add budget pacing gate to dispatcher

**Files:**
- Modify: `src/dispatch/dispatcher.ts`
- Test: `test/dispatch/budget-pacing.test.ts`

- [ ] **Step 1: Write failing tests**

Test that dispatcher:
- Blocks dispatch when `canDispatchWorker` is false (for workers)
- Blocks dispatch when `canDispatchLead` is false (for leads)
- Allows dispatch when pacing says OK
- Respects paceDelay (returns delay hint)
- Skips pacing check when `budget_pacing.enabled` is false

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement pacing gate**

In `dispatchItem()` in `src/dispatch/dispatcher.ts`, after emergency stop and agent disabled checks, add:

```typescript
// Budget pacing gate
const dispatchConfig = getExtendedProjectConfig(projectId)?.dispatch;
if (dispatchConfig?.budget_pacing?.enabled !== false) {
  const budget = getBudgetState(projectId, db);
  const pacing = computeBudgetPacing({
    dailyBudgetCents: budget.dailyLimit,
    spentCents: budget.dailySpent,
    hoursRemaining: getHoursRemainingInDay(),
    currentHourSpentCents: budget.hourlySpent,
    reactiveReservePct: dispatchConfig?.budget_pacing?.reactive_reserve_pct,
    lowBudgetThreshold: dispatchConfig?.budget_pacing?.low_budget_threshold,
    criticalThreshold: dispatchConfig?.budget_pacing?.critical_threshold,
  });

  const isWorker = agentConfig?.extends === "employee";
  if (isWorker && !pacing.canDispatchWorker) {
    failItem(item.id, "Budget pacing: worker dispatch blocked", db, projectId);
    return;
  }
  if (!isWorker && !pacing.canDispatchLead) {
    failItem(item.id, "Budget pacing: lead dispatch blocked", db, projectId);
    return;
  }
}
```

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Run full suite**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: budget pacing gate in dispatcher — pace spend across the day"
```

---

## Chunk 3: Budget Plan Briefing + Worker Board Visibility

### Task 5: Create budget_plan briefing source

**Files:**
- Create: `src/context/sources/budget-plan.ts`
- Modify: `src/context/assembler.ts` (add case)
- Test: `test/context/budget-plan.test.ts`

- [ ] **Step 1: Write failing test**

Test that `resolveBudgetPlanSource()`:
- Returns markdown with daily budget, spent, remaining
- Includes reserve calculation
- Includes worker session capacity
- Includes pipeline status (OPEN/ASSIGNED/REVIEW task counts)
- Includes recommendation string from BudgetPacer

- [ ] **Step 2: Implement source**

Create `src/context/sources/budget-plan.ts` following the pattern of existing sources (e.g., `budget-guidance.ts`). Query budget state, task counts, call `computeBudgetPacing()`, format as markdown.

- [ ] **Step 3: Register in assembler**

In `src/context/assembler.ts`, add case in `resolveSourceRaw()`:
```typescript
case "budget_plan":
  return resolveBudgetPlanSource(ctx.projectId, db);
```

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: budget_plan briefing source — leads see pacing recommendations"
```

---

### Task 6: Add board visibility to workers

**Files:**
- Modify: `src/presets.ts`
- Verify: `src/profiles.ts`

- [ ] **Step 1: Add task_board to employee briefing**

In `src/presets.ts`, employee preset briefing array:
```typescript
// Before:
briefing: ["soul", "assigned_task", "execution_standards"],
// After:
briefing: ["soul", "assigned_task", "execution_standards", "task_board"],
```

- [ ] **Step 2: Add budget_plan to manager briefing**

In `src/presets.ts`, manager preset briefing array, add `"budget_plan"` after existing budget sources.

- [ ] **Step 3: Verify employee tool access**

Check `src/profiles.ts` DEFAULT_ACTION_SCOPES for employee. Verify `clawforce_task: "*"` includes list and transition actions. If not, expand.

- [ ] **Step 4: Run full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: worker board visibility + lead budget plan briefing"
```

---

## Chunk 4: Config Normalization + Exports

### Task 7: Normalize new dispatch config fields

**Files:**
- Modify: `src/project.ts`
- Test: `test/config/dispatch-config.test.ts`

- [ ] **Step 1: Write failing tests**

Test that `loadWorkforceConfig()` correctly parses:
- `dispatch.mode` field
- `dispatch.budget_pacing.*` fields with defaults
- `dispatch.lead_schedule.*` fields
- `dispatch.worker.*` fields
- Missing fields get sensible defaults
- Invalid values are rejected or defaulted

- [ ] **Step 2: Implement normalization**

In `src/project.ts`, extend the dispatch config normalization to handle new fields. Apply defaults:
```typescript
mode: "event-driven",
budget_pacing: { enabled: true, reactive_reserve_pct: 20, low_budget_threshold: 10, critical_threshold: 5 },
lead_schedule: { planning_sessions_per_day: 3, planning_model: "opus", review_model: "sonnet", wake_on: ["task_review_ready", "task_failed", "dispatch_dead_letter", "budget_changed"] },
worker: { session_loop: true, max_tasks_per_session: 5, idle_timeout_ms: 300000, wake_on: ["task_assigned"] },
```

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Export new functions from index.ts**

Add `computeBudgetPacing` and `DispatchBudget` type to public exports.

- [ ] **Step 5: Run full suite**

Run: `npx tsc --noEmit && npx vitest run`

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: dispatch config normalization — defaults for budget pacing, lead schedule, worker loop"
```

---

## Chunk 5: Integration + Default Event Handlers

### Task 8: Wire default event handlers for event-driven mode

**Files:**
- Modify: `src/config/init.ts` or `src/project.ts`

- [ ] **Step 1: Add default event handlers when mode is event-driven**

When `dispatch.mode === "event-driven"`, inject default event handlers if the user hasn't configured their own:

```typescript
// Default event-driven dispatch handlers
const defaults = {
  task_review_ready: [{ action: "dispatch_agent", agent_role: "lead", session_type: "reactive" }],
  task_failed: [{ action: "dispatch_agent", agent_role: "lead", session_type: "reactive" }],
  task_assigned: [{ action: "dispatch_agent", agent_role: "worker", session_type: "active" }],
  budget_changed: [{ action: "dispatch_agent", agent_role: "lead", session_type: "planning" }],
};
```

User config overrides defaults (not merged — full replacement per event type).

- [ ] **Step 2: Test that defaults are applied**

- [ ] **Step 3: Test that user config overrides defaults**

- [ ] **Step 4: Run full suite**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: default event handlers for event-driven dispatch mode"
```

---

### Task 9: Emit budget_changed event

**Files:**
- Modify: `src/budget.ts` or wherever budget limits are set
- Modify: `src/cli.ts` (budget change from CLI)

- [ ] **Step 1: Emit budget_changed event when budget config changes**

When budget limits are updated (via config reload, CLI, or ops tool), emit:
```typescript
ingestEvent(projectId, "budget_changed", "system", {
  oldLimit: previousDaily,
  newLimit: newDaily,
}, `budget-changed:${Date.now()}`, db);
```

- [ ] **Step 2: Add budget_changed to known event types in types.ts**

- [ ] **Step 3: Test**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: emit budget_changed event on limit updates"
```

---

### Task 10: End-to-end integration test

**Files:**
- Test: `test/dispatch/event-driven-e2e.test.ts`

- [ ] **Step 1: Write E2E test**

Test the full flow:
1. Create a project with `dispatch.mode: "event-driven"` config
2. Create a task and assign it
3. Verify `task_assigned` event fires
4. Verify dispatch_agent action resolves the worker
5. Verify enqueue is called
6. Verify budget pacing is checked
7. Verify budget_plan briefing source returns valid markdown

- [ ] **Step 2: Run test**

- [ ] **Step 3: Run full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git commit -m "test: event-driven dispatch E2E — full flow from task assignment to paced dispatch"
```
