# Troubleshooting

Common problems, how to diagnose them, and how to fix them.

## Common Errors

### Budget Exhausted

**Symptom:** Tasks stay in queue, `dispatch_failed` events with `budgetExceeded: true`.

**Diagnosis:**
```bash
pnpm cf budget          # check remaining budget and pacing
pnpm cf costs           # see what's been spent and by whom
```

**Fix:**
- Wait for the next budget window reset (daily resets at midnight UTC)
- Increase budget: `pnpm cf config set budget.daily_limit '$100'`
- The sweep auto-resets daily budgets -- do NOT re-enqueue budget-blocked tasks manually (this causes tight retry loops)

### Task Stuck in ASSIGNED

**Symptom:** Task sits in ASSIGNED but no agent picks it up.

**Diagnosis:**
```bash
pnpm cf tasks           # check task states and assignees
pnpm cf queue           # is there a queue item for this task?
pnpm cf agents          # is the assigned agent active/disabled?
```

**Causes and fixes:**
- **Agent disabled:** `pnpm cf enable <agent-id>` or `pnpm cf enable --domain`
- **No queue item:** the `task_assigned` event may not have fired. Run `pnpm cf status` to check event processing
- **Rate limited:** check `pnpm cf queue` for rate limit failure messages. Wait for the hourly window to clear
- **Concurrency limit:** all dispatch slots occupied. Check `dispatch.maxConcurrentDispatches` in config

### Task Stuck in REVIEW

**Symptom:** Task completed work but nobody verifies it.

**Diagnosis:**
```bash
pnpm cf tasks           # confirm task is in REVIEW
pnpm cf agents          # is a verifier agent registered?
```

**Causes and fixes:**
- **No verifier configured:** set `review.verifierAgent` in domain config, or name an agent with "verifier" or "reviewer" in its ID
- **Verifier disabled:** enable the verifier agent
- **Self-review blocked:** the verifier gate requires a different actor than the assignee. If you want self-review, set `review.selfReviewAllowed: true` in domain config
- **Auto-escalation:** configure `review.autoEscalateAfterHours` to escalate stale reviews to the manager

### Agent Not Dispatching

**Symptom:** Queue items exist but nothing runs.

**Diagnosis:**
```bash
pnpm cf running         # what's actually executing?
pnpm cf queue           # queue status and failure reasons
pnpm cf health          # overall system health
```

**Common blockers (checked in order by the dispatcher):**
1. Global concurrency limit (default: 3 concurrent dispatches)
2. Project concurrency limit (`dispatch.maxConcurrentDispatches`)
3. Project rate limit (`dispatch.maxDispatchesPerHour`)
4. Agent rate limit (default: 15/hour per agent)
5. Domain disabled (`pnpm cf enable --domain` to fix)
6. Agent disabled (`pnpm cf enable <agent-id>` to fix)
7. Emergency stop active (`pnpm cf kill --resume` to clear)
8. Budget pacing gate (hourly spend exceeds pace allocation)
9. Deadline expired (task auto-fails before dispatch)

### Emergency Stop Active

**Symptom:** All dispatches blocked with "Emergency stop active".

**Fix:**
```bash
pnpm cf kill --resume   # clears emergency stop AND re-enables domain
```

This clears the `emergencyStop` flag and re-enables the domain for dispatch.

### Dispatch Dead Letter

**Symptom:** Queue items hit max attempts and are permanently failed.

**Diagnosis:**
```bash
pnpm cf queue           # look for dead-lettered items
pnpm cf errors          # recent errors and failure reasons
```

**What happens:** after `maxDispatchAttempts` (default: 3) failures, the queue item is marked as dead letter. The task gets `$.dispatch_dead_letter: true` in its metadata. An audit entry is written.

**Fix:** investigate the root cause (usually agent config issues, missing project dir, or cron service unavailable), fix it, then re-create the task or manually re-enqueue.

## Reading Logs

ClawForce uses a diagnostic event system, not traditional log files. Events are emitted via `emitDiagnosticEvent()` and routed to OpenClaw's logger when running as a plugin.

### Key Diagnostic Event Types

| Event Type | What It Means |
|---|---|
| `clawforce.transition` | A task state change occurred |
| `clawforce.events.processed` | Event batch processing completed |
| `task_stale` | A task has had no activity past the threshold |
| `task_escalated` | A failed task was escalated |
| `dispatch_stale_recovered` | A stuck dispatch queue item was recovered |
| `workflow_phase_stalled` | A workflow phase gate cannot be satisfied |
| `internal_error` | An error was caught and swallowed |

### Key CLI Commands

`pnpm cf dashboard` (overview), `pnpm cf status` (vitals), `pnpm cf errors` (failures), `pnpm cf transitions` (state changes), `pnpm cf sessions` (session history), `pnpm cf session <key>` (drill into one session), `pnpm cf watch` (changes since last check).

## Debugging Dispatch Issues

Step-by-step dispatch debugging:

1. **Check if anything is running:** `pnpm cf running`
2. **Check the queue:** `pnpm cf queue` -- are items queued, leased, dispatched, or failed?
3. **Check limits:** `pnpm cf status` -- are concurrency/rate limits hit?
4. **Check budget:** `pnpm cf budget` -- is budget exhausted or pacing throttled?
5. **Check domain state:** `pnpm cf health` -- is the domain disabled or emergency-stopped?
6. **Check agent state:** `pnpm cf agents` -- is the target agent disabled?
7. **Check events:** `pnpm cf errors` -- any dispatch_failed events with reasons?
8. **Check cron service:** if using OpenClaw, the cron service must be available for dispatch injection

### Stale Dispatch Recovery

The sweep auto-detects dispatch items stuck in `dispatched` status with no active session. After `staleDispatchTimeoutMs` (default: 10 minutes), they are failed and re-enqueued. Tune via: `pnpm cf config set sweep.staleDispatchTimeoutMs 300000`.

## Recovering from Emergency Stop

Activate: `pnpm cf kill` (disables domain + cancels queue + kills processes).
Recover: `pnpm cf kill --resume` (clears stop + re-enables domain). After recovery, the sweep picks up stale tasks automatically.

## Diagnosing Org Structure Problems

```bash
pnpm cf agents          # list all agents, their roles, teams, and status
pnpm cf health          # comprehensive health check
```

Common org issues:
- **Agent in wrong team:** check domain config, verify the agent's `team` and `department` fields
- **Missing verifier:** ensure an agent with the verifier role exists for each team that needs review
- **Auto-assign not working:** check `assignment.enabled: true` and that worker agents exist with matching teams
- **Circular dependencies:** the dependency system rejects cycles at creation time, but check for logical loops in your workflow phases

## FAQ

**Q: Why do tasks default to P2 priority?**
P2 (medium) is the default so that P0/P1 are reserved for genuinely urgent work. This prevents priority inflation.

**Q: Can I run without OpenClaw?**
Yes. Import the SDK directly (`import { Clawforce } from "clawforce"`) and use it as a library. OpenClaw is needed only for agent session management and cron-based dispatch.

**Q: How do I increase the retry limit for a specific task?**
Set `maxRetries` when creating the task, or change the default: `pnpm cf config set defaultMaxRetries 5`.

**Q: Why is my agent rate-limited at 15/hour?**
15 dispatches per hour per agent is the default safety limit. Override per-agent: `pnpm cf config set dispatch.agentLimits.<agentId>.maxPerHour 30`.

**Q: What happens to tasks when the process restarts?**
On restart, `recoverProject()` runs: expired leases are reclaimed, stale IN_PROGRESS tasks are released, and dead dispatch items are cleaned up. No data is lost (everything is in SQLite).

**Q: How do I see what an agent actually did in a session?**
Use `pnpm cf session <key>` to see the full session breakdown: tool calls, transitions, cost, and output. Use `pnpm cf replay <key>` for raw tool call input/output.

**Q: Why did the sweep auto-block my task?**
Tasks with no activity for 2x the stale threshold (default: 8 hours) are auto-blocked by the sweep. They auto-unblock after another 2x window. Configure the threshold: `pnpm cf config set sweep.staleThresholdMs 28800000`.

**Q: How do I permanently stop a task?**
Transition it to CANCELLED. This is terminal -- no retries, no evidence required: `pnpm cf tasks transition <taskId> CANCELLED`.

**Q: What's the difference between disabling and emergency stop?**
Disable (`pnpm cf disable`) blocks new dispatches but lets running sessions finish. Emergency stop (`pnpm cf kill`) does that plus cancels the queue and kills running processes.

**Q: How do I check if budget pacing is throttling my dispatches?**
`pnpm cf budget` shows pacing status and projections. If you see "hourly pace exceeded", the system is spreading spend across the day. Disable pacing per-team if needed: `pnpm cf config set dispatch.teams.<team>.budget_pacing.enabled false`.
