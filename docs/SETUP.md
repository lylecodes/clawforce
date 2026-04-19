# ClawForce Setup Guide

Comprehensive onboarding documentation for setting up ClawForce on a project. Written for technical operators and coding agents helping them bootstrap a real governed team.

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Concepts](#concepts)
4. [Configuration Reference](#configuration-reference)
5. [Templates](#templates)
6. [Agent Roles](#agent-roles)
7. [Operational Profiles](#operational-profiles)
8. [Examples](#examples)
9. [Tools Reference](#tools-reference)
10. [Troubleshooting](#troubleshooting)

---

## Overview

ClawForce is the governance and control plane for agent teams: budgets,
approvals, trust, audit, and operator control above any runtime.

Direct Codex/OpenAI execution is the canonical start path. OpenClaw remains an
optional compatibility bridge, not the default.

- **Task lifecycle management** -- tasks move through OPEN, ASSIGNED, IN_PROGRESS, REVIEW, DONE/FAILED states with full audit trails
- **Budget enforcement** -- per-project and per-agent spend limits (daily, session, task)
- **Org structure** -- manager/employee/verifier roles with reporting chains and escalation paths
- **Auto-lifecycle** -- employees do not need ClawForce tools; task transitions, evidence capture, and review dispatches happen automatically
- **Trust scoring** -- agents build reputation through successful task completion
- **Policy enforcement** -- action scopes, transition gates, spend limits, approval requirements
- **Coordination scheduling** -- managers wake on cron schedules to triage, plan, and review

ClawForce does NOT replace your agent platform. It layers governance on top of
it.

That boundary matters:

- your runtime/framework should own execution
- ClawForce should own budgets, approvals, trust, task state, and operator
  control

The canonical onboarding path is:

1. start with direct Codex execution
2. scaffold the domain in `dry_run`
3. verify routing, intended mutations, and decision surfaces
4. use the dashboard as the primary operator surface
5. move the domain to `live` only when the control plane is boring and honest

### Architecture at a Glance

```
User / Dashboard
       |
   ClawForce (governance layer)
       |
   +---------+---------+
   | Manager | Manager |   <-- coordinate, plan, delegate
   +---------+---------+
       |           |
   +-------+   +-------+
   | Worker |   | Worker |  <-- execute tasks, report results
   +-------+   +-------+
       |
   +----------+
   | Verifier |  <-- verify completed work
   +----------+
```

### Key Files

| File | Purpose |
| --- | --- |
| `config.yaml` | Shared agent roster, mixins, and global defaults |
| `domains/<domain>.yaml` | Domain membership plus domain-specific budgets, policies, rules, and paths |
| `agents/<id>/SOUL.md` | Per-agent identity and domain expertise (auto-scaffolded) |
| `DIRECTION.md` | Team vision, constraints, and autonomy level |
| `STANDARDS.md` | Coding and quality standards for the team |
| `ARCHITECTURE.md` | Technical architecture documentation |

---

## Quick Start

The fastest path to a working ClawForce setup. This uses the `startup` template which creates a lean team: one manager (lead), one developer, and one agent-builder.

### Prerequisites

- Node.js 22.22+
- Codex CLI configured and authenticated
- Optional: OpenClaw configured only if you explicitly want its gateway or plugin runtime
- Agent IDs for each agent you want to govern (these must match your platform's agent configuration)

For ClawForce repo development, use the pinned runtime from `.nvmrc` (`25.6.1`). The package scripts enforce that runtime automatically.

### Step 1: Install ClawForce

```bash
npm install clawforce
```

### Step 2: Create the Config Directory

ClawForce config lives under a configurable `projectsDir`. Each environment has a shared `config.yaml` plus one file per domain under `domains/`.

```bash
mkdir -p <projectsDir>/my-project
```

### Step 3: Write config.yaml and the Domain File

Create `<projectsDir>/config.yaml`:

```yaml
agents:
  lead:
    extends: manager
    title: Team Lead

  dev-1:
    extends: employee
    title: Developer
    reports_to: lead
```

Create `<projectsDir>/domains/my-project.yaml`:

```yaml
domain: my-project
paths:
  - /path/to/your/project/code
execution:
  mode: dry_run
agents:
  - lead
  - dev-1
manager:
  enabled: true
  agentId: lead
budget:
  project:
    daily: { cents: 5000 }
```

### Step 4: Validate the Config

Use the `clawforce_setup` tool with action `validate`:

```
clawforce_setup action=validate yaml_content="<paste your YAML>"
```

Or validate from a file path:

```
clawforce_setup action=validate config_path="<projectsDir>"
```

### Step 5: Activate the Project

```
clawforce_setup action=activate project_id="my-project"
```

This registers the project, creates the database, scaffolds `SOUL.md` templates for each agent, registers policies, and starts coordination schedules.

### Step 6: Scaffold Agent Identity

```
clawforce_setup action=scaffold project_id="my-project"
```

This creates `agents/<agent-id>/SOUL.md` files for each agent. Edit these to customize each agent's persona and domain knowledge.

Starter domains and onboarding scaffolds now default to:

```yaml
execution:
  mode: dry_run
  default_mutation_policy: simulate
```

That is intentional. The expected setup flow is configure first, verify routing
and intended mutations in `dry_run`, then move the domain to `live` once the
control plane is boring and trustworthy.

`dry_run` and `shadow` are different:

- `dry_run` controls whether side effects are simulated or blocked
- `shadow` is a workflow or entity state meaning "real workflow, not yet authoritative"

Do not present `shadow` as a top-level product mode. It is part of rollout and
authority modeling, not a substitute for domain execution mode.

### What Happens Next

- The manager agent (`lead`) wakes on its coordination schedule
- It reads the task board, processes escalations, and delegates work
- Employee agents (`dev-1`) receive tasks via dispatch and execute them
- Task transitions, evidence capture, and review happen automatically
- Budget is tracked per-session and per-task

---

## Concepts

### Agents

An agent is an AI model instance governed by ClawForce. Each agent has:
- A unique **agent ID** (must match the ID in your platform)
- A **role** (inherited from a preset via `extends`)
- A **reporting chain** (who they report to)
- **Briefing sources** (context injected at session start)
- **Expectations** (minimum tool calls required per session)

ClawForce owns the governed identity for that agent. Your runtime or agent
framework should own the executable profile for that same agent, including model
selection, concrete tool wiring, sandbox details, and memory/loop settings.

The shared key is the agent ID. The model should not be "two full agent
definitions that happen to match"; it should be one governed worker record in
ClawForce bound to one executable worker record in the runtime.

### Roles

ClawForce has four primary role presets:

| Preset | Purpose | ClawForce Tools | Key Behavior |
| --- | --- | --- | --- |
| `manager` | Coordinate team, delegate tasks, review results | All tools | Runs on cron schedule, sees full task board |
| `employee` | Execute assigned tasks and report results | None (zero ClawForce tools) | Auto-lifecycle handles all transitions |
| `verifier` | Review completed work against acceptance criteria | `clawforce_task` (get), `clawforce_verify` (verdict), `clawforce_log` (write) | Read-only code access, cannot modify |
| `assistant` | Help users, manage communication | `clawforce_log`, `clawforce_setup` (read-only), `clawforce_context`, `clawforce_message`, `clawforce_channel` | No task management |

### Teams and Departments

Agents can be organized into departments and teams for filtering, channel membership, and budget allocation:

```yaml
agents:
  frontend-lead:
    extends: manager
    department: engineering
    team: frontend

  backend-dev:
    extends: employee
    department: engineering
    team: backend
    reports_to: frontend-lead
```

### Domains

A domain groups agents working on a related concern. Each domain is a YAML file under `domains/`:

```yaml
# domains/my-app.yaml
domain: my-app
agents: [lead, dev-1, dev-2]
paths:
  - ~/projects/my-app
operational_profile: medium
```

Domains support path-based resolution -- ClawForce determines which domain applies based on the agent's working directory.

### Templates

Templates provide pre-configured team structures. Currently available:

- **`startup`** -- Lean team: lead (manager) + dev-1 (employee) + agent-builder (employee)

Templates are applied during domain initialization and can be customized afterward.

### Operational Profiles

A single knob that configures coordination frequency, memory review, meetings, and recommended models. See the [Operational Profiles](#operational-profiles) section for details.

### Budget

Budget limits prevent runaway spending. Configurable at project level and per-agent:

- **Daily limit** -- maximum spend per day
- **Session limit** -- maximum per agent session
- **Task limit** -- maximum per individual task
- **Hourly/monthly limits** -- additional windows

Budget is tracked in cents for precision.

### Trust

Trust scores are computed from task completion history. Agents that complete tasks successfully build trust; failures reduce it. Trust scores influence:
- Manager escalation decisions
- Auto-assignment priority
- Whether human approval is required

### Policies

Policies enforce constraints:

| Type | Purpose |
| --- | --- |
| `action_scope` | Which ClawForce tool actions an agent can use |
| `transition_gate` | Rules for task state transitions |
| `spend_limit` | Budget enforcement per agent/project |
| `approval_required` | Actions that need human approval |

Action scope policies are auto-generated from role presets. Custom policies override defaults.

### Expectations and Performance

Expectations define minimum tool call requirements for agent sessions:

```yaml
expectations:
  - tool: clawforce_log
    action: write
    min_calls: 1
```

If an agent fails to meet expectations, the **performance policy** kicks in:
- `retry` -- Retry the session (up to `max_retries`)
- `alert` -- Notify the manager
- `terminate_and_alert` -- Kill the session and notify

### Auto-Lifecycle

ClawForce automates the task lifecycle for employee agents:
- **ASSIGNED -> IN_PROGRESS**: Automatic on dispatch
- **IN_PROGRESS -> REVIEW**: Automatic on session completion
- **Evidence capture**: Tool outputs are automatically recorded
- **Review dispatch**: Manager is notified when tasks reach REVIEW

Employees do not need any ClawForce tools. They just do their work normally.

### Goals

Goals provide high-level objectives that decompose into tasks:

```yaml
goals:
  ship-v1:
    description: "Ship version 1.0 with core features"
    acceptance_criteria: "All P0 features complete and deployed"
    allocation: 60  # 60% of daily budget
    owner_agent_id: lead
```

Goals can have sub-goals and track progress automatically based on linked task completion.

### Channels

Channels enable group communication between agents:

```yaml
channels:
  - name: engineering
    members: [lead, dev-1, dev-2]
  - name: standup
    type: meeting
    departments: [engineering]
```

### Jobs

Jobs are scoped sessions that run on schedules within an agent. Each job can have its own briefing, expectations, and cron schedule:

```yaml
agents:
  lead:
    extends: manager
    jobs:
      dispatch:
        cron: "*/5 * * * *"
        briefing:
          - { source: task_board }
          - { source: pending_messages }
      reflect:
        cron: "0 9 * * MON"
        briefing:
          - { source: velocity }
          - { source: cost_summary }
```

### SOUL.md

Each agent gets a `SOUL.md` file in `agents/<id>/SOUL.md`. This defines the agent's identity, expertise, and guidelines. It is injected as the `soul` briefing source. ClawForce scaffolds a template; you customize it:

```markdown
<!-- SOUL.md -- Identity and domain context for dev-1 -->

## Expertise
TypeScript, React, Node.js. Specializes in frontend development and UI architecture.

## Guidelines
- Always write tests for new components
- Follow the project's ESLint config
- Use functional components with hooks
```

### DIRECTION.md

Defines the team's vision and autonomy level:

```yaml
vision: "Build a real-time collaboration platform for remote teams"
autonomy: medium
constraints:
  budget_daily_cents: 5000
  tech_stack: [TypeScript, React, PostgreSQL]
  timeline: "3 months"
phases:
  - name: Foundation
    goals: [database schema, auth system, basic API]
  - name: Core Features
    goals: [real-time sync, document editor]
```

Autonomy levels:
- **low** -- All adaptations need human approval
- **medium** -- Routine changes auto-approved
- **high** -- Team self-manages within budget

---

## Configuration Reference

### config.yaml + domains/*.yaml -- Top-Level Fields

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `config.yaml` | file | yes | -- | Shared global config file |
| `domains/<domain>.yaml` | file | yes | -- | One config file per domain |
| `agents` | object | yes | -- | Agent configurations, keyed by agent ID |
| `manager` | object | no | -- | Domain manager config with `agentId` and optional schedule overrides |
| `budget` | object | no | -- | Domain budget limits |
| `policies` | array | no | -- | Domain policy enforcement rules |
| `approval` | object | no | -- | Shared human approval policy in `config.yaml` |
| `goals` | object | no | -- | Domain goal definitions with optional budget allocation |
| `channels` | array | no | -- | Domain communication channel definitions |
| `lifecycle` | object | no | -- | Domain lifecycle settings |
| `dispatch` | object | no | -- | Domain dispatch throttle and concurrency |
| `review` | object | no | -- | Review gate configuration |
| `safety` | object | no | -- | Safety guardrails |
| `verification` | object | no | -- | Verification gates and git isolation |
| `monitoring` | object | no | -- | SLOs, anomaly detection, alerts |
| `risk_tiers` | object | no | -- | Risk classification policies |
| `event_handlers` | object | no | -- | Event-to-action mappings |
| `triggers` | object | no | -- | External trigger definitions |
| `skills` | object | no | -- | Custom skill topics in `config.yaml` |
| `skill_packs` | object | no | -- | Reusable config bundles for agents in `config.yaml` |
| `knowledge` | object | no | -- | Knowledge lifecycle config |
| `bootstrap_defaults` | object | no | -- | Default bootstrap config for all agents in `config.yaml` |

### Agent Config Fields

Each entry under `agents:` defines one agent:

```yaml
agents:
  <agent-id>:
    extends: manager | employee | verifier | assistant
    title: "Job Title"
    codex:
      model: "gpt-5.4"
    persona: "Custom system prompt personality"
    reports_to: <manager-agent-id>
    department: engineering
    team: frontend

    # Context
    briefing:
      - { source: soul }
      - { source: task_board }
    exclude_briefing: [weekly_digest]

    # Expectations
    expectations:
      - tool: clawforce_log
        action: write
        min_calls: 1

    # Performance
    performance_policy:
      action: retry
      max_retries: 3
      then: alert

    # Session behavior
    compaction: true
    compactBriefing: true
    contextBudgetChars: 30000
    maxTurnsPerSession: 50

    # Runtime-scoped execution envelope
    runtime:
      bootstrapConfig:
        maxChars: 12000
        totalMaxChars: 50000
      bootstrapExcludeFiles: [HEARTBEAT.md, IDENTITY.md, BOOTSTRAP.md]
      allowedTools: [Bash, Read, Edit, Write, WebSearch]
      workspacePaths: [packages/core, packages/shared]

    # Coordination (managers only)
    coordination:
      enabled: true
      schedule: "*/30 * * * *"
    scheduling:
      adaptiveWake: true
      planning: true
      wakeBounds: ["*/15 * * * *", "*/120 * * * *"]
      maxTurnsPerCycle: 50

    # Permissions
    permissions:
      can_hire: true
      can_fire: false
      budget_limit_cents: 5000

    # Jobs (scoped sessions)
    jobs:
      dispatch:
        cron: "*/5 * * * *"
        briefing:
          - { source: task_board }
      reflect:
        extends: reflect
        cron: "0 9 * * MON"

    # Memory
    memory:
      review:
        aggressiveness: medium

    # Event observation
    observe: ["budget.*", "task.failed"]

    # Auto-recovery
    auto_recovery:
      enabled: true
      cooldown_minutes: 10

    # Skill pack
    skill_pack: my-pack
    skillCap: 12
```

#### Field Reference

| Field | Type | Default (manager) | Default (employee) | Description |
| --- | --- | --- | --- | --- |
| `extends` | string | -- | -- | Preset to inherit from. Required for role detection. |
| `title` | string | `"Manager"` | `"Employee"` | Human-readable job title |
| `codex.model` | string | -- | -- | Codex/OpenAI model override (e.g. `"gpt-5.4"`) |
| `persona` | string | (preset default) | (preset default) | System prompt personality. Overridden by SOUL.md if present. |
| `reports_to` | string | -- | -- | Agent ID of this agent's manager. Determines escalation chain. |
| `department` | string | -- | -- | Organizational department |
| `team` | string | -- | -- | Team within department |
| `briefing` | array | 20+ sources | `[soul, assigned_task, execution_standards]` | Context sources injected at session start |
| `exclude_briefing` | string[] | -- | -- | Sources to remove from the preset baseline |
| `expectations` | array | `[{tool: clawforce_log, action: write, min_calls: 1}]` | `[]` (empty) | Minimum tool call requirements |
| `performance_policy` | object | `{action: retry, max_retries: 2, then: alert}` | `{action: retry, max_retries: 3, then: alert}` | Non-compliance behavior |
| `compaction` | bool/object | `true` | `false` | Whether to persist learnings across sessions |
| `compactBriefing` | boolean | `true` (managers) | -- | Render briefing as compact previews |
| `contextBudgetChars` | number | `30000` | `30000` | Context window budget in characters |
| `maxTurnsPerSession` | number | `50` | `50` | Max turns before session wrap-up |
| `runtime` | object | preset-scoped | preset-scoped | Runtime-scoped execution envelope (`bootstrapConfig`, `bootstrapExcludeFiles`, `allowedTools`, `workspacePaths`) |
| `coordination` | object | `{enabled: true, schedule: "*/30 * * * *"}` | `{enabled: false}` | Coordination scheduling |
| `scheduling` | object | (see preset) | -- | Adaptive wake and planning |
| `permissions` | object | -- | -- | Hiring, firing, budget permissions |
| `bootstrapConfig` | object | `{maxChars: 12000, totalMaxChars: 50000}` | `{maxChars: 8000, totalMaxChars: 30000}` | Compatibility alias for `runtime.bootstrapConfig` |
| `bootstrapExcludeFiles` | string[] | (see preset) | (see preset) | Compatibility alias for `runtime.bootstrapExcludeFiles` |
| `allowedTools` | string[] | (all) | `[Bash, Read, Edit, Write, WebSearch]` | Compatibility alias for `runtime.allowedTools` |
| `workspacePaths` | string[] | project root | project root | Compatibility alias for `runtime.workspacePaths` |
| `jobs` | object | -- | -- | Scoped session definitions |
| `memory` | object | -- | -- | Memory governance config |
| `observe` | string[] | -- | -- | Event patterns to monitor |
| `auto_recovery` | object | -- | -- | Auto-re-enable after failures |
| `skill_pack` | string | -- | -- | Named config bundle to apply |
| `skillCap` | number | `12` | `8` | Max skills an agent can hold |

ClawForce now prefers the nested `runtime` block for these execution-envelope fields. The top-level aliases remain supported for compatibility while configs migrate.

### Job Definition Fields

Jobs define scoped sessions within an agent:

```yaml
jobs:
  <job-name>:
    extends: reflect | triage | daily_review | memory_review  # optional preset
    cron: "*/30 * * * *"       # cron expression, shorthand ("5m"), or "at:ISO-datetime"
    cronTimezone: America/New_York
    sessionTarget: isolated     # "isolated" (default) or "main"
    wakeMode: now               # "now" (default) or "next-heartbeat"
    model: gpt-5.4
    timeoutSeconds: 300
    maxTurns: 20
    lightContext: false
    continuous: false           # re-dispatch immediately when session ends
    frequency: "3/day"          # alternative to cron, ClawForce picks times
    nudge: "Check on the team and triage."
    briefing:
      - { source: task_board }
      - { source: escalations }
    exclude_briefing: [weekly_digest]
    expectations:
      - tool: clawforce_log
        action: write
        min_calls: 1
    performance_policy:
      action: alert
    compaction: false
    tools: [task_assign, task_create]
    delivery:
      mode: announce
      channel: last
    failureAlert:
      after: 2
      channel: last
```

#### Built-in Job Presets

| Preset | Default Schedule | Purpose |
| --- | --- | --- |
| `reflect` | `0 9 * * MON` (Mondays 9AM) | Review team performance, budget, velocity, trust scores |
| `triage` | `*/30 * * * *` (every 30 min) | Check task board, handle escalations, process messages |
| `daily_review` | `0 18 * * *` (daily 6PM) | Review progress, task completion, agent performance |
| `memory_review` | `0 18 * * *` (daily 6PM) | Extract learnings from session transcripts |

### Budget Config

```yaml
budgets:
  project:
    dailyLimitCents: 5000       # $50/day across all agents
    sessionLimitCents: 1000     # $10 per session max
    taskLimitCents: 500         # $5 per task max
    hourlyLimitCents: 1000      # $10/hour
    monthlyLimitCents: 100000   # $1000/month
  agents:
    lead:
      dailyLimitCents: 3000
      sessionLimitCents: 500
    dev-1:
      dailyLimitCents: 2000
      taskLimitCents: 300
```

#### Model Cost Estimates

These are approximate costs per session for budget planning:

| Model | Cost per Session (cents) |
| --- | --- |
| `gpt-5.4` | ~80 |
| `gpt-5.4-mini` | ~12 |
| `gpt-5.4-nano` | ~3 |

Default sessions per day: managers ~6, employees ~4.

**Budget planning formula**: For a team with 1 manager (GPT-5.4) + 2 employees (GPT-5.4 mini):
- Manager: 6 sessions x 80 cents = 480 cents/day
- 2 Employees: 2 x 4 sessions x 12 cents = 96 cents/day
- Recommended: ~$5.76/day, comfortable: ~$9.22/day

### Policy Config

```yaml
policies:
  - name: restrict-dev-scope
    type: action_scope
    target: dev-1
    config:
      allowed_tools:
        clawforce_log: ["write"]
        memory_search: "*"

  - name: budget-gate
    type: spend_limit
    target: dev-1
    config:
      daily_limit_cents: 2000

  - name: require-approval-for-hire
    type: approval_required
    config:
      actions: [agent_hire]
```

Policy types:
- **`action_scope`** -- Restrict which ClawForce tool actions an agent can call. Auto-generated from role presets by default.
- **`transition_gate`** -- Rules for when task state transitions are allowed.
- **`spend_limit`** -- Budget enforcement.
- **`approval_required`** -- Require human approval for specific actions.

### Manager Config

```yaml
manager:
  enabled: true
  agentId: lead              # which agent serves as manager
  cronSchedule: "*/30 * * * *"
  projectDir: /path/to/project
```

### Lifecycle Config

```yaml
lifecycle:
  autoTransitionOnDispatch: true      # ASSIGNED->IN_PROGRESS on dispatch (default: true)
  autoTransitionOnComplete: true      # IN_PROGRESS->REVIEW on completion (default: true)
  autoCaptureEvidence: true           # Auto-capture tool output as evidence (default: true)
  significantTools: [Bash, Write, Edit, Read]  # Tools that generate evidence
  evidenceTruncationLimit: 2000       # Max chars per evidence capture
  immediateReviewDispatch: true       # Notify manager on REVIEW (default: true)
```

### Manager Behavior Config

```yaml
manager_behavior:
  maxTasksPerPlanningSession: 10      # Max tasks per planning session (default: 10)
  planningHorizonDays: 7              # How far ahead to plan (default: 7)
  escalationTrustThreshold: 0.3       # Trust score below this triggers escalation (default: 0.3)
```

### Telemetry Config

```yaml
telemetry:
  archiveTranscripts: true            # Save session transcripts (default: true)
  captureToolIO: true                 # Capture tool input/output (default: true)
  toolIOTruncationLimit: 10000        # Max chars per capture (default: 10000)
  retentionDays: 90                   # How long to keep archives (default: 90)
  trackConfigChanges: true            # Track config modifications (default: true)
```

### Context Ownership Config

Controls who can modify shared context files:

```yaml
context_ownership:
  architecture: any                   # ARCHITECTURE.md (default: "any")
  standards: manager                  # STANDARDS.md (default: "manager")
  direction: human                    # DIRECTION.md (default: "human")
  policies: human                     # POLICIES.md (default: "human")
```

Values: `"any"` (any agent), `"manager"` (manager only), `"human"` (human only).

### Approval Config

```yaml
approval:
  policy: "Approve hiring requests only if team is understaffed and budget allows. Reject infrastructure changes without a rollback plan."
```

This natural language policy text is presented to managers when reviewing proposals.

### Safety Config

```yaml
safety:
  maxSpawnDepth: 3                    # Max agent-spawning-agent chains (default: 3)
  costCircuitBreaker: 1.5             # Pause at 150% of daily budget (default: 1.5)
  loopDetectionThreshold: 3           # Same task title failed N times -> require human (default: 3)
  maxConcurrentMeetings: 2            # Max active meetings per project (default: 2)
  maxMessageRate: 60                  # Max messages/minute/channel (default: 60)
  maxTasksPerSession: 10              # Max tasks a manager can create per session (default: 10)
  maxSessionDurationMs: 600000        # 10 minutes max session duration (default: 600000)
  spendRateWarningThreshold: 0.8      # Warn at 80% of daily budget (default: 0.8)
  maxConsecutiveFailures: 5           # Auto-disable after N consecutive failures (default: 5)
  emergencyStop: false                # Global kill switch (default: false)
  maxQueueDepth: 50                   # Max queued items per project (default: 50)
```

### Dispatch Config

```yaml
dispatch:
  maxConcurrentDispatches: 3          # Max concurrent dispatches per project (default: 3)
  maxDispatchesPerHour: 30            # Rate limit per project
  agentLimits:
    dev-1:
      maxConcurrent: 1
      maxPerHour: 10
```

### Assignment Config

```yaml
assignment:
  enabled: true                       # Enable auto-assignment (default: false)
  strategy: workload_balanced         # workload_balanced | round_robin | skill_matched
  autoDispatchOnAssign: true          # Auto-dispatch when assigned (default: true)
```

### Review Config

```yaml
review:
  verifierAgent: verifier-1           # Explicit verifier agent ID
  autoEscalateAfterHours: 24          # Escalate if no review after N hours
  selfReviewAllowed: false            # Allow self-review (default: false)
  selfReviewMaxPriority: P3           # Max priority for self-review
```

### Channel Config

```yaml
channels:
  - name: engineering
    type: topic                       # "topic" (default) or "meeting"
    members: [lead, dev-1, dev-2]
  - name: all-hands
    departments: [engineering, design]
  - name: frontend-team
    teams: [frontend]
  - name: managers
    presets: [manager]
```

Members can be specified by explicit agent IDs, departments, teams, or presets. Channels support Telegram mirroring with `telegramGroupId` and `telegramThreadId`.

### Verification Config

```yaml
verification:
  enabled: true
  parallel: false
  total_timeout_seconds: 300
  gates:
    - name: type-check
      command: "npx tsc --noEmit"
      timeout_seconds: 60
      required: true
    - name: tests
      command: "npx vitest run"
      timeout_seconds: 120
      required: true
    - name: lint
      command: "npx eslint src/"
      timeout_seconds: 60
      required: false
      file_pattern: "*.ts"
  git:
    enabled: true
    branch_pattern: "cf/{{agentId}}/{{taskId}}"
    base_branch: main
    auto_merge: false
    mode: branch                      # "branch" or "worktree"
```

### Goal Config

```yaml
goals:
  ship-v1:
    description: "Ship version 1.0"
    acceptance_criteria: "All P0 features complete"
    allocation: 60                    # % of daily budget
    department: engineering
    owner_agent_id: lead

  improve-test-coverage:
    description: "Reach 80% test coverage"
    allocation: 20
    department: engineering
    team: backend
```

Goal allocations must sum to 100 or less. Goals can be decomposed into sub-goals at runtime.

### Event Handler Config

```yaml
event_handlers:
  task_failed:
    - action: notify
      message: "Task {{payload.taskId}} failed: {{payload.reason}}"
      to: lead
      priority: high
    - action: escalate
      to: manager
      message: "Task failure requires attention"

  ci_failed:
    - action: create_task
      template: "Fix CI: {{payload.branch}}"
      priority: P1
      assign_to: auto
```

Available actions: `create_task`, `notify`, `escalate`, `enqueue_work`, `emit_event`.

### Trigger Config

```yaml
triggers:
  deploy-webhook:
    source: webhook
    agent: lead
    task_template: "Review deployment {{payload.version}}"
    severity: medium
```

Trigger sources: `webhook`, `cli`, `file_watcher`, `sdk`, `cron`, `manual`.

### Skill Packs

Reusable config bundles that agents reference by name:

```yaml
skill_packs:
  code-reviewer:
    briefing:
      - { source: assigned_task }
      - { source: review_standards }
    expectations:
      - tool: clawforce_verify
        action: verdict
        min_calls: 1
    performance_policy:
      action: retry
      max_retries: 2

agents:
  reviewer-1:
    extends: verifier
    skill_pack: code-reviewer
```

### Custom Skills

Domain-specific markdown docs accessible via the skill system:

```yaml
skills:
  api-reference:
    title: "API Reference"
    description: "Internal API documentation"
    path: "./docs/api.md"
    presets: [manager, employee]       # which roles can access this
```

### Bootstrap Defaults

Project-wide defaults for session context injection:

```yaml
bootstrap_defaults:
  maxChars: 10000                     # Max chars per bootstrap file
  totalMaxChars: 40000                # Max total across all files
```

Individual agent `bootstrapConfig` overrides these defaults.

---

## Templates

### Startup Template

The `startup` template creates a lean team suitable for most projects:

**Agents:**

| Agent ID | Role | Title | Reports To |
| --- | --- | --- | --- |
| `lead` | manager | Team Lead | -- |
| `dev-1` | employee | Developer | lead |
| `agent-builder` | employee | Agent Builder | lead |

**Budget:** $30/day default

**Lead's Jobs:**

| Job | Schedule | Purpose |
| --- | --- | --- |
| `dispatch` | Every 5 minutes | Triage tasks, assign work, process messages |
| `reflect` | Mondays 9 AM | Review performance, consider team changes |
| `ops` | Every hour | Health checks, operational monitoring |

**Usage:**

```yaml
id: my-project
name: My Project
dir: /path/to/project

# Use the startup template agents
agents:
  lead:
    extends: manager
    title: Team Lead
    jobs:
      dispatch:
        cron: "*/5 * * * *"
        briefing:
          - { source: instructions }
          - { source: task_board }
          - { source: pending_messages }
      reflect:
        cron: "0 9 * * MON"
        briefing:
          - { source: instructions }
          - { source: velocity }
          - { source: trust_scores }
          - { source: cost_summary }
      ops:
        cron: "0 * * * *"
        briefing:
          - { source: instructions }
          - { source: health_status }
  dev-1:
    extends: employee
    title: Developer
    reports_to: lead
  agent-builder:
    extends: employee
    title: Agent Builder
    reports_to: lead

budgets:
  project:
    dailyLimitCents: 3000
```

### Custom Template

Set `template: custom` during init to define everything manually. No agents are pre-configured.

---

## Agent Roles

### Manager

The manager is the coordinator of the team. It plans work, delegates tasks, reviews results, and makes operational decisions.

**What managers do:**
- Create and assign tasks
- Review completed work (approve/reject)
- Handle escalations from employees
- Manage budgets and resource allocation
- Coordinate via scheduled jobs (dispatch, reflect, ops)
- Hire/fire agents (if permitted)
- Create and manage goals
- Send messages and manage channels

**What managers see (default briefing sources):**
`soul`, `tools_reference`, `project_md`, `task_board`, `goal_hierarchy`, `escalations`, `team_status`, `trust_scores`, `cost_summary`, `resources`, `pending_messages`, `channel_messages`, `memory_instructions`, `skill`, `policy_status`, `preferences`, `cost_forecast`, `available_capacity`, `knowledge_candidates`, `budget_guidance`, `onboarding_welcome`, `weekly_digest`, `intervention_suggestions`, `task_creation_standards`

**Tool access:** All ClawForce tools (`clawforce_task`, `clawforce_log`, `clawforce_verify`, `clawforce_compact`, `clawforce_workflow`, `clawforce_ops`, `clawforce_setup`, `clawforce_context`, `clawforce_message`, `clawforce_goal`, `clawforce_channel`, `memory_search`, `memory_get`)

**Default expectations:** At least 1 `clawforce_log write` call per session.

**Default performance policy:** Retry up to 2 times, then alert.

### Employee

The employee executes tasks assigned by the manager. It has zero ClawForce tools -- all governance happens automatically through the auto-lifecycle system.

**What employees do:**
- Receive task assignments via dispatch
- Execute the work (coding, research, testing, etc.)
- Their tool outputs are automatically captured as evidence
- Task transitions happen automatically (ASSIGNED -> IN_PROGRESS -> REVIEW)

**What employees see (default briefing sources):**
`soul`, `assigned_task`, `execution_standards`

**Platform tools:** `Bash`, `Read`, `Edit`, `Write`, `WebSearch` (configurable via `allowedTools`)

**ClawForce tool access:** None. Only `memory_search` and `memory_get` are in scope.

**Default expectations:** None (empty). Auto-lifecycle tracks compliance structurally.

**Default performance policy:** Retry up to 3 times, then alert.

**Bootstrap optimization:** Reduced context budget (`maxChars: 8000`, `totalMaxChars: 30000`). Bootstrap files like `AGENTS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `BOOTSTRAP.md` are excluded to save tokens.

### Verifier

The verifier reviews completed work against acceptance criteria. It can read code and run tests but cannot modify anything.

**What verifiers do:**
- Receive tasks in REVIEW state
- Read the task description and acceptance criteria
- Read the code, run tests, check evidence
- Submit a verdict (pass/fail with specific feedback)
- If rejected, the task goes back to the assignee with feedback

**What verifiers see (default briefing sources):**
`soul`, `tools_reference`, `assigned_task`, `review_standards`

**Platform tools:** `Bash`, `Read`, `WebSearch` (read-only -- no `Edit` or `Write`)

**ClawForce tool access:** `clawforce_task` (get only), `clawforce_verify` (verdict only), `clawforce_log` (write only)

**Default expectations:** At least 1 `clawforce_verify verdict` call.

**Default performance policy:** Retry up to 2 times, then alert.

### Assistant

The assistant helps users interact with ClawForce through conversation. It manages communication and memory but does not create or manage tasks.

**What assistants do:**
- Help users understand their workforce status
- Send and receive messages between agents
- Manage channels and meetings
- Access memory and context

**What assistants see (default briefing sources):**
`soul`, `tools_reference`, `pending_messages`, `channel_messages`, `memory_instructions`, `skill`, `preferences`

**ClawForce tool access:** `clawforce_log` (write, outcome, search, list), `clawforce_setup` (explain, status), `clawforce_context` (all), `clawforce_message` (all communication actions), `clawforce_channel` (send, list, history, meeting_status, join, leave)

### Special Presets

**`dashboard-assistant`** -- Extends `assistant`. Designed for the ClawForce dashboard widget. Has access to operational tools and task boards.

**`onboarding`** -- Extends `assistant`. Guides users through first-time setup. Transitions to regular dashboard assistant after onboarding.

---

## Operational Profiles

Operational profiles are a single knob that configures all operational settings. Pick a level and everything works, or override individual settings for fine-tuning.

### Low Profile

Best for: Cost-conscious setups, evaluation, low-activity projects.

| Setting | Value |
| --- | --- |
| Coordination schedule | Every 2 hours |
| Session target | Isolated |
| Adaptive wake | Off |
| Memory review | Sundays 6 PM |
| Memory aggressiveness | Low |
| Meetings | Reflection on Fridays 9 AM |
| Manager model | `claude-haiku-4-5` |
| Employee model | `claude-haiku-4-5` |

**Estimated cost:** Very low. Haiku-only, minimal coordination.

### Medium Profile

Best for: Active development, small-to-medium teams, balanced cost/responsiveness.

| Setting | Value |
| --- | --- |
| Coordination schedule | Every 30 minutes |
| Session target | Main (persistent 8h) |
| Adaptive wake | On, bounds 30m-120m |
| Memory review | Daily 6 PM |
| Memory aggressiveness | Medium |
| Meetings | Standup Mon-Fri 9 AM, reflection Fridays 9 AM |
| Session reset | Daily at midnight |
| Manager model | `claude-sonnet-4-6` |
| Employee model | `claude-haiku-4-5` |

**Estimated cost:** Moderate. Sonnet manager, Haiku workers.

### High Profile

Best for: Active teams, fast iteration, higher budgets.

| Setting | Value |
| --- | --- |
| Coordination schedule | Every 15 minutes |
| Session target | Main (persistent 24h) |
| Adaptive wake | On, bounds 15m-120m |
| Memory review | Daily 12 PM and 6 PM |
| Memory aggressiveness | High |
| Meetings | Standup Mon-Fri 9 AM and 2 PM, reflection Wed and Fri 9 AM |
| Session reset | Daily at 11:59 PM |
| Manager model | `claude-sonnet-4-6` |
| Employee model | `claude-sonnet-4-6` |

**Estimated cost:** Higher. Sonnet for everyone, frequent coordination.

### Ultra Profile

Best for: Maximum throughput, research labs, time-critical projects.

| Setting | Value |
| --- | --- |
| Coordination schedule | Every 10 minutes |
| Session target | Main (persistent 24h) |
| Adaptive wake | On, bounds 10m-60m |
| Memory review | Daily 6 PM |
| Memory aggressiveness | High |
| Meetings | Standup Mon-Fri 9 AM, 12 PM, 4 PM, reflection daily 6 PM |
| Session reset | Daily at 11:59 PM |
| Manager model | `claude-opus-4-6` |
| Employee model | `claude-sonnet-4-6` |

**Estimated cost:** Highest. Opus manager, Sonnet workers, very frequent coordination.

### Using Profiles

In domain config:

```yaml
# domains/my-domain.yaml
domain: my-domain
agents: [lead, dev-1, dev-2]
operational_profile: medium
```

Or during init:

```yaml
operational_profile: medium
```

Profiles expand into agent-level job definitions and scheduling config. Existing per-agent settings are never overwritten -- profiles only fill in defaults.

---

## Examples

### Minimal Setup: Solo Developer with Oversight

One manager overseeing one developer. Cheapest possible configuration.

```yaml
id: solo-dev
name: Solo Developer Project
dir: ~/projects/my-app

agents:
  lead:
    extends: manager
    title: Project Lead
    codex:
      model: gpt-5.4-mini
    jobs:
      coordination:
        cron: "0 */2 * * *"
        extends: triage

  dev:
    extends: employee
    title: Developer
    reports_to: lead

budgets:
  project:
    dailyLimitCents: 500

manager:
  enabled: true
  agentId: lead
  cronSchedule: "0 */2 * * *"
```

### Small Team: Frontend + Backend

Two developers with different specialties, a verifier, and a lead.

```yaml
id: web-app
name: Web Application
dir: ~/projects/web-app

agents:
  lead:
    extends: manager
    title: Engineering Lead
    department: engineering
    jobs:
      dispatch:
        cron: "*/15 * * * *"
        extends: triage
      reflect:
        cron: "0 9 * * MON"
        extends: reflect

  frontend:
    extends: employee
    title: Frontend Developer
    department: engineering
    team: frontend
    reports_to: lead

  backend:
    extends: employee
    title: Backend Developer
    department: engineering
    team: backend
    reports_to: lead

  reviewer:
    extends: verifier
    title: Code Reviewer
    department: engineering
    reports_to: lead

budgets:
  project:
    dailyLimitCents: 5000
  agents:
    lead:
      dailyLimitCents: 2000
    frontend:
      dailyLimitCents: 1500
    backend:
      dailyLimitCents: 1500
    reviewer:
      dailyLimitCents: 500

channels:
  - name: engineering
    departments: [engineering]
  - name: frontend-team
    teams: [frontend]

review:
  verifierAgent: reviewer
  selfReviewAllowed: false

lifecycle:
  autoTransitionOnDispatch: true
  autoTransitionOnComplete: true
  immediateReviewDispatch: true

manager:
  enabled: true
  agentId: lead
  cronSchedule: "*/15 * * * *"
```

### Research Lab: High-Throughput Experimentation

Large team with multiple departments, goals with budget allocation, and ultra coordination.

```yaml
id: research-lab
name: AI Research Lab
dir: ~/projects/research

agents:
  director:
    extends: manager
    title: Research Director
    department: research
    permissions:
      can_hire: true
      budget_limit_cents: 20000

  ml-lead:
    extends: manager
    title: ML Team Lead
    department: research
    team: ml
    reports_to: director

  data-eng:
    extends: employee
    title: Data Engineer
    department: research
    team: data
    reports_to: ml-lead

  researcher-1:
    extends: employee
    title: ML Researcher
    department: research
    team: ml
    reports_to: ml-lead
    codex:
      model: gpt-5.4

  researcher-2:
    extends: employee
    title: ML Researcher
    department: research
    team: ml
    reports_to: ml-lead
    codex:
      model: gpt-5.4

  analyst:
    extends: employee
    title: Data Analyst
    department: research
    team: analytics
    reports_to: director

  verifier:
    extends: verifier
    title: Research Reviewer
    department: research
    reports_to: director

goals:
  paper-submission:
    description: "Submit research paper to NeurIPS"
    acceptance_criteria: "Paper drafted, experiments complete, results validated"
    allocation: 50
    department: research
    team: ml
    owner_agent_id: ml-lead

  data-pipeline:
    description: "Build automated data pipeline"
    allocation: 30
    department: research
    team: data
    owner_agent_id: data-eng

  analysis-dashboard:
    description: "Create real-time metrics dashboard"
    allocation: 20
    department: research
    team: analytics

budgets:
  project:
    dailyLimitCents: 20000

channels:
  - name: research
    departments: [research]
  - name: ml-team
    teams: [ml]
  - name: daily-standup
    type: meeting
    departments: [research]

review:
  verifierAgent: verifier

safety:
  maxTasksPerSession: 15
  costCircuitBreaker: 1.3
  maxConsecutiveFailures: 3

manager:
  enabled: true
  agentId: director
  cronSchedule: "*/10 * * * *"
```

---

## Tools Reference

ClawForce exposes these tools to agents based on their role's action scope. Employees have zero ClawForce tools; managers have access to all.

### clawforce_setup

**Purpose:** Set up and configure AI workforce projects.

| Action | Description |
| --- | --- |
| `explain` | Full reference docs -- `config.yaml` + `domains/*.yaml` format, roles, examples. Pass `topic` for specific topics. |
| `status` | Show current projects and registered agents. |
| `validate` | Check a config before writing. Pass `yaml_content` or `config_path`. |
| `activate` | Register or reload a project. Pass `project_id`. |
| `scaffold` | Create SOUL.md templates for agents. Pass `project_id`, optionally `agent_id`. |

### clawforce_task

**Purpose:** Manage work assignments.

| Action | Description |
| --- | --- |
| `create` | Create a new task with title, description, priority, assignee. |
| `transition` | Move task to a new state (OPEN, ASSIGNED, IN_PROGRESS, REVIEW, DONE, FAILED). |
| `attach_evidence` | Attach evidence to a task (output, diff, test_result, screenshot, log). |
| `get` | Get task details by ID. |
| `list` | List tasks with filters (state, priority, assigned_to, department, team). |
| `history` | Get transition history for a task. |
| `fail` | Mark task as failed with reason and optional evidence. |
| `bulk_create` | Create multiple tasks at once. |
| `bulk_transition` | Transition multiple tasks at once. |
| `add_dep` / `remove_dep` | Manage task dependencies. |
| `list_deps` / `list_dependents` / `list_blockers` | Query dependency graph. |
| `submit_proposal` | Submit a proposal for human approval. |
| `check_proposal` | Check proposal status. |
| `metrics` | Query task metrics. |

### clawforce_ops

**Purpose:** Runtime observability and control for managers.

| Action | Description |
| --- | --- |
| `agent_status` | Get status of all agents (active sessions, disabled state, retries). |
| `kill_agent` | Kill a stuck agent's session. |
| `disable_agent` / `enable_agent` | Disable/enable an agent. |
| `reassign` | Reassign a task to a different agent. |
| `query_audit` | Search the audit log. |
| `trigger_sweep` | Run a sweep to check for stuck/failed tasks. |
| `dispatch_worker` | Manually dispatch a worker for a task. |
| `emit_event` | Emit a custom event. |
| `list_events` | List events with filters. |
| `enqueue_work` | Add a task to the dispatch queue. |
| `queue_status` | Get dispatch queue status. |
| `list_jobs` / `create_job` / `update_job` / `delete_job` | Manage agent jobs. |
| `introspect` | View agent config and effective scope. |
| `allocate_budget` | Adjust budget allocation. |
| `emergency_stop` / `emergency_resume` | Global kill switch. |
| `init_questions` / `init_apply` | Interactive setup flow. |
| `route` | Route a message to the appropriate domain/agent. |
| Experiment actions | Create, start, pause, complete, kill, list experiments. |

### clawforce_log

**Purpose:** Record work journal entries and query past records.

| Action | Description |
| --- | --- |
| `write` | Write a journal entry (required expectation for managers). |
| `outcome` | Record a task outcome. |
| `search` | Search journal entries. |
| `list` | List recent entries. |

### clawforce_verify

**Purpose:** Review task output via cross-team verification.

| Action | Description |
| --- | --- |
| `verdict` | Submit a pass/fail verdict on a task in REVIEW state. |

### clawforce_workflow

**Purpose:** Manage phased work processes.

| Action | Description |
| --- | --- |
| `create` | Create a workflow with named phases. |
| `get` / `list` | Query workflows. |
| `add_task` | Add a task to a workflow phase. |
| `advance` | Advance to the next phase (if gate condition met). |
| `phase_status` | Get status of a specific phase. |

### clawforce_goal

**Purpose:** Manage project goals.

| Action | Description |
| --- | --- |
| `create` | Create a goal with description and acceptance criteria. |
| `decompose` | Break a goal into sub-goals. |
| `status` / `get` / `list` | Query goal status. |
| `achieve` / `abandon` | Complete or abandon a goal. |

### clawforce_message

**Purpose:** Agent communication system.

| Action | Description |
| --- | --- |
| `send` / `reply` | Send messages between agents. |
| `list` / `read` | Read messages. |
| `request` / `delegate` | Start structured communication protocols. |
| `respond` / `accept` / `reject` / `complete` | Protocol responses. |
| `submit_review` / `request_feedback` | Review-oriented messaging. |

### clawforce_channel

**Purpose:** Manage channels and meetings.

| Action | Description |
| --- | --- |
| `create` | Create a topic or meeting channel. |
| `send` | Send a message to a channel. |
| `list` / `history` | Query channels and messages. |
| `join` / `leave` | Channel membership. |
| `meeting_status` | Check meeting state. |

### clawforce_context

**Purpose:** Retrieve context mid-session.

| Action | Description |
| --- | --- |
| `expand` | Expand a compact briefing source to full content. |
| `query` | Query specific context sources. |

### clawforce_compact

**Purpose:** Update project documents for knowledge persistence.

| Action | Description |
| --- | --- |
| `read` | Read a project document. |
| `write` | Update a project document with learnings. |

### memory_search / memory_get

**Purpose:** Query the agent's long-term memory store.

Available to all roles. Used for knowledge retrieval and avoiding duplicate work.

---

## Troubleshooting

### "No projects configured"

Run `clawforce_setup action=status` to see what's registered. If nothing, create `config.yaml` plus a domain file and activate it.

### Agent ID Mismatch

Agent IDs in `config.yaml` must exactly match the agent IDs available in the execution environment you are dispatching through. Check that runtime or adapter configuration if there is a mismatch.

### Budget Exceeded

Check `clawforce_ops action=agent_status` for cost data. Adjust `budgets` in config or increase limits. Emergency: `clawforce_ops action=emergency_resume` if the circuit breaker tripped.

### Stuck Tasks

Run `clawforce_ops action=trigger_sweep` to detect stuck tasks. Use `clawforce_ops action=reassign` to move tasks to a different agent, or `clawforce_ops action=kill_agent` for stuck sessions.

### Config Validation Errors

Always validate before activating:
```
clawforce_setup action=validate yaml_content="..."
```

Common issues:
- Missing `id` field (required)
- Agent `extends` value must be a valid preset (`manager`, `employee`, `verifier`, `assistant`)
- `reports_to` must reference a valid agent ID in the same config
- Goal `allocation` values must sum to 100 or less
- Budget values are in cents (not dollars)

### Re-loading Config Changes

After editing `config.yaml` or a domain file, re-activate to pick up changes:
```
clawforce_setup action=activate project_id="my-project"
```

This is idempotent and safe to run multiple times.

### Emergency Stop

If something goes wrong and you need to halt all agent activity:
```
clawforce_ops action=emergency_stop
```

Resume with:
```
clawforce_ops action=emergency_resume
```
