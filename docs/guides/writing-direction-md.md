# Writing a Good DIRECTION.md

DIRECTION.md tells your agent team what to work toward. It lives at `~/.clawforce/domains/<domain>/context/DIRECTION.md` and gets injected into every agent's context.

A bad DIRECTION.md produces unfocused agents that pick random work. A good one produces agents that systematically work toward measurable goals.

## Structure

```markdown
# Direction

## Mission
One sentence. What is this team building/maintaining?

## End State
What does "done" look like? Organized by area.

## Priorities
What to work on NOW vs LATER. With measurable targets.
```

## Mission

One sentence. No buzzwords. If you can't say it in one sentence, you don't know what you're building.

```markdown
## Mission
Build and maintain a fully autonomous, profitable algorithmic trading system.
```

Not: "Leverage AI-driven synergies to optimize multi-asset portfolio alpha generation."

## End State

Describe what the world looks like when the team succeeds. Group by area. Use concrete outcomes, not activities.

```markdown
## End State

### Area 1
- Concrete outcome with measurable criteria
- Another concrete outcome

### Area 2
- ...
```

**Good:** "Profitable on multiple tickers (ES, NQ, MES, MNQ)"
**Bad:** "Improve trading performance"

**Good:** "Zero unhandled errors in logs during market hours"
**Bad:** "Robust error handling"

## Priorities

This is the most important section. Without it, agents will pick whatever work looks interesting — often low-priority busywork.

### Rules for priorities

1. **Number them.** P0 is now. P1 is next. P2 is later. P3 is backlog.
2. **Give each level a measurable target.** "30 consecutive error-free trading days." Not "stable system."
3. **Set gate conditions.** "Do not work on P1 until P0 targets are met." Otherwise agents skip ahead to more interesting work.
4. **Be specific about what's NOT allowed.** "Do not create tasks for work outside the current priority level."

### Targets

Every priority level needs a target with:
- **What**: specific outcome
- **How much**: measurable quantity
- **How long**: timeframe

```markdown
### P0 — Foundation (now)
Target: Stable, error-free operations for 30 consecutive trading days.

- Zero unhandled errors in logs during market hours for 30 days
- Test suite: 100% pass rate maintained
- All scheduled jobs fire on schedule with zero missed runs for 30 days
```

Without targets, "system health" is achieved by running one successful health check. With targets, agents know they need sustained performance over time.

### Gate conditions

```markdown
### Rules
- Do not work on P1 until P0 targets are met
- Do not work on P2 until P1 targets are met
- Do not create tasks for work outside the current priority level
```

This prevents agents from doing P3 polish work while P0 is broken.

## Common Mistakes

**Too vague:** "Improve the system" — agents don't know what to improve or when they're done.

**No priorities:** agents pick random work. You get MCL added to Databento instead of fixing pipeline failures.

**No targets:** "system stability" is achieved after one passing health check. "30 consecutive error-free days" requires sustained work.

**No gate conditions:** agents skip ahead to fun P2 work while P0 is broken.

**Too detailed:** DIRECTION.md is not a task list. It's the mission and priorities. Tasks are created by the manager based on the direction.

**Activities instead of outcomes:** "Run health checks daily" is an activity. "Zero unhandled errors for 30 days" is an outcome. The manager decides what activities achieve the outcome.

## Updating DIRECTION.md

Update when:
- A priority level's targets are met (promote P1 to P0, etc.)
- The mission changes
- You learn something that changes what "done" looks like

Don't update:
- To add individual tasks (that's the manager's job)
- To track progress (that's the dashboard)
- Every session (it should be stable for weeks)
