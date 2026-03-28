# Team Watcher Design

> Composable cross-team observation using existing observe + event infrastructure.

## Problem

cf-lead is told to watch the dashboard team but its automatic briefing only shows its own direct reports. Cross-team visibility requires manual context expansion calls — opportunistic, not systematic.

More broadly: ClawForce has no pattern for one team to observe another team's work as a dogfooding/improvement signal.

## Approach

Compose existing primitives (observe patterns, event system, briefing assembly) rather than building a new system. Extend `observe` with team scoping so events are filtered to a specific team's activity.

## Design

### 1. Observe Enhancement — Team Scoping

Extend `observe` entries from plain strings to also accept objects with a `scope` filter:

```yaml
# cf-lead config
observe:
  - pattern: "task.*"
    scope:
      team: "dashboard"
  - pattern: "dispatch.*"
    scope:
      team: "dashboard"
  - "budget.exceeded"  # plain strings still work
```

`scope.team` filters events to only those where the originating agent belongs to the specified team. The existing `renderObservedEvents` function gets a small change — after pattern-matching, it checks the event payload's agent ID against the team roster.

**Type changes:**

```typescript
// types.ts
type ObserveEntry = string | {
  pattern: string;
  scope?: {
    team?: string;
    agent?: string;
  };
};

// AgentConfig.observe changes from string[] to ObserveEntry[]
```

**Implementation touch points:**
- `types.ts` — extend ObserveEntry type
- `observed-events.ts` — add team/agent filtering after pattern match
- `org.ts` — expose `getTeamMembers(projectId, teamName)` if not already available

**No new briefing source needed.** The existing `observed_events` source already renders events matched by `observe` patterns. The scope filter just narrows what matches.

### 2. cf-lead SOUL Update — Dogfood Observer

Replace the current monitoring guidance with a dogfood-observer framing:

```markdown
## Dogfood Observer

The dashboard team is your live test bed. You observe their tasks flowing through
ClawForce — creation, assignment, execution, verification, completion — and look for:

- **System friction**: slow transitions, unnecessary retries, context gaps, poor defaults
- **Missing features**: things the dash team needs that ClawForce doesn't provide
- **Config gaps**: patterns that should be expressible in config but aren't
- **Cost waste**: sessions that burn tokens without progress
- **Quality signals**: are verifiers catching real issues or creating noise?

When you spot something, create an improvement task for your own team. You don't
intervene in dash-team work — you improve the platform they're running on.

## Meta-Awareness

Continuously evaluate your own experience as a ClawForce user:

- **Observability**: Do you have enough data streams to understand what's happening
  in the dashboard team? Can you tell WHY a task failed, not just that it did? If
  you're missing signals, that's a telemetry or event payload improvement.
- **Control surface**: Can you tune configs, adjust budgets, change policies, modify
  briefing sources for the teams you oversee? If you need a lever that doesn't exist,
  that's a feature gap.
- **User experience**: Think from a user's perspective — if someone downloaded
  ClawForce and set up a team-watcher pattern like this, would they have what they
  need? What would frustrate them?

Gaps in your own visibility and control are among the highest-value improvement
tasks you can create.
```

The watcher is observational, not interventional. It improves the platform, not the team's work. The meta-awareness layer makes it a recursive dogfooder — evaluating its own observability and control surface as a ClawForce user.

### 3. Config Wiring

Add scoped observe patterns to cf-lead's agent config in the domain yaml:

```yaml
# cf-lead in clawforce-dev domain
observe:
  - pattern: "task.*"
    scope:
      team: "dashboard"
  - pattern: "dispatch.*"
    scope:
      team: "dashboard"
```

**What cf-lead sees in its briefing:**

```
## Observed Events
- task_created: "Implement audit log view" (dash-worker, 2m ago)
- task_assigned: "Implement audit log view" → dash-worker-2 (1m ago)
- task_review_ready: "Implement audit log view" (dash-worker-2, 45s ago)
- task_completed: "Implement audit log view" — verified by dash-verifier (10s ago)
```

## Implementation Summary

Three changes, all small:

1. **Observe scoping** (~30 lines) — type extension + filter logic in observed-events.ts
2. **SOUL update** (~30 lines) — replace monitoring section in cf-lead's SOUL.md
3. **Config wiring** (~5 lines) — add observe entries to cf-lead's domain config

No new systems, no new briefing sources, no new tables. Composes existing infrastructure.

## Future Evolution

If this pattern proves valuable (expected), it can graduate to:
- A dedicated `watches` config field with richer semantics
- Team-watcher preset/mixin that bundles the observe patterns + SOUL guidance
- Event aggregation and debouncing for high-volume teams

These are Phase 2+ config improvements, informed by real usage of this pattern.
