# clawforce

Accountability layer for autonomous AI agents — treats them like employees with titles, departments, reporting chains, performance expectations, and consequences. Built for the [OpenClaw](https://github.com/openclaw/openclaw) ecosystem.

## Key Features

- **Hire AI employees** with full profiles: title, model, persona, department, team, permissions
- **Org hierarchy** with reporting chains via `reports_to`, forming manager-to-employee structures
- **Accountability enforcement** -- agents must meet expectations (deliverables) or face performance policy (retry, escalate, terminate)
- **Context briefing** -- each role gets default context sources injected automatically at session start
- **Task lifecycle** -- full state machine: OPEN, ASSIGNED, IN_PROGRESS, REVIEW, DONE
- **Workflows** -- multi-phase execution with automatic gating between phases
- **Shared memory** -- agents search and retrieve learnings across sessions via OpenClaw's RAG engine (vector embeddings, hybrid BM25+vector search)
- **Skill system** -- role-aware domain knowledge generated from source code, never drifts from reality
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
    role: manager
    title: VP of Sales
    model: claude-opus-4-6
    persona: "You manage the sales team. Focus on pipeline growth."
    department: sales
    channel: telegram
    reports_to: parent
    briefing:
      - source: task_board
      - source: knowledge
    expectations:
      - tool: clawforce_log
        action: write
        min_calls: 1
    performance_policy:
      action: alert

  lead-gen:
    role: scheduled
    title: Lead Generation Specialist
    model: claude-sonnet-4-6
    department: sales
    team: outreach
    reports_to: sarah
    expectations:
      - tool: clawforce_log
        action: outcome
        min_calls: 1
    performance_policy:
      action: retry
      max_retries: 3
      then: terminate_and_alert
```

## Agent Roles

Every agent is assigned one of three roles, each with sensible defaults for briefing and behavior.

### Manager

Coordinates the team. Creates tasks, reviews work, handles escalations.

Default briefing includes: `project_md`, `task_board`, `escalations`, `workflows`, `activity`, `sweep_status`, `proposals`, `agent_status`, `knowledge`, `memory`, `cost_summary`, `policy_status`, `health_status`, `team_status`.

### Employee

Completes assigned tasks. Focused and narrow -- sees only its assigned work.

Default briefing includes: `assigned_task`, `memory`. Must transition tasks to a terminal state when done.

### Scheduled

Runs on a schedule (cron-style). Must report an outcome each run.

Default briefing includes: `memory`.

## Agent Profiles

Each agent definition supports:

| Field | Description |
|-------|-------------|
| `role` | `manager`, `employee`, or `scheduled` |
| `title` | Job title (e.g., "VP of Sales", "Lead Generation Specialist") |
| `model` | Which AI model to use (e.g., `claude-opus-4-6`, `claude-sonnet-4-6`) |
| `persona` | Natural language persona injected into the agent's prompt |
| `department` | Organizational department (e.g., `sales`, `engineering`) |
| `team` | Sub-team within a department (e.g., `outreach`, `backend`) |
| `channel` | Notification channel (e.g., `telegram`) |
| `reports_to` | Agent ID this agent reports to, or `parent` for the top-level session |
| `briefing` | Context sources injected at session start |
| `expectations` | Required tool calls the agent must make before finishing |
| `performance_policy` | What happens when expectations are not met |

## Org Hierarchy

Agents form reporting chains through the `reports_to` field. This creates a real organizational structure:

```
parent (user session)
  └── sarah (VP of Sales, manager)
        └── lead-gen (Lead Generation Specialist, scheduled)
        └── closer (Account Executive, employee)
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

Context briefing injects information into an agent's prompt at session start. Each role has defaults, and agents can add or exclude sources.

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

Agents can customize their briefing:

```yaml
agents:
  sarah:
    role: manager
    exclude_context:
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
