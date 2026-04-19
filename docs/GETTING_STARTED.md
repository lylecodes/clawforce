# Getting Started with ClawForce

## What is ClawForce?

ClawForce is the governance and control plane for agent teams: budgets,
approvals, trust, audit, and operator control above any runtime.

This guide is written for the solo technical operator who wants to run a real
team of agents, not just demo one. Budget enforcement, task orchestration, trust
scoring, approval flows, and coordination all run in-process, backed by SQLite.
No infrastructure.

ClawForce is not primarily an agent-construction framework. It sits above agent
execution and governs it.

## Prerequisites

- **Node.js 22.22+**
- **npm** or another package manager
- **Codex CLI authenticated with OpenAI**
- Optional: [OpenClaw](https://github.com/openclaw/openclaw) as a compatibility bridge when you specifically need its gateway/plugin capabilities

## Install

```bash
npm install clawforce
```

## Define Your Team

Create two config files. A domain is an isolated workspace -- one database, one team, one budget.

**`config.yaml`** -- agent definitions:

```yaml
adapter: codex
codex:
  model: gpt-5.4

agents:
  lead:
    extends: manager
    title: Engineering Lead
    persona: "You lead a small dev team. Plan work, assign tasks, triage failures."
    coordination:
      enabled: true
      schedule: "*/30 * * * *"
    briefing:
      - source: soul
      - source: task_board
      - source: cost_summary
      - source: team_status

  worker-1:
    extends: employee
    title: Developer
    reports_to: lead
    briefing:
      - source: soul
      - source: assigned_task

  worker-2:
    extends: employee
    title: Developer
    reports_to: lead
    briefing:
      - source: soul
      - source: assigned_task
```

**`domains/my-team.yaml`** -- domain config:

```yaml
domain: my-team
manager:
  agentId: lead
agents:
  - lead
  - worker-1
  - worker-2
execution:
  mode: dry_run

budget:
  daily: { cents: 5000, tokens: 3_000_000 }
  hourly: { cents: 1000 }
```

Place these in your project root or in `~/.clawforce/`.

Key concepts:
- **`extends`** inherits a role preset (`manager`, `employee`, `assistant`)
- **`reports_to`** establishes the org hierarchy
- **`briefing`** controls what context the agent sees at session start
- **`coordination.schedule`** sets the cron for manager wake cycles

## Set Your Budget

Budget enforcement is the core safety mechanism. Three dimensions (cents, tokens, requests) across five windows (hourly, daily, monthly, session, task). Any breach blocks dispatch immediately.

If you only remember one thing on first read, remember this: the budget gate is
the first proof that ClawForce is governing the team rather than just wrapping
another runtime.

Set via YAML (shown above) or CLI:

```bash
pnpm cf config set budget.project.daily.cents 5000 --domain=my-team
pnpm cf config set budget.project.hourly.cents 1000 --domain=my-team
```

For per-agent limits, add to the domain YAML:

```yaml
budgets:
  project:
    daily: { cents: 10000 }
  agents:
    worker-1:
      daily: { cents: 2000 }
      session: { cents: 500 }
```

## Start It Up

### Direct Codex Execution (start here)

If you omit `dispatch.executor`, ClawForce defaults to the direct `codex`
executor. This is the canonical start path for new setups.

```typescript
import { Clawforce } from "clawforce";

const cf = Clawforce.init({ domain: "my-team" });

const task = cf.tasks.create({
  title: "Build login page",
  assignedTo: "worker-1",
  group: "engineering",
});

cf.dispatch.enqueue(task.id, { agentId: "worker-1" });

cf.events.on("task_completed", (e) => {
  console.log(`Task done by ${e.payload.agentId}`);
});
```

Start with the domain in `dry_run`, verify routing and decision surfaces, and
only then move to `live`.

### Operator Surfaces

Use the dashboard as the primary operator surface for budgets, tasks, approvals,
and health. Use Codex as the primary conversational surface.

The two should describe the same governed system, not competing products.

### With OpenClaw (optional bridge)

When used with OpenClaw, ClawForce acts as a compatibility bridge. Use this
path only when you specifically want OpenClaw's gateway, channels, or plugin
lifecycle on top of the same ClawForce governance model. Prefer `overlay` mode
unless you are intentionally in a migration state.

### Canonical Use Cases

The two clearest places to start are:

- a governed coding-agent team
- an onboarding or ops pipeline with staged rollout from `dry_run` to `live`

### Positioning Summary

Use ClawForce when your problem is:

- budget enforcement
- review and approval gates
- trust and escalation
- team coordination over time
- operator visibility and intervention

Do not expect ClawForce to be the strongest choice for model-native tool
calling, low-code workflow authoring, or multimodal agent UX by itself.

## Monitor Your Team

All CLI commands accept `--domain=ID` (defaults to `clawforce-dev`).

```bash
pnpm cf status --domain=my-team
```

```
## ClawForce Status

Gateway:     running (PID 41823)
Budget:      $12.40 / $50.00 daily (25%)
Burn rate:   $1.20 / 14 calls in last hour

Tasks:
  ASSIGNED       3
  IN_PROGRESS    1
  REVIEW         2

Queue:
  queued         2
  dispatched     1
```

Other monitoring commands:

```bash
pnpm cf dashboard --domain=my-team    # Full overview with anomaly detection
pnpm cf watch --domain=my-team        # Only what changed since last check
pnpm cf org --domain=my-team          # Live org tree with runtime status
pnpm cf costs --domain=my-team        # Cost breakdown by agent
pnpm cf health --domain=my-team       # Comprehensive health check
```

When you are ready for operator UI instead of CLI output, open the dashboard and
use it as the primary control plane.

## Common Operations

### Check on tasks

```bash
pnpm cf tasks --domain=my-team              # All active tasks
pnpm cf tasks REVIEW --domain=my-team       # Only tasks in REVIEW
```

### Review proposals

```bash
pnpm cf proposals --domain=my-team          # Pending proposals
pnpm cf approve <proposal-id>               # Approve one
pnpm cf reject <proposal-id> --feedback="Scope too broad"
```

### Send a message to an agent

```bash
pnpm cf message lead "Prioritize the auth feature" --domain=my-team
```

### Pause and resume

```bash
pnpm cf disable --reason="Deploying" --domain=my-team   # Block new dispatches
pnpm cf enable --domain=my-team                          # Resume

pnpm cf kill --reason="Runaway costs" --domain=my-team   # Emergency stop
pnpm cf kill --resume --domain=my-team                   # Clear emergency stop
```

## Next Steps

- **[CLI Reference](CLI.md)** -- full command reference with all flags
- **[Config Reference](CONFIG_REFERENCE.md)** -- every configurable field documented
- **[API Reference](API.md)** -- SDK namespace documentation
