# Hooks and Events

ClawForce has two systems for reacting to things that happen: **events** (after-the-fact notifications) and **hooks** (interceptors that can block actions before they happen).

## Events

Events are persisted to the database and processed by the event router. They drive the dispatch system -- agents wake because something happened, not on a timer.

### Built-in Event Types

| Event | When It Fires | Key Payload Fields |
|---|---|---|
| `task_created` | A new task is inserted | `taskId`, `title`, `state`, `assignedTo`, `department`, `team` |
| `task_assigned` | A task is assigned to an agent | `taskId`, `assignedTo`, `fromState` |
| `task_completed` | A task transitions to DONE | `taskId`, `actor` |
| `task_failed` | A task transitions to FAILED | `taskId`, `actor` |
| `task_review_ready` | A task transitions to REVIEW | `taskId` |
| `dispatch_succeeded` | An agent was successfully dispatched | `taskId`, `agentId`, `queueItemId` |
| `dispatch_failed` | Dispatch was blocked or errored | `taskId`, `error`, `budgetExceeded`, `rateLimited` |
| `dispatch_dead_letter` | A queue item hit max attempts | `taskId`, `queueItemId` |
| `sweep_finding` | Background sweep detected something | `finding` (stale/retry_exhausted/review_stale/etc), `taskId` |
| `proposal_created` | A new approval proposal was created | `proposalId`, `proposedBy`, `riskTier`, `title` |
| `proposal_approved` | A proposal was approved | `proposalId` |
| `proposal_rejected` | A proposal was rejected | `proposalId`, `feedback` |
| `replan_needed` | A task exhausted retries, needs replanning | `taskId`, `taskTitle`, `totalAttempts`, `replanCount` |
| `workflow_completed` | All phases of a workflow finished | `workflowId` |
| `goal_achieved` | A goal was marked achieved | `goalId` |
| `meeting_turn_completed` | An agent finished its meeting turn | `channelId` |
| `custom` | User-defined event | Any |
| `ci_failed`, `pr_opened`, `deploy_finished` | External triggers (extensibility) | Any |

### Event Processing Flow

1. Events are ingested into the `events` table with status `pending`
2. The event router claims pending events in batches (up to 50)
3. For each event, the **built-in handler** runs first (unless overridden)
4. Then any **user-defined actions** from domain config run
5. Events are marked `handled`, `ignored`, or `failed`

### User-Defined Event Handlers (Config)

Define handlers in your domain YAML under `event_handlers`:

```yaml
event_handlers:
  task_failed:
    actions:
      - action: notify
        channel: lead
        template: "Task failed: {{payload.taskId}}"
      - action: create_task
        template: "Investigate failure: {{payload.taskId}}"
        priority: P1
    override_builtin: false   # set true to skip built-in handler
```

### Available Action Types

| Action | What It Does |
|---|---|
| `create_task` | Creates a new task from a template |
| `notify` | Sends a message to an agent |
| `escalate` | Routes to escalation target with priority |
| `enqueue_work` | Adds a task to the dispatch queue |
| `emit_event` | Fires another event (chaining) |
| `dispatch_agent` | Dispatches a specific agent with a prompt |

All templates support `{{event.type}}`, `{{event.projectId}}`, `{{payload.X}}` interpolation.

## Hooks (SDK Interceptors)

Hooks are in-memory callbacks registered via the SDK. Unlike events, hooks run **before** the action and can **block** it.

### Available Hook Points

| Hook | Context | Can Block? | Use Case |
|---|---|---|---|
| `beforeDispatch` | `{ taskId, agentId, priority }` | Yes | Budget checks, custom throttling |
| `beforeTransition` | `{ taskId, fromState, toState, actor }` | Yes | Custom validation, approval gates |
| `onBudgetExceeded` | `{ agentId, costCents, remaining }` | Yes | Alert, halt spending |

Custom hooks can be registered with any name via `hooks.register(name, callback)`.

### Hook Behavior

- Callbacks execute in insertion order
- First callback returning `{ block: true, reason: "..." }` short-circuits
- **Errors are swallowed** -- a throwing callback does not crash the system
- Hooks exist only in-process (not persisted)

## Practical Examples

### 1. Auto-create investigation tasks on failure

```yaml
# domain.yaml
event_handlers:
  task_failed:
    actions:
      - action: create_task
        template: "Investigate: {{payload.taskTitle}} failed"
        description: "Task {{payload.taskId}} failed. Review logs and determine root cause."
        priority: P1
```

### 2. Block dispatch when budget is low (SDK)

```typescript
const cf = Clawforce.init({ domain: "my-project" });

cf.hooks.beforeDispatch((ctx) => {
  const budget = cf.budget.check(ctx.agentId);
  if (!budget.ok) {
    return { block: true, reason: `Budget exhausted for ${ctx.agentId}` };
  }
});
```

### 3. Notify on high-risk transitions (SDK)

```typescript
cf.hooks.beforeTransition((ctx) => {
  if (ctx.toState === "DONE" && ctx.fromState === "REVIEW") {
    console.log(`Task ${ctx.taskId} approved by ${ctx.actor}`);
  }
  // returning void means "allow"
});
```

## Events vs Hooks Summary

| | Events | Hooks |
|---|---|---|
| Timing | After the action | Before the action |
| Can block? | No | Yes |
| Persisted? | Yes (SQLite) | No (in-memory) |
| Config | Domain YAML `event_handlers` | SDK `hooks.register()` |
| Error handling | Isolated per handler | Errors swallowed |
| Dedup | Built-in via dedup keys | N/A |
