# ClawForce — Claude Context

Governance SDK for autonomous AI agent teams. Budget enforcement, trust scoring, task orchestration, approval flows, event-driven coordination. Framework-agnostic, zero infrastructure.

## Quick Reference

- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js 22+ (uses `node:sqlite`)
- **Test framework:** Vitest (`npx vitest --run`)
- **Build:** `npx tsc --noEmit` (type check only, no build step)
- **CLI:** `npx tsx src/cli.ts <command>` (aliased as `cf` when running via OpenClaw)
- **DB:** SQLite via `DatabaseSync` — schema version 41, migrations in `src/migrations.ts`
- **Config:** YAML files in `~/.clawforce/` (config.yaml for agents, domains/*.yaml for domains)

## Architecture

```
src/
├── cli.ts + cli/org.ts    # CLI commands (40+), all exported for testing
├── sdk/                   # Public SDK (agents, tasks, goals, budget, events, messages, approvals)
├── tasks/                 # Task state machine, ops, lifecycle
├── dispatch/              # Event-driven dispatch, queue, cron
├── budget/                # 3-dimension budget (hourly/daily/monthly), pacing, reservations
├── memory/                # Ghost turn recall, persist rules, MCP provider support
├── context/               # Context assembly, source registry, priority truncation
├── monitoring/            # SLOs, anomaly detection, alerts, health tiers
├── verification/          # Git-based verification gates (typecheck, build, test)
├── trust/                 # Trust scoring, earned autonomy
├── events/                # Event router, subscriptions
├── sweep/                 # Periodic cleanup, stale detection, deadline enforcement
├── tools/                 # Agent-facing tools (config, task, ops, verify, context)
├── config/                # Config loading, validation, inference, schema
├── risk/                  # Risk classification, safety gates
├── org.ts                 # Org hierarchy helpers
├── project.ts             # Project/agent registry
└── adapters/openclaw.ts   # OpenClaw integration adapter
```

## Key Patterns

- **CLI-first:** All config must be manageable via CLI. Never require manual YAML editing.
- **Config tool has authorization:** Role-based — agents can't escalate privileges.
- **DB is optional for CLI:** `cf org`, `cf config` work without a running database.
- **Functions export for testing:** CLI functions are exported with `__isMain` guard.
- **Sweep runs periodically:** Handles deadlines, stale tasks, budget resets, cleanup.
- **Context is priority-ranked:** When truncated, drops low-priority sources first.
- **Memory is configurable:** Per-agent recall intensity, persist rules, MCP provider support (RetainDB, Mem0).

## Testing

```bash
npx vitest --run                    # Full suite (4258 tests, ~19s)
npx vitest --run test/tasks/        # Test one module
npx vitest --run --reporter=verbose # See all test names
```

## CLI Commands

Full reference: `docs/CLI.md`

Key commands: `cf status`, `cf dashboard`, `cf watch`, `cf org`, `cf org check`, `cf tasks`, `cf costs`, `cf metrics`, `cf budget`, `cf health`

All support `--json` for machine-readable output. Mutating commands support `--dry-run`.

**Kill switch:** `cf kill --reason="..."` — emergency stop that blocks ALL tool calls from managed agents. Agents can think but can't act. `cf kill --resume` to clear.

## Config Structure

- `~/.clawforce/config.yaml` — Global agent definitions (extends, reports_to, department, team, persona, coordination, observe, jobs)
- `~/.clawforce/domains/<name>.yaml` — Domain config (agent list, budget, dispatch, operational profile)
- `~/.clawforce/domains/<name>/context/` — DIRECTION, STANDARDS, POLICIES, ARCHITECTURE per team

Full reference: `docs/CONFIG_REFERENCE.md`

## Dashboard

7 views served at `/clawforce/` via OpenClaw gateway:
- **Monitor** — single-page widget dashboard (org tree, budget, pipeline, activity, performance, alerts, health)
- **Tasks** — kanban board with drag-drop state transitions
- **Approvals** — risk-based approval workflow
- **Org Chart** — full agent hierarchy with runtime status
- **Comms** — agent messaging, inbox, threads
- **Config** — domain config editor, context file editor, memory settings
- **Experiments** — A/B experiment tracking

Tab selector (gear icon) lets users customize which views appear.

## Important Rules

- **Never modify OpenClaw codebase** or write unrecognized keys to openclaw.json
- **Always dispatch subagents** for implementation work
- **Target cf-*/dash-* only** for process management — never kill all openclaw processes
- **Context files:** ARCHITECTURE = any agent, STANDARDS = manager, DIRECTION/POLICIES = human only
