# Team Watcher Pattern

One team observes another team's task lifecycle through scoped event subscriptions. The watcher sees tasks being created, assigned, executed, verified, and completed — and uses that signal to improve the platform both teams run on.

## When to Use This

- **Dogfooding.** Your platform team builds the system that other teams use. Watching a product team's work reveals friction, missing features, and config gaps that internal testing misses.
- **Quality oversight.** A senior team monitors a junior team's output quality without intervening in their decisions.
- **Cross-team awareness.** Two teams share infrastructure and need visibility into each other's activity to avoid collisions.

The pattern is read-only by design. The watcher observes and creates improvement tasks for its own team. It does not intervene in the watched team's work.

## Setup

### Step 1: Add scoped observe entries

In the watcher agent's config, add `observe` entries with `scope` filters. Each entry specifies an event pattern and the team (or agent) to watch.

```yaml
agents:
  platform-lead:
    extends: manager
    observe:
      # Watch all task lifecycle events from the product team
      - pattern: "task.*"
        scope:
          team: "product"

      # Watch dispatch events to see how sessions are allocated
      - pattern: "dispatch.*"
        scope:
          team: "product"

      # Unscoped — global budget events from any team
      - "budget.exceeded"
```

**Observe entry formats:**

| Format | Example | Matches |
|--------|---------|---------|
| Plain string | `"budget.exceeded"` | Exact event type, any agent |
| Wildcard string | `"task.*"` | All `task.` events, any agent |
| Scoped object (team) | `{ pattern: "task.*", scope: { team: "product" } }` | All `task.` events from product team agents |
| Scoped object (agent) | `{ pattern: "task.*", scope: { agent: "product-worker" } }` | All `task.` events from one specific agent |

Scope filters narrow which events match. An event's originating agent is checked against the team roster (for `scope.team`) or matched exactly (for `scope.agent`). You can combine both — the event must satisfy all specified scope fields.

### Step 2: Add the SOUL sections

Copy the [team-watcher SOUL template](../../templates/soul/team-watcher.md) into the watcher agent's `SOUL.md`. Customize the placeholders:

- Replace `[watched team]` with the team name (e.g., "product")
- Replace `[your team]` with the watcher's team name (e.g., "platform")
- Adjust the "What You Don't Do" section to match your org's boundaries

### Step 3: Add observed_events to the briefing

The watcher agent needs the `observed_events` context source in its briefing to see the filtered events at each session. If you're using the `manager` preset, this is already included. If you have a custom briefing, add it:

```yaml
agents:
  platform-lead:
    briefing:
      - source: soul
      - source: task_board
      - source: observed_events   # <-- required for team-watcher
      - source: cost_summary
      - source: team_status
```

### What the watcher sees

At each session, the watcher's briefing includes an "Observed Events" section showing recent events from the watched team:

```
## Observed Events

- **task.created** (2026-03-27T14:30:00Z): {"assignedTo":"product-worker","title":"Add export button"}
- **task.completed** (2026-03-27T14:45:00Z): {"agentId":"product-worker","title":"Add export button"}
- **dispatch.started** (2026-03-27T14:46:00Z): {"agentId":"product-worker-2","jobId":"triage"}
```

Events are filtered by the `since` timestamp, so the watcher only sees new events since its last session.

## What to Watch For

The watcher's job is to find improvement signals — things the platform can do better. The categories:

**System friction.** Slow task transitions, excessive retries, context gaps that force agents to ask for clarification, poor default configs that need overriding on every task.

**Missing features.** Things the watched team needs that the platform doesn't provide. Patterns they work around manually that should be automated.

**Config gaps.** Behaviors that should be expressible in config but require code changes or manual intervention. New config fields the platform should support.

**Cost waste.** Sessions that burn tokens without making progress. Retries caused by bad defaults rather than genuine failures. Unnecessary context in briefings.

**Quality signals.** Are verifiers catching real issues or generating noise? Are tasks being rejected for legitimate quality problems or pedantic reasons? Are completion rates where they should be?

## Anti-Patterns

**Don't micromanage.** The watcher observes the system, not the people. If you see a worker making suboptimal choices, improve the system that guides them (SOUL, DIRECTION, config defaults) rather than overriding their decisions.

**Don't intervene in watched-team work.** The watcher creates improvement tasks for its own team. It does not reassign, reject, or modify tasks belonging to the watched team. That's the watched team's manager's job.

**Don't watch everything.** Scope your observe patterns to the events that actually inform improvements. Subscribing to `"*"` from a large team creates noise that drowns out signal.

**Don't skip the SOUL sections.** Without the Dogfood Observer and Meta-Awareness guidance, the watcher agent will see events but won't know what to do with them. The SOUL template turns raw events into improvement tasks.

**Don't create a watcher chain.** Team A watches Team B watches Team C creates circular observation overhead. Keep the pattern unidirectional: platform watches product, not the reverse.

## Variations

### Watching a specific agent

If you only care about one agent's activity (e.g., a new hire's first week), use `scope.agent`:

```yaml
observe:
  - pattern: "task.*"
    scope:
      agent: "product-worker-2"
```

### Multiple watched teams

A watcher can observe multiple teams by adding separate scoped entries:

```yaml
observe:
  - pattern: "task.*"
    scope:
      team: "product"
  - pattern: "task.*"
    scope:
      team: "operations"
```

### Mixing scoped and unscoped

Combine team-scoped entries (for cross-team visibility) with unscoped entries (for global signals):

```yaml
observe:
  # Team-specific task lifecycle
  - pattern: "task.*"
    scope:
      team: "product"
  # Global budget alerts from any team
  - "budget.exceeded"
  - "budget.warning"
```
