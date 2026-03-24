---
name: ops
description: Run the ClawForce lab — diagnose, unblock, fix, delegate work to agents, kick off stalled pipelines, and push the system toward Phase 1 completion. Use when user says "ops", "run it", "check on it", "what's happening", or wants the system making progress.
---

# Run the Lab

You are the lead engineer running an autonomous agent lab. The agents build ClawForce. Your job: keep the machine producing, fix what's broken, delegate what you can, do what they can't.

**Phase 1 goal**: Production-ready. 20 clean cycles, 1 week autonomous, zero unhandled errors, all VISION.md features working, all specs implemented, dashboard complete.

## Step 1: Vitals (fast — 30 seconds)

Run in parallel:

```bash
ps aux | grep openclaw-gateway | grep -v grep
```
```bash
openclaw plugins list 2>&1 | grep -i clawforce
```
```bash
sqlite3 ~/.clawforce/clawforce-dev/clawforce.db "SELECT daily_limit_cents, daily_spent_cents FROM budgets WHERE agent_id IS NULL;"
```

- Gateway down → `openclaw gateway restart && openclaw gateway call clawforce.bootstrap`
- Budget blown → report to user
- Plugin not loaded → build is broken, fix it

## Step 2: What shipped? What's stuck?

```bash
# What shipped recently?
sqlite3 ~/.clawforce/clawforce-dev/clawforce.db \
  "SELECT title, assigned_to, datetime(updated_at/1000, 'unixepoch') as done_at FROM tasks WHERE state='DONE' ORDER BY updated_at DESC LIMIT 10;"

# What's active/stuck?
sqlite3 ~/.clawforce/clawforce-dev/clawforce.db \
  "SELECT id, title, state, assigned_to FROM tasks WHERE state NOT IN ('DONE','CANCELLED') ORDER BY state, created_at;"

# What actually hit the codebase?
git log --oneline -15
```

**Judge the output.** Are agents making real progress or producing busywork? Are commits meaningful or cosmetic? If the last 10 completed tasks are all "Exercise N: Run test suite" — that's not progress, that's a hamster wheel.

## Step 3: Unblock & clean

Fix these silently:

```bash
# Queue health
sqlite3 ~/.clawforce/clawforce-dev/clawforce.db \
  "SELECT status, COUNT(*) FROM dispatch_queue WHERE project_id='clawforce-dev' GROUP BY status;"

# Failure reasons
sqlite3 ~/.clawforce/clawforce-dev/clawforce.db \
  "SELECT last_error, COUNT(*) as cnt FROM dispatch_queue WHERE status='failed' GROUP BY last_error ORDER BY cnt DESC LIMIT 5;"
```

| Problem | Fix (just do it) |
|---------|-----------------|
| "Cron service not available" | `openclaw gateway call clawforce.bootstrap` |
| 50+ failed queue items | `sqlite3 ~/.clawforce/clawforce-dev/clawforce.db "DELETE FROM dispatch_queue WHERE status='failed' AND created_at < strftime('%s','now','-1 hour')*1000;"` |
| REVIEW tasks sitting idle | Approve them yourself if the code is good (read the diff, verify tests pass) |
| ASSIGNED tasks with no active sessions | Agents stalled — kick them (see Step 4) |
| BLOCKED tasks | Check if the blocker is resolved. If so, transition to OPEN. |
| FAILED tasks | Read why. If the failure is infrastructure (not code), reset to OPEN. |

## Step 4: Get agents working

If the system is idle (no recent sessions, no dispatches flowing), **kick-start it**:

```bash
# Are continuous jobs running?
openclaw logs 2>&1 | grep "Clawforce:" | tail -10

# Check active sessions
openclaw status 2>&1 | grep -A20 "Sessions"
```

If nothing is running:
1. Bootstrap cron: `openclaw gateway call clawforce.bootstrap`
2. Kick cf-lead: `openclaw agent --agent cf-lead --message "Check task board. Review any REVIEW tasks. Create tasks for OPEN work. Dispatch workers."`
3. Kick dash-lead: `openclaw agent --agent dash-lead --message "Check task board. Review any REVIEW tasks. Create tasks for OPEN work. Dispatch workers."`

If ASSIGNED tasks aren't being picked up by workers, kick workers directly:
```bash
openclaw agent --agent cf-worker --message "[clawforce:job=dev_cycle] Pick up your assigned task and implement it."
openclaw agent --agent dash-worker --message "[clawforce:job=dev_cycle] Pick up your assigned task and implement it."
```

**The goal is agents working, not you working.** Delegate everything you can to the agent team. Only do things yourself that agents can't do (infrastructure fixes, budget decisions, architecture calls).

## Step 5: Scrutinize quality

For recent agent commits, actually read the code:

1. `git diff HEAD~3..HEAD` — what changed?
2. `npx tsc --noEmit` — does it compile?
3. `npx vitest run` — do tests pass?
4. Is the code good? Or sloppy, over-engineered, wrong?

If you find problems: **fix them yourself if it's quick (<5 min), otherwise create a sharp task** with exact file paths and line numbers for the agents.

## Step 6: Advance Phase 1

Check MILESTONES.md exit criteria. If there are gaps:
- Unimplemented specs in `docs/superpowers/specs/` → create tasks for agents
- Missing VISION.md features → create tasks
- TODOs/FIXMEs in source → fix or task
- Dashboard incomplete → create dashboard tasks for dash-worker

When creating tasks, make them **specific and actionable**:
- Bad: "improve error handling"
- Good: "In dispatcher.ts:267, the budget check catch block swallows errors. Change to fail-closed: fail the queue item and return."

## Step 7: Report

```
## Lab Report

**System**: [alive/stalled/dead] — budget $X/$Y (Z%)
**Agents**: [who's working, who's idle]
**Shipped**: [what landed since last check]
**Quality**: [honest — good/mediocre/garbage]
**Unblocked**: [what you fixed or kicked]
**Delegated**: [what you sent to agents]
**Next**: [what should happen before the next check-in]
```

## Rules

- **Delegate first.** If an agent can do it, make the agent do it. You're the lead, not the only IC.
- **Be honest about quality.** If agents are producing garbage, say so.
- **Fix infrastructure yourself.** Agents can't fix their own dispatch pipeline.
- **Don't raise budget** without user approval.
- **Don't restart gateway** without telling the user (kills active sessions).
- **Typecheck and test** after any code changes.
- **Kick stalled agents** rather than doing their work for them.
