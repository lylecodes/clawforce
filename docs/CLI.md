# ClawForce CLI Reference

Operational diagnostics and runtime control for ClawForce domains.

```
Usage: pnpm cf <command> [options]
```

All commands accept `--domain=ID` (or `--project=ID`) to target a specific domain. Defaults to `clawforce-dev`.

For repo development, `pnpm cf`, `pnpm build`, `pnpm test`, and `pnpm typecheck` all run through the runtime pinned in `.nvmrc`. Use `pnpm runtime:doctor` if your shell Node and the repo runtime drift apart.

## Quick Reference

| Command | Purpose |
|---------|---------|
| `cf status` | System vitals -- gateway, budget, tasks, queue |
| `cf dashboard` | Full overview with anomaly detection |
| `cf tasks` | Active tasks with states and assignees |
| `cf costs` | Cost breakdown by agent, task, or day |
| `cf queue` | Dispatch queue health and failure reasons |
| `cf transitions` | Recent state transitions |
| `cf errors` | Recent errors and failed dispatches |
| `cf agents` | Agent activity and session history |
| `cf streams` | List available data streams |
| `cf query` | Raw SQL against the project database |
| `cf sessions` | Recent sessions with cost summary |
| `cf session` | Drill into a single session |
| `cf proposals` | List proposals by status |
| `cf flows` | Per-session action timeline |
| `cf metrics` | Per-agent efficiency metrics |
| `cf budget` | Budget pacing and projections |
| `cf trust` | Per-agent trust scores |
| `cf inbox` | User messages from/to agents |
| `cf approve` | Approve a pending proposal |
| `cf reject` | Reject a pending proposal |
| `cf verdict` | Submit a human review verdict for a task in `REVIEW` |
| `cf message` | Send a message to an agent |
| `cf replay` | Replay session tool calls with full I/O |
| `cf watch` | Curated feed -- only what changed since last check |
| `cf disable` | Block new dispatches |
| `cf enable` | Resume dispatches |
| `cf kill` | Emergency stop |
| `cf config` | Read and write configuration |
| `cf org` | Org tree with runtime status |
| `cf running` | Current runtime state |
| `cf health` | Comprehensive health check |
| `pnpm runtime:doctor` | Diagnose shell/runtime/native-addon mismatches |

---

## Diagnostics

### `cf status`

System vitals: gateway process, budget usage, task counts by state, dispatch queue.

```
pnpm cf status
```
```
Gateway:     running (PID 41823)
Budget:      $12.40 / $50.00 daily (25%)
Burn rate:   $1.20 / 14 calls in last hour
Tasks:   ASSIGNED 3 | IN_PROGRESS 1 | REVIEW 2
Queue:   queued 2 | completed 6
```

### `cf tasks [STATE]`

Active tasks (excludes DONE/CANCELLED). Pass a state to filter: `OPEN`, `ASSIGNED`, `IN_PROGRESS`, `REVIEW`, `DONE`, `FAILED`, `BLOCKED`, `CANCELLED`.

```
pnpm cf tasks
pnpm cf tasks REVIEW
```

### `cf costs [--by=agent|task|day] [--hours=N]`

Cost breakdown. Defaults to by-agent, last 24 hours. Shows per-model token usage, cache stats, and percentage of total.

```
pnpm cf costs                        # By agent, last 24h
pnpm cf costs --by=task              # By task
pnpm cf costs --by=day --hours=168   # Daily for last 7 days
```

### `cf queue`

Dispatch queue health: items by status and failure reasons for recent failures.

### `cf transitions [--hours=N]`

Recent state transitions (default: last 4 hours). Catches silent failures and unexpected changes.

### `cf errors [--hours=N]`

Recent errors, failed dispatches, and stuck transitions (default: last 4 hours).

### `cf agents`

Agent activity: session counts, costs, last active time, and current task assignments.

### `cf streams`

List available data streams for use as context sources in agent briefings.

### `cf query "SQL"`

Raw SQL against the project database.

```
pnpm cf query "SELECT state, COUNT(*) FROM tasks GROUP BY state"
```

---

## Visibility Suite

### `cf dashboard [--hours=N]`

The single-command answer. Anomalies, agent status, task summary, budget, recent activity. Default: last 24h.

```
pnpm cf dashboard
pnpm cf dashboard --hours=4
```
```
## Anomalies
  !!  worker-1 has 3 failed tasks in last 2h
## Dashboard (last 24h)  |  12 sessions  |  $14.90 total cost
## Agent Status
  lead                   3 sessions     $6.70  22 tools  last: 12min ago
  worker-1               5 sessions     $8.20  45 tools  last: 4min ago
  worker-2               -- idle (no sessions in window)
```

### `cf sessions [--hours=N] [--agent=X]`

Recent sessions with cost and output summary.

### `cf session <key>`

Drill into one session: tool calls, state transitions, cost, outcome.

### `cf proposals [--status=pending|approved|rejected|all]`

Proposals with status, proposer, origin, and reasoning. Default: pending.

```
pnpm cf proposals --status=all
```

### `cf flows [--hours=N] [--agent=X] [--expand]`

Per-session action timeline: tool calls, transitions, costs. Use `--expand` for full detail.

### `cf metrics [--hours=N]`

Per-agent efficiency: sessions, cost per session, tool calls, task completions.

### `cf budget`

Budget pacing: current spend vs limits, burn rate, estimated time to exhaustion.

### `cf trust`

Per-agent trust scores by category (quality, reliability, etc.) and overall.

### `cf inbox`

User messages sent to and received from agents.

### `cf approve <id>` / `cf reject <id> [--feedback="reason"]`

Approve or reject a pending proposal. First 8 characters of the UUID are sufficient.

```
pnpm cf approve a3f8c2d1
pnpm cf reject a3f8c2d1 --feedback="Too broad"
```

### `cf verdict <task-id> --pass|--fail [--reason="note"]`

Submit the operator review decision for a task already in `REVIEW`. This is the customer-path lever for human review, not an internal admin shortcut. On success, ClawForce drains follow-on workflow so linked entity issues and feed state stay current.

```bash
pnpm cf verdict 0f10e6b3 --pass --reason="Evidence is sufficient"
pnpm cf verdict 0f10e6b3 --fail --reason="Pipeline still fails locally"
```

### `cf message <agent> "text"`

Send a message to an agent. Delivered via `pending_messages` context source on next session.

```
pnpm cf message lead "Prioritize the auth feature"
```

### `cf replay <key>`

Replay session tool calls with full I/O. More detailed than `cf session`.

### `cf watch [--reset]`

What changed since your last check: completions, proposals, active sessions, anomalies, budget warnings. Use `--reset` to clear the timestamp.

```
pnpm cf watch
```

---

## Runtime Control

### `cf disable [--reason=MSG]`

Block new dispatches. Running sessions finish naturally.

```
pnpm cf disable --reason="Deploying new version"
```

### `cf enable`

Resume dispatches on next dispatch loop pass.

### `cf kill [--reason=MSG]`

Emergency stop — the real kill switch. Four layers of protection:

1. **Domain disabled** — blocks all new dispatches immediately
2. **Emergency stop flag** — persistent in DB, survives gateway restarts
3. **Queue cancelled** — all pending/leased dispatch items dropped
4. **All tool calls blocked** — every Bash, Write, Edit, Read from any managed agent returns `EMERGENCY STOP`. Agents can think but can't act.

Running sessions will burn some tokens on thinking but cannot execute any tools. They die when they hit the context limit or retry cap.

```
pnpm cf kill --reason="Agent doing something destructive"
pnpm cf kill --dry-run    # preview what would happen
```

### `cf kill --resume`

Clear emergency stop flag, re-enable domain, resume dispatches. Tool calls are unblocked immediately.

---

## Config

### `cf config get <dotpath>`

Read a config value using dot-notation. Add `--global` for `config.yaml` instead of domain YAML.

```
pnpm cf config get dispatch.mode
pnpm cf config get budget.project.daily.cents
pnpm cf config get agents --global
```

### `cf config set <dotpath> <value>`

Write a config value. Auto-detects type (number, boolean, string).

```
pnpm cf config set budget.project.daily.cents 5000
pnpm cf config set dispatch.budget_pacing.enabled true
```

### `cf config show [section]`

Show full resolved config or a specific section.

```
pnpm cf config show
pnpm cf config show dispatch
pnpm cf config show agents --global
```

---

## Org

### `cf org [--team=X] [--agent=X]`

Live org tree with runtime status per agent (active, idle, disabled). Filter by team or agent.

```
pnpm cf org
pnpm cf org --team=engineering
```

### `cf org set <agent> --reports-to <manager|none>`

Rewire reporting chain. Use `none` to detach.

```
pnpm cf org set worker-1 --reports-to=lead
```

### `cf org check`

Structural and operational audit: orphaned agents, missing managers, circular chains.

```
pnpm cf org check
```

---

## Verification

### `cf running`

Live runtime state: domain status, emergency stop, active sessions, disabled agents/scopes, queue, recent transitions, active dispatches, cron metadata.

```
pnpm cf running
```
```
Domain: enabled
Active Sessions: 2
  worker-1 (3min) key=abc123def456789012...
  lead (12min) key=def456abc789012345...
Queue:   queued 1 | dispatched 1
```

### `cf health`

Comprehensive health check: gateway, budget, stuck tasks, stale sessions, queue, config validation.

```
pnpm cf health
```
```
  [OK] Gateway running (PID 41823)
  [OK] Budget configured: $50.00/day
  [WARN] 1 session older than 30min
  [OK] Config valid
1 warning, 0 errors
```

---

## Global Options

| Option | Description |
|--------|-------------|
| `--domain=ID` | Target domain (default: `clawforce-dev`) |
| `--project=ID` | Alias for `--domain` |
| `--global` | (config commands only) Target `config.yaml` instead of domain YAML |
