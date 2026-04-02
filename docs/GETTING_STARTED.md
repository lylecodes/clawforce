# Getting Started with ClawForce

## What is ClawForce?

ClawForce is a governance SDK for autonomous AI agents. Budget enforcement, task orchestration, trust scoring, approval flows, and coordination -- so you can run multi-agent teams without them burning your wallet or producing unsupervised work. In-process, backed by SQLite. No infrastructure.

## Prerequisites

- **Node.js 22+** (required for `node:sqlite`)
- **npm** or another package manager
- Optional: [OpenClaw](https://github.com/openclaw/openclaw) for full agent runtime (cron scheduling, channel delivery, automatic cost capture)

## Install

```bash
npm install clawforce
```

## Define Your Team

Create two config files. A domain is an isolated workspace -- one database, one team, one budget.

**`config.yaml`** -- agent definitions:

```yaml
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
orchestrator: lead
agents:
  - lead
  - worker-1
  - worker-2

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

### SDK (standalone)

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

### With OpenClaw (full runtime)

When used with OpenClaw, ClawForce acts as a plugin. The runner handles dispatch, cron scheduling, and session management automatically. Start the runner for your domain and the agents begin working.

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
