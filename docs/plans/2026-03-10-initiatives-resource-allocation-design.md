# Phase 7: Initiatives & Resource Allocation — Design

## Goal

Add budget allocation to the goal system so that spending is controlled per-initiative and per-agent. No new entities — initiatives are goals with an `allocation` field, and budget cascades uniformly through the agent tree.

## Key Decisions

1. **Initiatives ARE goals** — A top-level goal with `allocation` is an initiative. No separate entity or table.
2. **Hard gate at dispatch** — `shouldDispatch` blocks tasks when their initiative's allocation is exhausted. Not advisory — hard enforcement.
3. **Parent-walking** — The gate traces a task's goal up the hierarchy to find the top-level goal with an `allocation`. A task under `ui-improvements > redesign-nav > fix-dropdown` is gated by `ui-improvements`.
4. **Implicit reserve** — Allocations don't need to sum to 100%. Remainder is unallocated buffer for ad-hoc work.
5. **Uniform cascading** — No special project-level logic. Project `daily_budget_cents` seeds root agent(s). Every coordination agent allocates to its reports using the same mechanism. Budget flows down the tree uniformly.
6. **Allocation in YAML, adjustable at runtime** — Starting allocations defined in config, coordination agents can update them via the goal tool.

## Architecture

### Budget flows on two axes

- **What** gets budget → goal allocation (percentage of parent's budget)
- **Who** spends it → agent cascading (coordination agents allocate to reports)
- **Unplanned work** → implicit reserve (unallocated percentage)

### Initiative allocation

Add `allocation?: number` to the `Goal` type. Represents percentage of the project's daily budget allocated to tasks under this goal tree.

```yaml
goals:
  ui-improvements:
    allocation: 40
    description: "Dashboard UX improvements"
    department: engineering
  customer-outreach:
    allocation: 30
    description: "Daily lead gen and follow-ups"
    department: sales
```

Here 30% remains as implicit reserve for ad-hoc/reactive work.

### Hard gate in dispatcher

`shouldDispatch` already checks agent budget and rate limits. Add an initiative budget check:

1. Look up the task's `goal_id`
2. Walk `parent_goal_id` up to the root goal with `allocation`
3. Query today's spend on all tasks under that goal tree
4. Compare against `allocation% × project daily_budget_cents`
5. If exceeded → `{ ok: false, reason: "initiative budget exceeded" }`

If a task has no goal or no ancestor has allocation, the gate passes (uses implicit reserve / agent budget only).

### Cascading budget

Uniform at every level of the agent tree:

```
Project daily_budget_cents = $20
  └── eng-lead (coordination agent) — receives $20
        ├── frontend-dev — allocated $8 by eng-lead
        ├── backend-dev — allocated $7 by eng-lead
        └── unallocated — $5 reserve
```

The project config sets `daily_budget_cents` on the root agent(s). Coordination agents allocate portions to their reports. Each agent's budget is bounded by their parent's allocation — you can't allocate more than you have.

Allocation happens via the ops tool or goal tool. The existing `budgets` table already has per-agent limits (`daily_limit_cents`, `hourly_limit_cents`). Cascading adds a constraint: an agent's limit cannot exceed their parent's remaining allocatable budget.

### Briefing source

New `initiative_status` context source for coordination agents. Shows:

- Each initiative's allocation percentage and absolute cents
- Spent vs allocated (today)
- Remaining budget per initiative
- Per-report budget allocation and spend
- Reserve remaining

### Runtime adjustment

Coordination agents can:
- Update `allocation` on goals via the goal tool (rebalance initiatives)
- Update report budget allocations via the ops tool (rebalance team)
- Both bounded by hard limits (can't exceed parent allocation)

## Config Format

### Goals with allocation

```yaml
goals:
  ui-improvements:
    allocation: 40
    description: "Dashboard UX improvements"
    department: engineering
    acceptance_criteria: "All dashboard pages score 90+ on Lighthouse"
  customer-outreach:
    allocation: 30
    description: "Daily lead gen and follow-ups"
    department: sales
```

Goals without `allocation` are normal goals — not budget-gated at the initiative level (still subject to agent budget limits).

### Project budget

```yaml
budget:
  daily_limit_cents: 2000
```

This seeds root agent(s). No separate project-level vs agent-level distinction.

## Type Changes

```typescript
// Goal type — add allocation
export type Goal = {
  // ... existing fields ...
  allocation?: number;  // Percentage of project daily budget (0-100)
};

// Goals table — add column
// ALTER TABLE goals ADD COLUMN allocation INTEGER;
```

## Code Changes

### Dispatch gate (`src/dispatch/dispatcher.ts`)

Add `checkInitiativeBudget(projectId, taskId)` to `shouldDispatch`:
- Looks up task's goal_id
- Walks parent chain to find root goal with allocation
- Queries cost_records for today's spend on tasks under that goal tree
- Compares against allocation percentage of project budget

### Goal ops (`src/goals/ops.ts`)

- `updateGoal` accepts `allocation` field
- Validation: allocation must be 0-100
- New: `getInitiativeSpend(projectId, goalId)` — aggregates cost for all tasks in goal tree

### Goal tool (`src/tools/goal-tool.ts`)

- `create` and `update` actions accept `allocation` parameter
- `status` action shows budget info when goal has allocation

### Context assembler (`src/context/assembler.ts`)

- New `initiative_status` source resolver
- Shows allocation table with spend/remaining for coordination agents

### Project normalization (`src/project.ts`)

- Parse `goals:` section from config
- Create goals on activate with allocation field
- Validate allocations sum to ≤ 100

### Cascading budget (`src/budget.ts` or new `src/budget-cascade.ts`)

- `allocateBudgetToReport(parentAgentId, childAgentId, amountCents)` — sets child's daily limit, bounded by parent's remaining allocatable
- `getAgentBudgetStatus(agentId)` — shows allocated, spent, remaining, allocatable-to-reports
- Coordination agents invoke via ops tool

### Migration

- Add `allocation` column to goals table
- No new tables needed

## What This Does NOT Include

- **Cost forecasting** (Phase 10.3) — No predictions like "at current rate, budget exhausted by 3pm"
- **Rate limit awareness in scheduling** — Dispatch gate already checks rate limits; no new logic
- **Auto-generated dispatch plans** — Coordination agents decide what to dispatch, system just enforces limits
- **Model cost config** — Already exists in budget system

## Testing Strategy

- Unit: initiative budget gate (spend under/over allocation, no goal, no allocation)
- Unit: parent-walking (deep hierarchy, missing links, root goal)
- Unit: cascading allocation (bounded by parent, over-allocation rejected)
- Unit: initiative spend aggregation (multiple sub-goals, multiple tasks)
- Integration: dispatch blocked when initiative over-budget
- Integration: coordination agent briefing shows initiative status
- Integration: runtime allocation adjustment via goal tool
