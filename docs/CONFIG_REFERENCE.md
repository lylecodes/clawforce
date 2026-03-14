# Clawforce Configuration Reference

Definitive reference for every configurable surface in Clawforce. For getting-started examples, see the [README](../README.md).

---

## Table of Contents

1. [Global Config](#1-global-config)
2. [Domain Config](#2-domain-config)
3. [Agent Config](#3-agent-config)
4. [Job Config](#4-job-config)
5. [Budget Config](#5-budget-config)
6. [Context Sources](#6-context-sources)
7. [Expectations and Performance Policy](#7-expectations-and-performance-policy)
8. [Safety Config](#8-safety-config)
9. [Event Handlers](#9-event-handlers)
10. [Tool Gates](#10-tool-gates)
11. [Presets Reference](#11-presets-reference)
12. [Memory Governance](#12-memory-governance)
13. [Dispatch Config](#13-dispatch-config)
14. [Assignment Config](#14-assignment-config)
15. [Review Config](#15-review-config)
16. [Channels](#16-channels)
17. [Goals and Initiatives](#17-goals-and-initiatives)
18. [Skills and Skill Packs](#18-skills-and-skill-packs)
19. [Risk Tiers](#19-risk-tiers)
20. [Approval Policy](#20-approval-policy)
21. [Action Scopes](#21-action-scopes)
22. [Config Inheritance](#22-config-inheritance)

---

## 1. Global Config

**File:** `config.yaml` (project root or `~/.clawforce/config.yaml`)

The global config defines agents and optional defaults that apply across the project.

### Schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `defaults` | `GlobalDefaults` | No | `{}` | Default values inherited by all agents unless overridden. |
| `agents` | `Record<string, GlobalAgentDef>` | **Yes** | -- | Map of agent ID to agent definition. At least one agent required. |

### `defaults`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `performance_policy` | `PerformancePolicy` | `{ action: "alert" }` | Default performance policy for agents that don't specify one. |
| `performance_policy.action` | `"retry" \| "alert" \| "terminate_and_alert"` | `"alert"` | What happens when expectations are not met. |
| `performance_policy.max_retries` | `number` | `1` | How many times to retry (when action is `"retry"`). |
| `performance_policy.then` | `"alert" \| "terminate_and_alert"` | -- | Escalation action after retries exhausted. |

### `agents` (GlobalAgentDef)

Each entry in the `agents` map defines an agent at the global level. These are merged with domain-level overrides.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `extends` | `string` | -- | Preset to inherit from (`"manager"`, `"employee"`, `"assistant"`, or a user-defined preset). |
| `persona` | `string` | -- | System prompt personality. Keep under 4000 characters for context budget. |
| `title` | `string` | -- | Job title (e.g., "VP of Engineering"). |
| `skillCap` | `number` | -- | Maximum number of skills this agent can hold. |
| (any other field) | `unknown` | -- | Extensible — additional fields are passed through. |

### Example

```yaml
defaults:
  performance_policy:
    action: retry
    max_retries: 2
    then: alert

agents:
  ceo:
    extends: manager
    title: Chief Executive Officer
    persona: "You lead the company. Focus on strategic decisions."
    skillCap: 12

  frontend:
    extends: employee
    title: Frontend Developer
```

---

## 2. Domain Config

**File:** `domains/*.yaml` (e.g., `~/.clawforce/domains/engineering.yaml`)

Domain configs group agents by business domain, assigning code paths, policies, workflows, and rules.

### Schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `domain` | `string` | **Yes** | -- | Domain name (e.g., "engineering", "sales"). Must be non-empty. |
| `orchestrator` | `string` | No | -- | Agent ID responsible for coordinating this domain. |
| `paths` | `string[]` | No | `[]` | Code/project paths associated with this domain. |
| `agents` | `string[]` | **Yes** | -- | Agent IDs that belong to this domain. Must be an array. |
| `policies` | `unknown[]` | No | `[]` | Policy definitions scoped to this domain. |
| `budget` | `Record<string, unknown>` | No | `{}` | Budget configuration for this domain. |
| `workflows` | `string[]` | No | `[]` | Workflow names available in this domain. |
| `rules` | `RuleDefinition[]` | No | `[]` | Automation rules triggered by events. |
| `manager` | `Record<string, unknown>` | No | `{}` | Manager-specific overrides for this domain. |
| `context_sources` | `unknown[]` | No | `[]` | Additional context sources for domain agents. |
| `expectations` | `unknown[]` | No | `[]` | Domain-level expectations applied to all agents. |
| `jobs` | `Record<string, unknown>` | No | `{}` | Domain-scoped job definitions. |
| `knowledge` | `Record<string, unknown>` | No | `{}` | Knowledge lifecycle config for this domain. |
| `safety` | `Record<string, unknown>` | No | `{}` | Domain-level safety overrides. |
| `channels` | `unknown[]` | No | `[]` | Channel definitions for this domain. |
| `event_handlers` | `Record<string, unknown>` | No | `{}` | Event-action mappings scoped to this domain. |

### Rules (`RuleDefinition`)

Rules automate recurring decisions within a domain.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | **Yes** | -- | Rule name (must be non-empty). |
| `trigger` | `RuleTrigger` | **Yes** | -- | Event trigger condition. |
| `trigger.event` | `string` | **Yes** | -- | Event type that activates this rule. |
| `trigger.match` | `Record<string, unknown>` | No | -- | Payload field matching (all fields must match). |
| `action` | `RuleAction` | **Yes** | -- | What to do when the rule fires. |
| `action.agent` | `string` | **Yes** | -- | Agent ID to execute the action. |
| `action.prompt_template` | `string` | **Yes** | -- | Prompt template injected into the agent session. Supports `{{payload.field}}` interpolation. |
| `enabled` | `boolean` | No | `true` | Whether the rule is active. |

### Example

```yaml
domain: engineering
orchestrator: eng-lead
paths:
  - src/
  - tests/
agents:
  - eng-lead
  - frontend
  - backend

rules:
  - name: auto-fix-ci
    trigger:
      event: ci_failed
      match:
        branch: main
    action:
      agent: backend
      prompt_template: "CI failed on main. Error: {{payload.error}}. Fix and push."
    enabled: true

workflows:
  - feature-development
  - bug-fix
```

---

## 3. Agent Config

**File:** defined within the `agents` map of the global config

The full `AgentConfig` type covers every aspect of an agent's behavior, identity, and governance.

### Schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `extends` | `string` | No | -- | Preset to inherit defaults from. Built-in: `"manager"`, `"employee"`, `"assistant"`. Also accepts user-defined presets. The deprecated `"scheduled"` preset aliases to `"employee"`. |
| `title` | `string` | No | From preset | Job title (e.g., "VP of Engineering"). |
| `persona` | `string` | No | From preset | System prompt personality. Keep under 4000 chars. |
| `tools` | `string[]` | No | -- | Tools this agent is allowed to use. Supports merge operators (`+toolName`, `-toolName`). |
| `permissions` | `AgentPermissions` | No | `{}` | Agent-level permission grants. |
| `channel` | `string` | No | -- | Communication channel (e.g., `"telegram"`, `"slack"`). |
| `department` | `string` | No | -- | Department (e.g., "engineering", "sales"). Used for task routing and channel auto-join. |
| `team` | `string` | No | -- | Team within department (e.g., "frontend", "lead-gen"). |
| `briefing` | `ContextSource[]` | **Yes** | From preset | Context sources injected at session start. See [Context Sources](#6-context-sources). |
| `exclude_briefing` | `string[]` | No | `[]` | Source names to remove from the preset's default briefing baseline. |
| `expectations` | `Expectation[]` | **Yes** | From preset | Required tool calls per session. See [Expectations](#7-expectations-and-performance-policy). |
| `performance_policy` | `PerformancePolicy` | **Yes** | From preset | What happens when expectations are not met. |
| `reports_to` | `string` | No | `"parent"` | Escalation target. `"parent"` uses subagent auto-announce. Any other string must be a valid agent ID in the project. Cannot be self. |
| `compaction` | `boolean \| CompactionConfig` | No | From preset | Session compaction (knowledge preservation between sessions). |
| `skill_pack` | `string` | No | -- | Name of a skill pack to apply. Must reference a key in `skill_packs`. |
| `coordination` | `CoordinationConfig` | No | From preset | For agents that manage other agents. |
| `jobs` | `Record<string, JobDefinition>` | No | `{}` | Scoped sessions with their own briefing, expectations, and cron. See [Job Config](#4-job-config). |
| `scheduling` | `SchedulingConfig` | No | From preset | Autonomous scheduling parameters. |
| `skillCap` | `number` | No | From preset | Maximum number of skills. Must be >= 1. |

### `permissions` (AgentPermissions)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `can_hire` | `boolean` | `false` | Can this agent create new agents? |
| `can_fire` | `boolean` | `false` | Can this agent disable/remove agents? |
| `budget_limit_cents` | `number` | -- | Maximum daily spend in cents. Must be positive. |

### `coordination` (CoordinationConfig)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | From preset | Whether this agent coordinates other agents. Setting `true` marks the agent as a manager in the org hierarchy. |
| `schedule` | `string` | `"*/30 * * * *"` | Cron expression for coordination cycles. |

### `scheduling` (SchedulingConfig)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `adaptiveWake` | `boolean` | `false` | Allow the agent to adjust its own wake frequency. |
| `planning` | `boolean` | `false` | Enable dispatch plan creation before executing work. |
| `wakeBounds` | `[string, string]` | -- | Min and max cron frequency bounds. First element = fastest allowed, second = slowest allowed. Example: `["*/15 * * * *", "*/120 * * * *"]`. |

### `compaction` (CompactionConfig)

When specified as an object instead of a boolean:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | -- | Enable/disable compaction. |
| `files` | `string[]` | -- | Explicit file targets (relative to project dir). If omitted, derived from briefing sources. |

### Example

```yaml
agents:
  eng-lead:
    extends: manager
    title: VP of Engineering
    persona: "You lead the engineering org. Focus on shipping quality software."
    department: engineering
    channel: telegram
    permissions:
      can_hire: true
      can_fire: true
      budget_limit_cents: 5000
    briefing:
      - source: soul
      - source: task_board
      - source: cost_summary
      - source: team_status
      - source: velocity
    exclude_briefing:
      - sweep_status
    expectations:
      - tool: clawforce_log
        action: write
        min_calls: 1
      - tool: clawforce_compact
        action: update_doc
        min_calls: 1
    performance_policy:
      action: alert
    compaction:
      enabled: true
      files:
        - docs/engineering-status.md
    coordination:
      enabled: true
      schedule: "*/30 * * * *"
    scheduling:
      adaptiveWake: true
      planning: true
      wakeBounds: ["*/15 * * * *", "*/120 * * * *"]
    skillCap: 12
    jobs:
      weekly-review:
        extends: reflect
        cron: "0 9 * * FRI"
```

---

## 4. Job Config

Jobs are scoped sessions that run on a cron schedule with their own briefing, expectations, and delivery settings. Defined within an agent's `jobs` map.

### Naming Rules

Job names must match `/^[a-z][a-z0-9_-]*$/` (lowercase alphanumeric, hyphens, underscores, starting with a letter).

### Schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `extends` | `string` | No | -- | Job preset to inherit from. Built-in: `"reflect"`, `"triage"`. |
| `cron` | `string` | No | -- | Schedule. Accepts three formats (see below). |
| `cronTimezone` | `string` | No | -- | Timezone for cron expressions (e.g., `"America/New_York"`). Ignored for interval and `at:` schedules. Requires `cron` to be set. |
| `sessionTarget` | `"main" \| "isolated"` | No | `"isolated"` | Whether the job runs in the agent's main session or an isolated one. |
| `wakeMode` | `"now" \| "next-heartbeat"` | No | `"now"` | Whether to wake the agent immediately or at the next heartbeat. |
| `delivery` | `CronDelivery` | No | -- | How to deliver results when the cron job completes. |
| `failureAlert` | `CronFailureAlert` | No | -- | Alert configuration when the job fails. |
| `model` | `string` | No | -- | Model override for this job's sessions. |
| `timeoutSeconds` | `number` | No | -- | Session timeout in seconds. |
| `lightContext` | `boolean` | No | -- | Use reduced context for this job's sessions. |
| `deleteAfterRun` | `boolean` | No | `true` for `at:` schedules | Auto-delete the cron job after a single execution. |
| `briefing` | `ContextSource[]` | No | Base agent briefing | Context sources. Replaces the agent's base briefing when specified. |
| `exclude_briefing` | `string[]` | No | `[]` | Sources to remove from the agent's base briefing (only used when `briefing` is not specified). |
| `expectations` | `Expectation[]` | No | Base agent expectations | Compliance requirements. Replaces base when specified. |
| `performance_policy` | `PerformancePolicy` | No | Base agent policy | Failure behavior. Replaces base when specified. |
| `compaction` | `boolean \| CompactionConfig` | No | Base agent setting | Compaction config. Replaces base when specified. |
| `nudge` | `string` | No | -- | Custom prompt text for the cron payload. Replaces the default nudge. |

### Cron Schedule Formats

| Format | Example | Description |
|--------|---------|-------------|
| Interval shorthand | `"5m"`, `"2h"`, `"30s"`, `"1d"` | Run every N units. |
| Cron expression | `"0 9 * * MON-FRI"` | Standard 5-field cron (minute, hour, day, month, weekday). |
| One-shot datetime | `"at:2026-12-31T23:59:00Z"` | Run once at a specific time. Auto-sets `deleteAfterRun: true`. |

### `delivery` (CronDelivery)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `"none" \| "announce" \| "webhook"` | `"none"` | Delivery mode. `"announce"` pushes results to a channel. `"webhook"` sends to a URL. |
| `to` | `string` | -- | Target agent or destination for delivery. |
| `channel` | `"last" \| string` | -- | Channel name or `"last"` for most recent channel. |
| `accountId` | `string` | -- | Account ID for delivery routing. |
| `bestEffort` | `boolean` | -- | Whether delivery failures should be silently ignored. |

### `failureAlert` (CronFailureAlert)

Set to `false` to disable failure alerts. As an object:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `after` | `number` | -- | Number of consecutive failures before alerting. |
| `channel` | `"last" \| string` | -- | Alert channel. |
| `to` | `string` | -- | Alert recipient. |
| `cooldownMs` | `number` | -- | Minimum time between alerts in milliseconds. |
| `mode` | `"announce" \| "webhook"` | -- | Alert delivery mode. |
| `accountId` | `string` | -- | Account ID for alert routing. |

### Example

```yaml
jobs:
  daily-outreach:
    cron: "0 9 * * MON-FRI"
    cronTimezone: "America/New_York"
    sessionTarget: isolated
    model: claude-sonnet-4-6
    timeoutSeconds: 300
    nudge: "Run today's lead generation campaign."
    briefing:
      - source: assigned_task
      - source: memory
      - source: skill
    expectations:
      - tool: clawforce_task
        action: transition
        min_calls: 1
    performance_policy:
      action: retry
      max_retries: 2
      then: alert
    delivery:
      mode: announce
      channel: sales-updates

  one-time-migration:
    cron: "at:2026-04-01T00:00:00Z"
    nudge: "Run the database migration script."
    deleteAfterRun: true

  frequent-check:
    extends: triage
    cron: "*/15 * * * *"
    exclude_briefing:
      - pending_messages
```

---

## 5. Budget Config

Budgets enforce spending limits across three dimensions (cents, tokens, requests) and five time windows (hourly, daily, monthly, session, task).

### BudgetConfigV2

This is the current format. Each window is optional.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hourly` | `BudgetWindowConfig` | -- | Limits per clock hour. |
| `daily` | `BudgetWindowConfig` | -- | Limits per calendar day. |
| `monthly` | `BudgetWindowConfig` | -- | Limits per calendar month. |
| `session` | `BudgetWindowConfig` | -- | Limits per agent session. |
| `task` | `BudgetWindowConfig` | -- | Limits per task execution. |

### BudgetWindowConfig

Each window supports three dimensions. Any dimension can independently block dispatch.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cents` | `number` | -- | Maximum spend in cents. |
| `tokens` | `number` | -- | Maximum token usage. |
| `requests` | `number` | -- | Maximum number of LLM requests. |

### Budget Placement

Budgets can be set at the project level, per-agent, or both. Per-agent budgets override project defaults for that agent.

```yaml
budgets:
  project:
    daily: { cents: 10000, tokens: 5000000 }
    hourly: { cents: 2000 }
    monthly: { cents: 200000 }
  agents:
    frontend:
      daily: { cents: 3000, tokens: 1500000 }
    backend:
      daily: { cents: 3000 }
      session: { cents: 500, tokens: 200000, requests: 50 }
```

### BudgetConfig (Deprecated)

The legacy format is still accepted and auto-normalized to V2.

| Field | Type | Description |
|-------|------|-------------|
| `hourlyLimitCents` | `number` | Maps to `hourly.cents`. |
| `dailyLimitCents` | `number` | Maps to `daily.cents`. |
| `monthlyLimitCents` | `number` | Maps to `monthly.cents`. |
| `sessionLimitCents` | `number` | Maps to `session.cents`. |
| `taskLimitCents` | `number` | Maps to `task.cents`. |

### Budget Features

- **Hard dispatch gates** -- agents cannot exceed any budget dimension.
- **Initiative allocation** -- goals with `allocation` get a percentage of the daily budget.
- **Cascading budgets** -- managers allocate budget to direct reports.
- **Pre-flight plan validation** -- dispatch plans checked against remaining budget before execution.
- **Soft reservations** -- active plans hold budget to prevent over-allocation.
- **Cost forecasting** -- daily snapshots, weekly trends, monthly projections, exhaustion ETA.
- **Circuit breaker** -- dispatch paused at configurable multiplier of daily budget (see [Safety Config](#8-safety-config)).

---

## 6. Context Sources

Context sources are data streams injected into an agent's briefing at session start. Each source is specified in the `briefing` array.

### Source Format

```yaml
briefing:
  - source: soul                           # simple source
  - source: file                           # source with params
    path: docs/runbook.md
  - source: custom                         # inline content
    content: "Always check tests before merging."
  - source: knowledge                      # filtered source
    filter:
      category: [engineering]
      tags: [frontend]
  - source: custom_stream                  # named custom stream
    streamName: stale_tasks
  - source: cost_forecast                  # parameterized source
    params:
      horizon: "8h"
      granularity: per_initiative
```

### Available Sources

| Source | Description | Extra Fields |
|--------|-------------|-------------|
| `soul` | Agent identity and personality from SOUL.md. | -- |
| `tools_reference` | Available tools and their documentation. | -- |
| `instructions` | Project-level instructions. | -- |
| `project_md` | Project markdown documentation. Required for compaction. | -- |
| `task_board` | All tasks in the project with current states. Critical for managers. | -- |
| `assigned_task` | The specific task assigned to this agent. Critical for employees. | -- |
| `knowledge` | Knowledge base entries, optionally filtered. | `filter.category`, `filter.tags` |
| `file` | Raw file content. | `path` (required) |
| `custom` | Inline markdown content. | `content` (required) |
| `skill` | Skill topic documents associated with this agent. | -- |
| `memory` | Relevant memories from the vector store. | -- |
| `escalations` | Pending escalations requiring attention. | -- |
| `workflows` | Active workflow status and phases. | -- |
| `activity` | Recent activity log. | -- |
| `sweep_status` | Background sweep findings. | -- |
| `proposals` | Pending proposals awaiting approval. | -- |
| `agent_status` | Status of agents in the project. | -- |
| `cost_summary` | Spending summary (costs, budgets, burn rate). | -- |
| `policy_status` | Active policies and recent violations. | -- |
| `health_status` | System health indicators. | -- |
| `team_status` | Status of direct reports (for managers). | -- |
| `team_performance` | Performance metrics for the team. | -- |
| `pending_messages` | Unread messages for this agent. | -- |
| `goal_hierarchy` | Goal tree with completion status. | -- |
| `channel_messages` | Recent messages from channels the agent belongs to. | -- |
| `planning_delta` | What changed since the last planning session. | -- |
| `velocity` | Task completion velocity and trends. | -- |
| `preferences` | User/agent preferences (scheduling, communication, etc.). | -- |
| `trust_scores` | Trust scores per action category. | -- |
| `resources` | Rate limits, model costs, and resource availability. | -- |
| `initiative_status` | Initiative allocation, spend, and remaining budget. | -- |
| `cost_forecast` | Budget forecasting (daily snapshot, weekly trend, projections). | `params` |
| `available_capacity` | Available dispatch slots and budget headroom. | -- |
| `knowledge_candidates` | Memory entries flagged as promotion candidates. | -- |
| `budget_guidance` | Budget recommendations and cost estimation guidance. | -- |
| `onboarding_welcome` | Welcome message for newly activated agents. | -- |
| `weekly_digest` | Weekly summary of activity, spend, and performance. | -- |
| `intervention_suggestions` | Suggested interventions for team issues. | -- |
| `custom_stream` | User-defined data stream. | `streamName` (required), `params` |

### `exclude_briefing`

Remove sources from the preset's default baseline without replacing the entire briefing:

```yaml
agents:
  lightweight-worker:
    extends: employee
    exclude_briefing:
      - memory
      - channel_messages
```

Excluding critical sources generates a validation warning:
- Managers: excluding `task_board` warns about missing essential context.
- Employees: excluding `assigned_task` warns about missing essential context.

---

## 7. Expectations and Performance Policy

### Expectations

Expectations define required tool calls that must happen during a session. If not met, the performance policy triggers.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `tool` | `string` | **Yes** | -- | Tool name (e.g., `"clawforce_task"`, `"clawforce_log"`). |
| `action` | `string \| string[]` | **Yes** | -- | Required action(s). A single string or array of acceptable actions. |
| `min_calls` | `number` | **Yes** | -- | Minimum number of calls required. Must be >= 1. |

```yaml
expectations:
  - tool: clawforce_task
    action: transition
    min_calls: 1
  - tool: clawforce_log
    action: write
    min_calls: 1
  - tool: clawforce_compact
    action: update_doc
    min_calls: 1
```

### Performance Policy

Defines consequences when expectations are not met.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `action` | `"retry" \| "alert" \| "terminate_and_alert"` | **Yes** | -- | Primary action on failure. |
| `max_retries` | `number` | No | `1` | Number of retry attempts (only when action is `"retry"`). Validation warns if not set. |
| `then` | `"alert" \| "terminate_and_alert"` | No | -- | Escalation action after retries exhausted. Validation warns if not set. |

| Action | Behavior |
|--------|----------|
| `retry` | Re-dispatch the agent with context about what was missed. |
| `alert` | Send a notification via the configured channel (Telegram, Slack, etc.). |
| `terminate_and_alert` | Kill the session and send a notification. |

```yaml
performance_policy:
  action: retry
  max_retries: 3
  then: terminate_and_alert
```

### Escalation Chain

When performance issues escalate beyond retries, the `reports_to` field determines routing:

- `"parent"` (default): uses OpenClaw's subagent auto-announce to the parent session.
- `"<agentName>"`: injects the failure message into that agent's session.

Validation rejects self-referencing `reports_to` and cycles in the escalation chain. Chains deeper than 5 levels generate a warning.

---

## 8. Safety Config

Configurable guardrails with conservative defaults. All fields are optional.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxSpawnDepth` | `number` | `3` | Maximum depth of agent-spawning-agent chains. Must be a positive integer. |
| `costCircuitBreaker` | `number` | `1.5` | Budget multiplier before pausing all dispatch. E.g., `1.5` = pause at 150% of daily budget. Must be positive. Values <= 1.0 trigger a warning (circuit breaker fires before budget is reached). |
| `loopDetectionThreshold` | `number` | `3` | Same task title failed N times across all tasks triggers human intervention. Must be a positive integer. |
| `maxConcurrentMeetings` | `number` | `2` | Maximum active meetings per project. Must be a positive integer. |
| `maxMessageRate` | `number` | `60` | Maximum messages per minute per channel. Must be a positive integer. |

### Example

```yaml
safety:
  maxSpawnDepth: 4
  costCircuitBreaker: 2.0
  loopDetectionThreshold: 5
  maxConcurrentMeetings: 3
  maxMessageRate: 120
```

### Enforcement Points

| Check | Enforced At |
|-------|-------------|
| `maxSpawnDepth` | Dispatch (before agent spawn). |
| `costCircuitBreaker` | Dispatch (before task execution). |
| `loopDetectionThreshold` | Dispatch (same title failure count). |
| `maxConcurrentMeetings` | Meeting start (`startMeeting()`). |
| `maxMessageRate` | Message send (`createMessage()`), in-memory sliding window. |

---

## 9. Event Handlers

User-defined event-to-action mappings. Each event type maps to an array of actions that fire when the event occurs.

### Schema

```yaml
event_handlers:
  <event_type>:
    - action: <action_type>
      # action-specific fields...
```

### Event Types

The following are built-in event types. Users can also define custom event types.

| Event Type | Description |
|------------|-------------|
| `ci_failed` | CI/CD pipeline failure. |
| `pr_opened` | Pull request opened. |
| `deploy_finished` | Deployment completed. |
| `task_completed` | Task moved to DONE state. |
| `task_failed` | Task moved to FAILED state. |
| `task_assigned` | Task assigned to an agent. |
| `task_created` | New task created. |
| `task_review_ready` | Task moved to REVIEW state. |
| `sweep_finding` | Background sweep found an issue. |
| `dispatch_succeeded` | Dispatch completed successfully. |
| `dispatch_failed` | Dispatch failed. |
| `dispatch_dead_letter` | Dispatch exhausted all retries. |
| `proposal_approved` | Proposal approved. |
| `proposal_created` | New proposal created. |
| `proposal_rejected` | Proposal rejected. |
| `message_sent` | Message sent between agents. |
| `protocol_started` | Structured protocol initiated. |
| `protocol_responded` | Protocol received a response. |
| `protocol_completed` | Protocol completed successfully. |
| `protocol_expired` | Protocol timed out. |
| `protocol_escalated` | Protocol escalated. |
| `goal_created` | New goal created. |
| `goal_achieved` | Goal marked as achieved. |
| `goal_abandoned` | Goal abandoned. |
| `custom` | User-defined custom event. |

### Action Types

#### `create_task`

Create a new task when the event fires.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `action` | `"create_task"` | **Yes** | -- | -- |
| `template` | `string` | **Yes** | -- | Title template. Supports `{{payload.field}}` interpolation. |
| `description` | `string` | No | -- | Description template. |
| `priority` | `TaskPriority` | No | `"P2"` | Task priority (`P0`-`P3`). |
| `assign_to` | `string` | No | -- | `"auto"` for auto-assignment, or an agent name. Validated against configured agents. |
| `department` | `string` | No | -- | Department for the created task. |
| `team` | `string` | No | -- | Team for the created task. |

#### `notify`

Send a notification message.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `action` | `"notify"` | **Yes** | -- | -- |
| `message` | `string` | **Yes** | -- | Message template. Supports `{{payload.field}}` interpolation. |
| `to` | `string` | No | First manager | Target agent name. |
| `priority` | `"low" \| "normal" \| "high" \| "urgent"` | No | `"normal"` | Message priority. |

#### `escalate`

Escalate to a manager or named agent.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `action` | `"escalate"` | **Yes** | -- | -- |
| `to` | `string` | **Yes** | -- | Target: `"manager"` or an agent name. Validated against configured agents. |
| `message` | `string` | No | -- | Message template. |

#### `enqueue_work`

Enqueue a task for dispatch through the queue.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `action` | `"enqueue_work"` | **Yes** | -- | -- |
| `task_id` | `string` | No | `payload.taskId` | Task ID (template string or defaults to payload). |
| `priority` | `number` | No | -- | Queue priority 0-3. |

#### `emit_event`

Emit a follow-on event (chain events).

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `action` | `"emit_event"` | **Yes** | -- | -- |
| `event_type` | `string` | **Yes** | -- | Event type to emit. |
| `event_payload` | `Record<string, string>` | No | -- | Payload template. Each value supports `{{payload.field}}`. |
| `dedup_key` | `string` | No | -- | Deduplication key template. |

### Example

```yaml
event_handlers:
  ci_failed:
    - action: create_task
      template: "Fix CI: {{payload.test_name}}"
      priority: P1
      assign_to: auto
      department: engineering
    - action: notify
      message: "CI failed: {{payload.test_name}} on {{payload.branch}}"
      to: eng-lead
      priority: high
    - action: escalate
      to: manager

  task_completed:
    - action: emit_event
      event_type: custom
      event_payload:
        summary: "Task {{payload.taskId}} completed by {{payload.agentId}}"

  deploy_finished:
    - action: create_task
      template: "Smoke test {{payload.environment}}"
      assign_to: auto
```

---

## 10. Tool Gates

Classify external tools by risk tier and apply gate actions. Works with any tool accessible through OpenClaw (MCP servers, native tools, etc.) via the `before_tool_call` hook.

### ToolGateEntry

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `category` | `string` | **Yes** | -- | Action category (see built-in categories below). Custom categories accepted but generate a validation notice. |
| `tier` | `RiskTier` | **Yes** | -- | Risk classification: `"low"`, `"medium"`, `"high"`, `"critical"`. |
| `gate` | `RiskGateAction` | No | From tier policy | Override the gate action for this specific tool. |

### Gate Actions

| Action | Behavior |
|--------|----------|
| `none` | Auto-approve. No intervention. |
| `delay` | Add a configurable delay before execution. |
| `confirm` | Quick inline yes/no confirmation. |
| `approval` | Full proposal workflow with context. |
| `human_approval` | Block until a human explicitly approves. |

### Built-in Action Categories

| Domain | Categories |
|--------|-----------|
| Communication | `email:send`, `email:forward`, `message:send`, `social:post` |
| Calendar | `calendar:create_event`, `calendar:cancel_event`, `calendar:reschedule` |
| Financial | `financial:purchase`, `financial:transfer`, `financial:subscribe`, `financial:pay_bill` |
| Code | `code:merge_pr`, `code:deploy`, `code:push`, `code:release` |
| Data | `data:delete`, `data:share`, `data:permission_change` |
| Booking | `booking:create`, `booking:cancel`, `booking:modify` |

Custom categories are allowed. Non-built-in categories generate a validation notice.

### Bulk Thresholds

Escalate the risk tier when an agent calls a tool category too many times within a time window.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `windowMs` | `number` | **Yes** | Time window in milliseconds. Must be positive. |
| `maxCount` | `number` | **Yes** | Maximum calls before escalation. Must be positive. |
| `escalateTo` | `RiskTier` | **Yes** | Tier to escalate to when threshold exceeded. |

### Example

```yaml
toolGates:
  "mcp:gmail:send":
    category: "email:send"
    tier: high
  "mcp:gcal:create_event":
    category: "calendar:create_event"
    tier: medium
    gate: confirm              # override: quick confirm instead of tier default
  "mcp:github:merge_pr":
    category: "code:merge_pr"
    tier: critical
  "mcp:stripe:create_charge":
    category: "financial:purchase"
    tier: critical
    gate: human_approval

bulkThresholds:
  "email:send":
    windowMs: 3600000          # 1 hour
    maxCount: 10
    escalateTo: critical
  "calendar:create_event":
    windowMs: 3600000
    maxCount: 20
    escalateTo: high
```

---

## 11. Presets Reference

Presets provide default configurations that agents and jobs inherit from via `extends`.

### Built-in Agent Presets

#### `manager`

For agents that coordinate teams, delegate work, and review results.

| Field | Default Value |
|-------|---------------|
| `title` | `"Manager"` |
| `persona` | `"You are a manager agent responsible for coordinating your team, delegating tasks, and reviewing results."` |
| `briefing` | `soul`, `tools_reference`, `project_md`, `task_board`, `goal_hierarchy`, `escalations`, `team_status`, `trust_scores`, `cost_summary`, `resources`, `pending_messages`, `channel_messages`, `memory`, `skill`, `policy_status`, `preferences`, `cost_forecast`, `available_capacity`, `knowledge_candidates`, `budget_guidance`, `onboarding_welcome`, `weekly_digest`, `intervention_suggestions` |
| `expectations` | `clawforce_log.write` (min 1), `clawforce_compact.update_doc` (min 1) |
| `performance_policy` | `{ action: "alert" }` |
| `compaction` | `true` |
| `coordination` | `{ enabled: true, schedule: "*/30 * * * *" }` |
| `scheduling` | `{ adaptiveWake: true, planning: true, wakeBounds: ["*/15 * * * *", "*/120 * * * *"] }` |
| `skillCap` | `12` |

**Action scope:** Full access (`"*"`) to all clawforce tools plus `memory_search` and `memory_get`.

#### `employee`

For agents that execute assigned tasks and report results.

| Field | Default Value |
|-------|---------------|
| `title` | `"Employee"` |
| `persona` | `"You are an employee agent responsible for executing assigned tasks and reporting results."` |
| `briefing` | `soul`, `tools_reference`, `assigned_task`, `pending_messages`, `channel_messages`, `memory`, `skill` |
| `expectations` | `clawforce_task.transition` (min 1), `clawforce_log.write` (min 1) |
| `performance_policy` | `{ action: "retry", max_retries: 3, then: "alert" }` |
| `compaction` | `false` |
| `coordination` | `{ enabled: false }` |
| `skillCap` | `8` |

**Action scope:** Restricted access. Key restrictions:
- `clawforce_task`: `get`, `list`, `transition`, `fail`, `attach_evidence`, `history`, `get_approval_context`, `submit_proposal`, `check_proposal`, `list_deps`, `list_dependents`, `list_blockers`
- `clawforce_log`: `write`, `outcome`, `search`, `list`
- `clawforce_setup`: `explain`, `status` only
- `clawforce_message`: send/receive actions, protocol participation (no creation of protocols)
- `clawforce_goal`: `get`, `list`, `status` only
- `clawforce_channel`: `send`, `list`, `history`, `meeting_status`, `join`, `leave`
- No access to `clawforce_ops` or `clawforce_workflow`

#### `assistant`

For personal assistant or clerical/EA agents.

| Field | Default Value |
|-------|---------------|
| `title` | `"Personal Assistant"` |
| `persona` | `"You are a personal assistant agent focused on communication, memory management, and helping users."` |
| `briefing` | `soul`, `tools_reference`, `pending_messages`, `channel_messages`, `memory`, `skill`, `preferences` |
| `expectations` | `[]` (none -- assistant work is user-driven, not compliance-driven) |
| `performance_policy` | `{ action: "alert" }` |
| `compaction` | `true` |
| `coordination` | `{ enabled: false }` |

**Action scope:** Similar to employee but without task management tools. Has `clawforce_log`, `clawforce_setup` (explain/status), `clawforce_context`, `clawforce_message`, `clawforce_channel`, `memory_search`, `memory_get`.

#### `scheduled` (Deprecated)

Aliases to `employee`. Use `employee` with a `jobs` section instead.

### Built-in Job Presets

#### `reflect`

Strategic reflection job for managers. Dedicated thinking time, not task dispatch.

| Field | Default Value |
|-------|---------------|
| `cron` | `"0 9 * * MON"` (weekly, Monday 9am) |
| `briefing` | `team_performance`, `cost_summary`, `velocity`, `trust_scores` |
| `nudge` | `"Review team performance. Consider: budget rebalancing, agent hiring/splitting, skill gaps, initiative reprioritization."` |
| `performance_policy` | `{ action: "alert" }` |

#### `triage`

Frequent coordination check for managers. Handle stuck tasks and escalations.

| Field | Default Value |
|-------|---------------|
| `cron` | `"*/30 * * * *"` (every 30 minutes) |
| `briefing` | `task_board`, `escalations`, `pending_messages` |
| `nudge` | `"Check on your team. Reassign stuck tasks, handle escalations."` |
| `performance_policy` | `{ action: "alert" }` |

### User-Defined Presets

Define custom presets using the same fields as agent or job configs. They can chain via `extends`:

```yaml
# In workforce config
skill_packs:
  sales-standard:
    briefing:
      - source: memory
      - source: skill
    expectations:
      - tool: clawforce_log
        action: write
        min_calls: 1

# In agent config
agents:
  sales-rep:
    extends: employee
    skill_pack: sales-standard
```

---

## 12. Memory Governance

Memory governance controls how agents interact with OpenClaw's memory system (RAG vector store).

### Knowledge Lifecycle Config

Defined at the project level in the `knowledge` field.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `promotionThreshold` | `object` | -- | Thresholds for surfacing promotion candidates. |
| `promotionThreshold.minRetrievals` | `number` | -- | Minimum retrieval count before a memory becomes a promotion candidate. |
| `promotionThreshold.minSessions` | `number` | -- | Minimum number of sessions that accessed the memory. |

### Promotion Targets

When a memory entry crosses promotion thresholds, it becomes a candidate for promotion to structured knowledge:

| Target | Description |
|--------|-------------|
| `soul` | Agent identity/personality (SOUL.md). For memories about the agent's approach or values. |
| `skill` | Skill topic document. For domain knowledge applicable to the role. |
| `project_doc` | Project documentation. For project-level knowledge. |
| `rule` | Automation rule. For recurring decision patterns. |

### Knowledge Flagging

Agents can flag incorrect knowledge during task execution. Flags are reviewed by managers or knowledge agents.

| Severity | Description |
|----------|-------------|
| `low` | Minor inaccuracy, doesn't affect outcomes. |
| `medium` | Incorrect information that could lead to suboptimal results. |
| `high` | Critically wrong knowledge that causes failures. |

### Example

```yaml
knowledge:
  promotionThreshold:
    minRetrievals: 20
    minSessions: 10
```

### Related Briefing Sources

- `memory` -- injects relevant memories into agent context.
- `knowledge_candidates` -- shows memories flagged as promotion candidates (for managers).

---

## 13. Dispatch Config

Controls concurrency and rate limiting for task dispatch.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxConcurrentDispatches` | `number` | `3` | Max concurrent dispatches per project. |
| `maxDispatchesPerHour` | `number` | -- | Max dispatches per hour per project. |
| `agentLimits` | `Record<string, AgentLimit>` | `{}` | Per-agent concurrency and rate limits. |

### Agent Limits

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxConcurrent` | `number` | -- | Max concurrent dispatches for this agent. |
| `maxPerHour` | `number` | -- | Max dispatches per hour for this agent. |

### Example

```yaml
dispatch:
  maxConcurrentDispatches: 5
  maxDispatchesPerHour: 50
  agentLimits:
    frontend:
      maxConcurrent: 2
      maxPerHour: 10
    backend:
      maxConcurrent: 3
      maxPerHour: 15
```

---

## 14. Assignment Config

Configures the auto-assignment engine for routing tasks to agents.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable auto-assignment (opt-in). |
| `strategy` | `AssignmentStrategy` | `"workload_balanced"` | Assignment algorithm. |
| `autoDispatchOnAssign` | `boolean` | `true` (when enabled) | Automatically dispatch tasks when assigned. |

### Strategies

| Strategy | Description |
|----------|-------------|
| `workload_balanced` | Match by department/team, pick agent with fewest active tasks. **Default.** |
| `round_robin` | Rotate through available agents in the department. |
| `skill_matched` | Match task tags to agent skills/tags. |

All strategies check: agent not disabled, not budget-exhausted, not at max concurrent tasks.

### Example

```yaml
assignment:
  enabled: true
  strategy: workload_balanced
  autoDispatchOnAssign: true
```

---

## 15. Review Config

Controls task verification gates.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `verifierAgent` | `string` | -- | Explicit verifier agent ID. Must be a valid agent in the project. If omitted, falls back to regex pattern matching (`/verifier|reviewer/i`). |
| `autoEscalateAfterHours` | `number` | -- | Hours before a REVIEW task with no verifier action triggers escalation. Must be positive. |
| `selfReviewAllowed` | `boolean` | `false` | Whether task assignees can review their own work. |
| `selfReviewMaxPriority` | `TaskPriority` | `"P3"` | Maximum priority that allows self-review. Higher priority tasks always require cross-verification. Only effective when `selfReviewAllowed` is `true`. |

### Example

```yaml
review:
  verifierAgent: qa-agent
  autoEscalateAfterHours: 4
  selfReviewAllowed: true
  selfReviewMaxPriority: P3
```

---

## 16. Channels

Persistent group communication channels for agent collaboration. Channels can be mirrored to Telegram groups.

### ChannelConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | **Required** | Channel name. Must be unique within the project. |
| `type` | `"topic" \| "meeting"` | `"topic"` | Channel type. `"meeting"` enables round-robin meeting mode. |
| `members` | `string[]` | `[]` | Explicit agent IDs to add as members. Validated against configured agents. |
| `departments` | `string[]` | `[]` | Auto-join agents by department. |
| `teams` | `string[]` | `[]` | Auto-join agents by team. |
| `presets` | `string[]` | `[]` | Auto-join agents by preset (e.g., `"manager"`). |
| `telegramGroupId` | `string` | -- | Telegram group ID for mirroring channel messages. |
| `telegramThreadId` | `number` | -- | Telegram thread/topic ID within the group. |

### Example

```yaml
channels:
  - name: engineering
    type: topic
    departments: [engineering]
    telegramGroupId: "-100123456789"

  - name: standup
    type: meeting
    members: [eng-lead, frontend, backend]
    telegramGroupId: "-100123456789"
    telegramThreadId: 42

  - name: all-hands
    type: topic
    presets: [manager]
```

---

## 17. Goals and Initiatives

Goals form a hierarchy with completion cascade. Goals with an `allocation` field are initiatives -- strategic priorities with hard budget enforcement.

### GoalConfigEntry

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | `string` | -- | Goal description. |
| `allocation` | `number` | -- | Percentage of daily budget allocated to this initiative (0-100). Makes this goal an initiative. |
| `department` | `string` | -- | Department this goal belongs to. |
| `team` | `string` | -- | Team this goal belongs to. |
| `acceptance_criteria` | `string` | -- | Criteria for marking this goal as achieved. |
| `owner_agent_id` | `string` | -- | Agent responsible for this goal. |

Unallocated remainder (100 minus sum of all allocations) becomes an implicit reserve for ad-hoc work.

### Example

```yaml
goals:
  ui-improvements:
    description: "Dashboard UX improvements based on user feedback"
    allocation: 40
    department: engineering
    team: frontend
    acceptance_criteria: "All 5 UX tickets resolved, Lighthouse score > 90"
    owner_agent_id: frontend

  customer-outreach:
    description: "Daily lead generation and follow-ups"
    allocation: 30
    department: sales
    owner_agent_id: lead-gen

  maintenance:
    description: "Bug fixes, dependency updates, tech debt"
    allocation: 20
    department: engineering
```

---

## 18. Skills and Skill Packs

### Custom Skill Topics

Domain-specific markdown documents accessible to agents via the skill system.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | **Yes** | Skill topic title. |
| `description` | `string` | **Yes** | Brief description of what this skill covers. |
| `path` | `string` | **Yes** | Path to the markdown file (relative to project dir). Must not contain `..` (no path traversal). |
| `presets` | `string[]` | No | Agent presets that should have access to this skill. |

```yaml
skills:
  lead-gen:
    title: Lead Generation
    description: "Best practices for outbound lead generation campaigns."
    path: skills/lead-gen.md
    presets: [employee]

  crm-integration:
    title: CRM Integration
    description: "How to interact with the CRM API."
    path: skills/crm.md
```

### Skill Packs

Reusable config bundles that agents reference by name. Applied on top of the agent's preset defaults.

| Field | Type | Description |
|-------|------|-------------|
| `briefing` | `ContextSource[]` | Additional briefing sources. |
| `expectations` | `Expectation[]` | Compliance requirements. |
| `performance_policy` | `PerformancePolicy` | Failure behavior. |

```yaml
skill_packs:
  sales-standard:
    briefing:
      - source: memory
      - source: skill
      - source: preferences
    expectations:
      - tool: clawforce_log
        action: write
        min_calls: 1
    performance_policy:
      action: retry
      max_retries: 2
      then: alert

agents:
  sales-rep:
    extends: employee
    skill_pack: sales-standard
```

Validation ensures the referenced `skill_pack` exists in the project's `skill_packs` map.

### Skill Cap

Agents have a configurable `skillCap` (default: 8 for employees, 12 for managers). When an agent's skill count approaches or exceeds the cap, Clawforce surfaces a warning in the manager's briefing suggesting the agent be split into specialists.

---

## 19. Risk Tiers

Global risk tier configuration for the project.

### RiskTierConfig

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | `boolean` | **Yes** | -- | Enable risk-tier-based gating. |
| `defaultTier` | `RiskTier` | **Yes** | -- | Default tier for unclassified actions. |
| `policies` | `Record<RiskTier, TierPolicy>` | **Yes** | -- | Gate action for each tier. |
| `patterns` | `RiskPattern[]` | **Yes** | -- | Rules for classifying actions into tiers. |

### Tier Policy

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `gate` | `RiskGateAction` | **Yes** | Gate action for this tier. |
| `delayMs` | `number` | No | Delay duration when gate is `"delay"`. |

### Risk Patterns

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `match` | `Record<string, unknown>` | **Yes** | Fields to match against the action context. |
| `tier` | `RiskTier` | **Yes** | Tier to assign when pattern matches. |

### Example

```yaml
riskTiers:
  enabled: true
  defaultTier: low
  policies:
    low: { gate: none }
    medium: { gate: confirm }
    high: { gate: approval }
    critical: { gate: human_approval }
  patterns:
    - match: { tool: "mcp:gmail:send" }
      tier: high
    - match: { department: "finance" }
      tier: critical
```

---

## 20. Approval Policy

Top-level policy text served to managers when they make approval decisions on proposals.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `policy` | `string` | **Yes** | Natural language policy text. Injected into manager context at approval decision time. |

When an approval policy is set, validation checks that manager agents have an expectation for `clawforce_task.get_approval_context` or `clawforce_task.propose`.

### Example

```yaml
approval:
  policy: >
    Approve tasks that align with current sprint goals.
    Reject tasks that would exceed the daily budget by more than 20%.
    Escalate any task involving production deployments to a human.
```

---

## 21. Action Scopes

Action scopes define which tools and actions each agent role can access. They are auto-generated from the agent's `extends` preset unless an explicit `action_scope` policy overrides them.

### Format

```
Record<toolName, allowedActions>
```

Where `allowedActions` is:
- `"*"` -- all actions allowed for that tool.
- `string[]` -- only listed actions permitted.
- `ActionConstraint` -- actions with runtime constraints.

### ActionConstraint

| Field | Type | Description |
|-------|------|-------------|
| `actions` | `string[] \| "*"` | Allowed actions. |
| `constraints` | `ActionConstraints` | Runtime constraints on those actions. |

### ActionConstraints

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `own_tasks_only` | `boolean` | `false` | Agent can only operate on tasks assigned to itself. |
| `department_only` | `boolean` | `false` | Agent can only operate on tasks in its department. |

### Overriding Default Scopes

Use an explicit `action_scope` policy to override the preset defaults:

```yaml
policies:
  - name: custom-scope-frontend
    type: action_scope
    target: frontend
    config:
      allowed_tools:
        clawforce_task:
          actions: [get, list, transition, attach_evidence]
          constraints:
            own_tasks_only: true
        clawforce_log: "*"
```

---

## 22. Config Inheritance

Clawforce uses a layered inheritance system with deep merge and array merge operators.

### Inheritance Chain

1. **Built-in preset** (e.g., `manager`, `employee`, `assistant`)
2. **User-defined preset** (optional intermediate layer)
3. **Agent config** (final overrides)

Each layer deep-merges objects and replaces arrays (unless merge operators are used).

### Array Merge Operators

When an array contains only strings prefixed with `+` or `-`, it is treated as a merge operation against the parent array:

| Operator | Effect |
|----------|--------|
| `+value` | Add `value` to the parent array (if not already present). |
| `-value` | Remove `value` from the parent array. |

If the array contains any non-prefixed items, it fully replaces the parent array.

```yaml
agents:
  custom-manager:
    extends: manager
    # Add initiative_status, remove sweep_status from manager's default briefing
    briefing: ["+initiative_status", "-sweep_status"]
```

### Deep Merge Rules

- **Objects:** recursively merged (child keys override parent keys).
- **Arrays with merge operators:** `+`/`-` operators applied to parent array.
- **Arrays without operators:** child array fully replaces parent array.
- **Scalars:** child value replaces parent value.

### Circular Detection

Clawforce detects circular `extends` chains and throws an error:

```
Error: Circular extends chain detected: a -> b -> c -> a
```

### Profile Application

When an agent specifies `extends`, the profile system:

1. **Briefing:** preset baseline (minus `exclude_briefing`) merged with agent additions (deduplicated).
2. **Expectations:** agent replaces if specified (even if empty array), otherwise inherits preset defaults.
3. **Performance policy:** agent replaces if specified, otherwise inherits preset defaults.

---

## Validation Summary

The config validator runs at activation and produces three severity levels:

| Level | Behavior |
|-------|----------|
| `error` | Configuration problem that will cause runtime failures. Should be fixed before activation. |
| `warn` | Non-fatal issue that may cause unexpected behavior. |
| `suggest` | Best-practice recommendation. Non-blocking. |

### Key Validation Rules

- **Runtime fields rejected:** `model` and `provider` belong in OpenClaw's agent config, not Clawforce. Setting them in Clawforce config produces an error with a migration message.
- **Escalation cycles:** `reports_to` chains are walked; cycles produce an error.
- **Escalation depth:** chains deeper than 5 levels produce a warning.
- **Empty expectations:** agents extending `manager` or `employee` with empty expectations produce a warning.
- **Orphan references:** `reports_to`, `verifierAgent`, `assign_to`, channel members, and `skill_pack` references are validated against defined agents and packs.
- **Job naming:** must match `/^[a-z][a-z0-9_-]*$/`.
- **Cron format:** unrecognized formats produce a warning (defaults to 5m interval).
- **Budget suggestion:** projects with 3+ agents and no budget config get a suggestion.
- **Skill cap proximity:** agents approaching their skill cap get a suggestion.
- **Compaction coherence:** compaction enabled without compactable sources or expectations produces a warning.
