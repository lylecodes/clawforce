# Budget-Paced Event-Driven Dispatch

> Replace cron-based push dispatch with event-driven, budget-paced agent execution.

## Problem

ClawForce dispatches agents via OpenClaw's cron service — a hack that creates one-shot
scheduled jobs for immediate execution. This causes:

1. **Cron capture fragility** — cron service must be "captured" from a gateway RPC context.
   If bootstrap fails, entire dispatch pipeline breaks.
2. **No budget pacing** — system dispatches freely until budget hits zero, then hard blocks.
   No spreading, no prioritization, no reserve for reactive work.
3. **Workers are passive** — dispatched per-task, one session per task. Expensive dispatch
   overhead for cheap work. Workers can't see their board or pick up next task.
4. **Leads poll on fixed schedules** — waste tokens checking empty boards. No event-driven
   wake for reviews or failures.

## Design

### Core Model: Budget as Fuel Tank

The budget is a fuel tank, not a wall. The system paces work across the day based on
remaining budget and remaining time.

```
User sets: $100/day
System calculates:
  - 20 hours remaining
  - $100 / 20 = $5/hour rate
  - Reserve 20% ($20) for reactive work
  - Allocatable: $80 across 20h = $4/hour
  - Worker session ($0.30): can run ~13/hour
  - Lead planning ($15): afford 5 total, schedule 3
```

### Agent Execution Modes

#### Leads: Event-Driven + Scheduled Planning

**Reactive sessions** (event-driven, immediate if budget allows):
- `task_review_ready` → review completed work, approve/reject
- `task_failed` → triage failure, retry/reassign/rewrite
- `dispatch_dead_letter` → investigate infrastructure blocker
- `budget_changed` → re-plan work allocation

Reactive sessions use the cheaper review model (Sonnet by default). Context is
narrow — lead knows exactly why it woke up.

**Planning sessions** (scheduled, 2-3x/day):
- Read DIRECTION, assess progress, create task batch, assign workers
- Full briefing context including Budget Plan recommendation
- Use expensive planning model (Opus by default)
- Frequency adapts: more if board is empty, fewer if pipeline is full
- Budget-reserved in advance so reactive work can't starve planning

**Budget Plan briefing source** (computed, injected into lead context):
```
## Budget Plan
Daily: $400 | Spent: $50 (12%) | Remaining: $350
Reserve (20%): $70 for reactive work
Allocatable: $280

Capacity:
  - Worker sessions: ~930 ($0.30 avg)
  - Tasks (2.5 sessions/task): ~370 tasks
  - Reviews remaining: ~560 ($0.50 avg)
  - Planning sessions remaining: 2 ($15 avg)

Current pipeline:
  - 12 OPEN tasks (enough for ~6h of worker activity)
  - Pipeline will drain in ~6h at current velocity
  - Recommendation: create 15-20 more tasks this session
```

The planning intelligence is in the briefing source computation, not in the LLM.
The LLM reads the recommendation and acts.

#### Workers: Event-Triggered + Session Loop

- Fire on `task_assigned` event (no polling, zero cost when idle)
- Once in session, loop: implement → submit → check board → claim next → repeat
- Session ends when no assigned tasks remain
- Configurable max tasks per session to prevent context bloat

Changes needed:
- Add `task_board` to employee briefing
- Allow workers to call `clawforce_task list --mine --state=ASSIGNED`
- Allow workers to transition own tasks (ASSIGNED → IN_PROGRESS → REVIEW)
- Session loop instead of single-task-and-exit

#### Verifiers: Event-Triggered Only

- Fire on `task_review_ready` (already implemented)
- Single task per session (reviews are fast)
- No changes from current behavior

### Budget Pacing Engine

New component: `BudgetPacer`

**Input:** daily budget, current spend, time remaining, agent cost profiles, pipeline state

**Output:**
```typescript
interface DispatchBudget {
  hourlyRate: number;        // cents/hour we can spend
  reactiveReserve: number;   // cents held back
  canDispatchLead: boolean;  // enough for a planning session?
  canDispatchWorker: boolean; // enough for a worker session?
  paceDelay: number;         // ms to wait before next dispatch
  recommendation: string;    // human-readable for lead briefing
}
```

**Pacing logic:**
- `hourlyRate = (remainingBudget - reserve) / hoursRemaining`
- Current hour spend > hourlyRate → delay dispatches
- Current hour spend < hourlyRate → dispatch freely
- Budget < low threshold → reactive-only mode (reviews, failures)
- Budget < critical threshold → verifiers only

**Integration:**
- Dispatcher checks pacing before every dispatch
- Sweep cycle respects paceDelay between dispatches
- Lead briefing gets recommendation as context source
- `budget_changed` event triggers lead wake + re-plan

### Event-to-Dispatch Wiring

Extend the event handler system with a `dispatch_agent` action type:

```yaml
event_handlers:
  task_review_ready:
    - action: dispatch_agent
      agent_role: lead        # dispatch the team's lead
      model: sonnet           # cheap model for reviews
      session_type: reactive
  task_failed:
    - action: dispatch_agent
      agent_role: lead
      model: sonnet
      session_type: reactive
  task_assigned:
    - action: dispatch_agent
      agent_role: worker      # dispatch the assigned worker
      session_type: active
```

Built-in defaults handle common patterns. Users override for custom behavior.

### Configuration

All behavior is configurable at the domain level with sensible defaults:

```yaml
dispatch:
  mode: "event-driven"          # or "cron" (legacy), "manual"

  budget_pacing:
    enabled: true
    reactive_reserve_pct: 20    # % held back for failures/reviews
    low_budget_threshold: 10    # % remaining → reactive-only mode
    critical_threshold: 5       # % remaining → verifiers only

  lead_schedule:
    planning_sessions_per_day: 3
    planning_model: "opus"
    review_model: "sonnet"
    wake_on:
      - task_review_ready
      - task_failed
      - dispatch_dead_letter
      - budget_changed

  worker:
    session_loop: true
    max_tasks_per_session: 5
    idle_timeout_ms: 300000
    wake_on:
      - task_assigned

  verifier:
    wake_on:
      - task_review_ready
```

A user who just sets `budget: $100/day` gets all defaults — event-driven dispatch,
budget pacing, worker loops, reactive leads. No config required beyond the budget.

## What Stays

- Dispatch queue — still used for tracking dispatch state, deduplication, retry
- Safety gates — emergency stop, agent disable, rate limits, risk gates
- Budget V2 — hourly/daily/monthly tracking, circuit breaker
- Cost recording — atomic transactions, audit trail
- Event system — store, router, handlers (extended, not replaced)

## What Changes

- Dispatcher gains budget pacing check before every dispatch
- Event router gains `dispatch_agent` action type
- Worker briefing gains task_board visibility
- Worker sessions gain loop mode (configurable)
- Lead dispatch shifts from fixed cron to event-driven + scheduled planning
- New BudgetPacer component computes pacing recommendations
- New Budget Plan briefing source for leads

## What's Removed

- Direct cron-as-dispatch hack (replaced by event-driven dispatch)
- Fixed-interval lead polling (replaced by event triggers + planning schedule)
- One-task-per-session worker model (replaced by session loop)

## Migration

- `dispatch.mode: "cron"` preserves current behavior (backward compatible)
- New domains default to `"event-driven"`
- Existing domains can opt in by setting `dispatch.mode: "event-driven"`
- No database migration needed — uses existing tables
