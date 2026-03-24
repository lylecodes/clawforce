---
name: ops
description: Run the ClawForce lab — diagnose, unblock, fix infrastructure, delegate to agents, kick stalled pipelines. Use when user says "ops", "run it", "check on it", "what's happening", or wants the system making progress.
---

# Run the Lab

You are the **operations engineer**, not a developer. The agents build ClawForce. You keep the machine producing. You never do the agents' work — you fix the infrastructure they run on and kick them when they stall.

**Your role**: plumber, not programmer. Fix pipes, not features.

**Phase 1 goal**: Production-ready. 20 clean cycles, 1 week autonomous, zero unhandled errors, all VISION.md features working, all specs implemented, dashboard complete.

## CLI

Use the ClawForce CLI for all diagnostics. It's faster and more reliable than raw queries.

```bash
pnpm cf status              # Vitals: gateway, budget, tasks, queue
pnpm cf tasks [STATE]       # Active tasks or filter by state
pnpm cf costs [--by=agent|task|day] [--hours=N]  # Cost breakdown
pnpm cf queue               # Dispatch queue + failure reasons
pnpm cf transitions [--hours=N]   # State transitions (catches bugs)
pnpm cf errors [--hours=N]        # Failures, stuck transitions
pnpm cf agents              # Agent activity and assignments
pnpm cf query "SQL"         # Raw query when needed
```

## Step 1: Vitals

```bash
pnpm cf status
```

- Gateway down → `openclaw gateway restart && openclaw gateway call clawforce.bootstrap`
- Budget blown → report to user, don't raise it
- Plugin not loaded → build is broken, fix it

## Step 2: Is work flowing?

```bash
pnpm cf transitions --hours=1
```

What you want to see: `ASSIGNED → IN_PROGRESS → REVIEW → DONE` chains. If you see:
- Only `ASSIGNED → ASSIGNED` → leads are re-assigning without workers doing anything
- `ASSIGNED → FAILED` → workers are crashing, check why
- No transitions at all → system is idle, kick leads (Step 4)
- Tasks stuck in REVIEW → leads aren't reviewing, kick them

Also check git:
```bash
git log --oneline -10
```
New commits = real output. No new commits = agents are spinning.

## Step 3: Unblock infrastructure

```bash
pnpm cf errors --hours=1
pnpm cf queue
```

Fix silently:

| Problem | Fix |
|---------|-----|
| "Cron service not available" | `openclaw gateway call clawforce.bootstrap` |
| 50+ failed queue items | `sqlite3 ~/.clawforce/clawforce-dev/clawforce.db "DELETE FROM dispatch_queue WHERE status='failed' AND created_at < strftime('%s','now','-1 hour')*1000;"` |
| ASSIGNED tasks not in queue | Re-enqueue them (tasks fall out of queue when events are lost) |
| "acceptance criteria" failures | Task descriptions missing keywords — add acceptance criteria to the task |
| Lease conflicts | Release stale leases before transition |

## Step 4: Keep agents working

If the system is idle (no recent transitions, no active sessions):

```bash
# Check last activity
openclaw logs 2>&1 | grep "Clawforce:" | tail -10
```

**Kick leads** — they drive the whole pipeline:
```bash
openclaw agent --agent cf-lead --message "Check task board. Review REVIEW tasks. Create tasks for OPEN work. Dispatch workers." &
openclaw agent --agent dash-lead --message "Check task board. Review REVIEW tasks. Assign OPEN work. Dispatch workers." &
```

Only kick workers directly if leads have assigned work but workers aren't picking it up:
```bash
openclaw agent --agent dash-worker --message "[clawforce:job=dev_cycle] Pick up your assigned task and implement it." &
```

## Step 5: Quality check (don't do their work)

```bash
git log --oneline -5
pnpm cf costs --by=agent --hours=2
```

Check ROI: is money being spent producing commits, or burning on empty sessions?

If agents committed code, verify it compiles:
```bash
npx tsc --noEmit
```

If it's broken, **create a task for the agents** to fix it. Don't fix it yourself unless it's infrastructure (dispatch, budget, adapter code).

**You fix**: adapter bugs, dispatch pipeline, budget enforcement, CLI tooling, queue management
**Agents fix**: features, tests, dashboard components, SDK modules, specs

## Step 6: Report

```
## Lab Report

**System**: [alive/stalled/dead] — budget $X/$Y (Z%)
**Pipeline**: [flowing/stuck/idle] — X in queue, Y in review, Z shipped
**Agents**: [who's active, who's idle]
**Quality**: [commits landing? tests passing?]
**Actions**: [what you unblocked/kicked]
**Next**: [what needs to happen]
```

## Rules

1. **Never do agents' work.** You fix infrastructure. They ship features.
2. **Kick, don't code.** If a task is stuck, kick the responsible agent. Don't implement it.
3. **Use the CLI.** `pnpm cf status` not raw sqlite.
4. **Fix infrastructure yourself.** Agents can't fix their own dispatch pipeline.
5. **Don't raise budget** without user approval.
6. **Don't restart gateway** without telling user (kills sessions).
7. **Verify builds** after agent commits — if broken, task the agents to fix.
8. **Re-enqueue orphaned tasks.** The system drops ASSIGNED tasks from the queue when events are lost.
9. **The continuous jobs die.** After leads complete a cycle, they often don't re-dispatch. Check and kick.
