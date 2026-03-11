# clawforce

Accountability layer for autonomous AI agents — treats them like employees with titles, departments, reporting chains, performance expectations, and consequences. Built for the [OpenClaw](https://github.com/openclaw/openclaw) ecosystem.

## Key Features

- **Hire AI employees** with full profiles: title, model, persona, department, team, permissions
- **Org hierarchy** with reporting chains via `reports_to`, forming manager-to-employee structures
- **Accountability enforcement** -- agents must meet expectations (deliverables) or face performance policy (retry, escalate, terminate)
- **Config inheritance** -- agents inherit from presets (`extends: manager`) with merge operators for composable config
- **Task lifecycle** -- full state machine: OPEN, ASSIGNED, IN_PROGRESS, REVIEW, DONE
- **Workflows** -- multi-phase execution with automatic gating between phases
- **Shared memory** -- agents search and retrieve learnings across sessions via OpenClaw's RAG engine (vector embeddings, hybrid BM25+vector search)
- **Skill system** -- preset-aware domain knowledge generated from source code, never drifts from reality
- **Cost tracking** -- token spending by agent and task, with budget enforcement
- **Policy enforcement** -- approval flows, risk classification, SLO monitoring
- **Sweep service** -- background process detects stale work, enforces deadlines, kills stuck agents

## Quick Start

Install:

```bash
pnpm install
```

Create a `project.yaml` to define your AI workforce:

```yaml
name: my-project

agents:
  sarah:
    extends: manager
    title: VP of Sales
    model: claude-opus-4-6
    persona: "You manage the sales team. Focus on pipeline growth."
    department: sales
    channel: telegram
    reports_to: parent

  lead-gen:
    extends: employee
    title: Lead Generation Specialist
    model: claude-sonnet-4-6
    department: sales
    team: outreach
    reports_to: sarah
    jobs:
      daily-outreach:
        cron: "0 9 * * MON-FRI"
        nudge: "Run today's lead generation campaign."
```

## Config Inheritance

Agents inherit from **presets** using `extends:`. Two builtin presets ship with the system:

### `manager` preset

Coordinates the team. Creates tasks, reviews work, handles escalations.

- Full operational briefing (task_board, escalations, team_status, cost_summary, etc.)
- Coordination enabled (periodic wake-up cron)
- Compaction enabled
- Performance policy: alert on non-compliance

### `employee` preset

Completes assigned tasks. Focused and narrow.

- Task-focused briefing (assigned_task, memory, skill)
- Must transition tasks to a terminal state
- Performance policy: retry 3x then alert

### User-defined presets

Define reusable templates for similar agents:

```yaml
presets:
  sales-rep:
    extends: employee
    skills: [lead-gen, crm-integration]
    performance_policy: { action: retry, max_retries: 2, then: alert }

agents:
  rep-west:
    extends: sales-rep
    title: West Coast Rep
    reports_to: sarah

  rep-east:
    extends: sales-rep
    title: East Coast Rep
    reports_to: sarah
    skills: ["+enterprise-contracts", "-crm-integration"]  # merge operators
```

### Merge operators

Arrays support `+` (append) and `-` (remove) operators for composing config without full replacement:

```yaml
agents:
  custom-manager:
    extends: manager
    briefing: ["+initiative_progress", "-sweep_status"]  # add one, remove one
```

Plain arrays (without operators) fully replace the parent's array.

### Job presets

Jobs also support `extends:` with two builtin presets:

- **`reflect`** — weekly strategic review (budget, performance, team health)
- **`triage`** — frequent coordination cycle (task board, escalations)

```yaml
agents:
  eng-lead:
    extends: manager
    jobs:
      weekly-review:
        extends: reflect
        cron: "0 9 * * FRI"
```

## Agent Config

Each agent definition supports:

| Field | Description |
|-------|-------------|
| `extends` | Preset to inherit from (`manager`, `employee`, or custom) |
| `title` | Job title (e.g., "VP of Sales") |
| `model` | AI model (e.g., `claude-opus-4-6`, `claude-sonnet-4-6`) |
| `persona` | Natural language persona injected into the prompt |
| `department` | Organizational department (e.g., `sales`, `engineering`) |
| `team` | Sub-team within a department (e.g., `outreach`, `backend`) |
| `channel` | Notification channel (e.g., `telegram`) |
| `reports_to` | Agent ID this agent reports to, or `parent` for top-level |
| `briefing` | Context sources (supports `+`/`-` merge operators) |
| `expectations` | Required tool calls before session ends |
| `performance_policy` | Consequences for non-compliance |
| `coordination` | `{ enabled: true, schedule: "*/30 * * * *" }` for managers |
| `jobs` | Recurring jobs with cron schedules |

## Org Hierarchy

Agents form reporting chains through `reports_to`:

```
parent (user session)
  └── sarah (VP of Sales, extends: manager)
        └── lead-gen (Lead Generation Specialist, extends: employee)
        └── closer (Account Executive, extends: employee)
```

When an agent fails or needs escalation, the issue routes up the reporting chain. A manager receives escalation context in their briefing so they can act on team failures.

Departments and teams provide logical grouping for cost tracking, policy enforcement, and monitoring.

## Accountability

### Expectations

Every agent has expectations -- required tool calls that must happen before the session ends:

```yaml
expectations:
  - tool: clawforce_log
    action: write
    min_calls: 1
  - tool: clawforce_task
    action: [transition, fail]
    min_calls: 1
```

If an agent finishes without meeting its expectations, it is flagged non-compliant.

### Performance Policy

The `performance_policy` defines consequences for non-compliance:

| Action | Behavior |
|--------|----------|
| `retry` | Re-run the agent with "you didn't do X" context. Set `max_retries`. |
| `alert` | Notify via messaging channel. |
| `escalate` | Route the failure up to the `reports_to` agent. |
| `terminate_and_alert` | Kill the agent and notify. Used as the `then` action after retries exhaust. |

```yaml
performance_policy:
  action: retry
  max_retries: 3
  then: terminate_and_alert
```

Retry counting is durable (SQLite-backed, 4-hour window, hard cap of 10).

## Context Sources

Context briefing injects information into an agent's prompt at session start. Each preset has defaults, and agents can add or exclude sources using merge operators.

| Source | Description |
|--------|-------------|
| `instructions` | Auto-generated from `expectations` (always injected) |
| `custom` | Raw markdown string via `content` field |
| `project_md` | Contents of `PROJECT.md` from the project directory |
| `task_board` | Active tasks grouped by state |
| `assigned_task` | Full task details for this agent's assigned work |
| `knowledge` | Knowledge base entries (filterable by category, tags) |
| `memory` | Directs agents to use `memory_search` and `memory_get` RAG tools |
| `skill` | Role-filtered domain knowledge (table of contents at session start) |
| `file` | File contents from the project directory |
| `escalations` | Failed tasks that exhausted retries |
| `workflows` | Active workflows with per-phase progress |
| `activity` | Recent state transitions |
| `sweep_status` | Stale tasks and approaching deadlines |
| `proposals` | Pending approval proposals |
| `agent_status` | Active sessions, stuck agents, disabled agents |
| `cost_summary` | Token spending by agent and task |
| `policy_status` | Active policies and recent violations |
| `health_status` | SLO evaluations and alert status |

Agents can customize their briefing using merge operators:

```yaml
agents:
  sarah:
    extends: manager
    briefing: ["-sweep_status", "-health_status", "+custom"]
```

Or with full source objects for advanced config:

```yaml
agents:
  sarah:
    extends: manager
    exclude_briefing:
      - sweep_status
      - health_status
    briefing:
      - source: custom
        content: "Always prioritize pipeline deals closing this week."
      - source: file
        path: "SALES_PLAYBOOK.md"
```

## Shared Memory (RAG)

Agents search and retrieve persistent learnings via OpenClaw's native RAG memory engine. Two tools are available:

| Tool | Purpose |
|------|---------|
| `memory_search` | Semantic search using hybrid BM25 + vector similarity with MMR re-ranking |
| `memory_get` | Retrieve a specific memory entry by ID |

The `memory` context source injects guidance directing agents to use these tools on-demand rather than pre-loading memories. OpenClaw handles persistence, embedding, and lifecycle management automatically.

## Task Lifecycle

Tasks follow a strict state machine:

```
OPEN --> ASSIGNED --> IN_PROGRESS --> REVIEW --> DONE
```

With additional states: BLOCKED, FAILED, CANCELLED. Policy rules enforced by the state machine:

- **Evidence required** -- moving to REVIEW requires at least one evidence attachment
- **Verifier gate** -- REVIEW to DONE requires a different agent than the assignee
- **Retry limit** -- FAILED to OPEN is blocked when retries are exhausted
- **Workflow phase gate** -- tasks in future phases are blocked from starting

## Initiatives & Budget Allocation

Goals with an `allocation` field are **initiatives** — strategic priorities with hard budget enforcement.

### Config

```yaml
budget:
  daily_limit_cents: 2000

goals:
  ui-improvements:
    allocation: 40
    description: "Dashboard UX improvements"
    department: engineering
  customer-outreach:
    allocation: 30
    description: "Daily lead gen and follow-ups"
    department: sales
```

Allocations are percentages of the project's daily budget. Unallocated remainder (here 30%) serves as reserve for ad-hoc work.

### Hard Gate

When an initiative's spend reaches its allocation, dispatch is **blocked** for all tasks under that goal tree. The gate traces tasks up the goal hierarchy to find their root initiative.

### Cascading Budget

Budget flows uniformly through the agent tree. Coordination agents allocate portions of their budget to reports. Each allocation is bounded by the parent's remaining allocatable budget.

| Tool | Action | Purpose |
|------|--------|---------|
| `clawforce_goal` | `create` with `allocation` | Create an initiative |
| `clawforce_goal` | `status` | See budget spend for initiative |
| `clawforce_ops` | `allocate_budget` | Allocate budget to a report |

## Tools

| Tool | Purpose |
|------|---------|
| `clawforce_task` | Create tasks, transition states, attach evidence, manage proposals |
| `clawforce_log` | Write knowledge entries, log outcomes, search history |
| `clawforce_verify` | Request verification, submit pass/fail verdicts |
| `clawforce_workflow` | Create and manage multi-phase workflows |
| `clawforce_setup` | Onboard projects, validate configs, activate |
| `clawforce_compact` | Session compaction for long-running agents |
| `clawforce_ops` | Operational actions (enqueue work, process events, kill agents) |
| `memory_search` | Semantic search for relevant memories from previous sessions (OpenClaw RAG) |
| `memory_get` | Retrieve a specific memory entry by ID (OpenClaw RAG) |

## Installation

```bash
pnpm install
```

Requires Node 22+ (for `node:sqlite`).
