# clawforce

**Your AI agents are employees. Clawforce is their HR department.**

Budget enforcement, compliance tracking, org hierarchy, performance management, and trust evolution — in one [OpenClaw](https://github.com/openclaw/openclaw) plugin. The only agent framework where "you can't dispatch that task because the engineering initiative already burned through its daily allocation" is a real sentence.

## Before / After

**Without Clawforce:** You manually wire OpenClaw agents with custom cron jobs, hand-rolled compliance, spreadsheet budgets, and hope nobody overspends. When an agent fails, you find out tomorrow.

**With Clawforce:**

```yaml
agents:
  lead:
    title: Engineering Lead
  frontend:
    title: Frontend Dev
    reports_to: lead
  backend:
    title: Backend Dev
    reports_to: lead

budget:
  daily: { cents: 5000, tokens: 3000000 }
```

That's it. Roles inferred from structure. Budgets enforced automatically. Compliance tracked. Failures escalated. Manager wakes up on a cron, plans its day around remaining budget, dispatches work, reviews results.

## Why Clawforce

No other framework does this:

| Capability | Clawforce | CrewAI | LangGraph | AutoGen |
|-----------|-----------|--------|-----------|---------|
| Per-agent budget enforcement | Hard gates, 3 dimensions | No | No | No |
| Compliance & audit trails | Built-in, every session | No | No | No |
| Org hierarchy with reporting chains | First-class | Roles only | Patterns only | Chat groups |
| Progressive trust / earned autonomy | Track record based | No | No | No |
| Initiative-level budget allocation | % of daily budget | No | No | No |
| Pre-flight plan validation | Validates before dispatch | No | No | No |
| EU AI Act ready | Audit trails + accountability | No | No | No |

## Quick Start

### 1. Install

```bash
npm install clawforce
```

Requires Node 22+ and an [OpenClaw](https://github.com/openclaw/openclaw) installation.

### 2. Initialize

```bash
# Interactive setup — answers 5 questions, generates config
clawforce init
```

Or create `~/.clawforce/config.yaml` manually:

```yaml
agents:
  sarah:
    extends: manager
    title: VP of Sales
    persona: "You manage the sales team. Focus on pipeline growth."
    department: sales
    channel: telegram

  lead-gen:
    extends: employee
    title: Lead Generation Specialist
    department: sales
    reports_to: sarah
    jobs:
      daily-outreach:
        cron: "0 9 * * MON-FRI"
        nudge: "Run today's lead generation campaign."
```

And a domain config at `~/.clawforce/domains/sales.yaml`:

```yaml
domain: sales
agents: [sarah, lead-gen]
paths: ["~/projects/sales-pipeline"]
```

### 3. Activate

Clawforce runs as an OpenClaw plugin. Once config is set, agents are managed automatically — budget gates, compliance checks, escalation routing, and context injection happen on every session.

## Core Concepts

### Agents Are Employees

Every agent has a title, department, reporting chain, and performance expectations. Not metaphorically — the system enforces accountability the way a real organization would.

```
CEO (extends: manager)
├── VP Engineering (extends: manager, reports_to: ceo)
│   ├── Frontend Dev (extends: employee, reports_to: vp-eng)
│   └── Backend Dev (extends: employee, reports_to: vp-eng)
└── VP Sales (extends: manager, reports_to: ceo)
    └── Lead Gen (extends: employee, reports_to: vp-sales)
```

Two built-in presets:

- **`manager`** — Coordinates the team. Creates tasks, reviews work, allocates budget. Wakes on a cron, plans its day, dispatches work.
- **`employee`** — Executes assigned tasks. Must transition tasks to completion, attach evidence, meet expectations.

Roles can be inferred automatically — if other agents report to you, you're a manager.

### Budget Enforcement

Three budget dimensions (cents, tokens, requests) across three time windows (hourly, daily, monthly). Any dimension can block dispatch.

```yaml
budget:
  daily: { cents: 10000, tokens: 5000000 }
  hourly: { cents: 2000 }
  monthly: { cents: 200000 }
```

Features:
- **Hard dispatch gates** — agents cannot exceed budget, period
- **Initiative allocation** — "UI improvements gets 40% of daily budget"
- **Cascading budgets** — managers allocate to reports
- **Pre-flight plan validation** — "this plan costs $45, you have $30 remaining" blocks before starting
- **Soft reservations** — active plans hold budget so other dispatches can't steal it
- **Cost forecasting** — weekly trends, monthly projections, exhaustion ETA
- **Circuit breaker** — pause at 1.5x daily budget (configurable)

### Accountability

Agents have expectations — required tool calls that must happen before a session ends:

```yaml
expectations:
  - tool: clawforce_task
    action: transition
    min_calls: 1
  - tool: clawforce_log
    action: write
    min_calls: 1
```

If expectations aren't met, the performance policy kicks in:

| Action | Behavior |
|--------|----------|
| `retry` | Re-run with "you didn't do X" context |
| `alert` | Notify via Telegram/Slack/Discord |
| `terminate_and_alert` | Kill and notify |

```yaml
performance_policy:
  action: retry
  max_retries: 3
  then: terminate_and_alert
```

Every session is audited. Compliance is tracked. Failures route up the reporting chain.

### Task Lifecycle

```
OPEN → ASSIGNED → IN_PROGRESS → REVIEW → DONE
                                   ↓
                              FAILED / BLOCKED
```

- **Evidence required** — moving to REVIEW needs at least one evidence attachment
- **Verifier gate** — a different agent must approve REVIEW → DONE
- **Retry limit** — FAILED → OPEN blocked when retries exhausted
- **Goal linking** — tasks inherit priority from their goal

### Trust Evolution

Agents earn autonomy based on track record. 47 approved emails with 0 rejections? Suggest auto-approving routine replies. Trust scores tracked per action category, with configurable decay.

### Goals & Initiatives

Full goal hierarchy with completion cascade. Goals with `allocation` are initiatives — strategic priorities with hard budget enforcement:

```yaml
goals:
  ui-improvements:
    allocation: 40
    description: "Dashboard UX improvements"
  customer-outreach:
    allocation: 30
    description: "Daily lead gen and follow-ups"
```

When an initiative's spend reaches its allocation percentage of the daily budget, dispatch is blocked for all tasks under that goal tree.

### Communication

Structured agent-to-agent protocols:
- **Direct messages** — agents DM each other
- **Request/response** — formal ask with timeout
- **Delegation** — assign sub-work with report-back
- **Channels & meetings** — topic-based channels with meeting mode, mirrored to Telegram

### Memory

OpenClaw provides the memory infrastructure (RAG vector store). Clawforce provides memory governance:
- **Ghost recall** — per-turn LLM triage enriches context with relevant memories
- **Retrieval tracking** — frequently-accessed memories surface as promotion candidates
- **Promotion pipeline** — memories promoted to SOUL.md, skills, or project docs
- **Knowledge flagging** — wrong knowledge flagged, corrected at source

### Data Streams

29+ built-in context sources, parameterizable, with multi-output routing:

```yaml
routing:
  cost_alert:
    source: cost_forecast
    params: { horizon: "4h" }
    condition: "exhausts_within_hours < 4"
    outputs:
      - target: telegram
        channel: eng-alerts
      - target: webhook
        url: https://hooks.example.com/budget
```

Custom SQL streams over Clawforce's SQLite database:

```yaml
streams:
  stale_tasks:
    description: "Tasks open > 48 hours"
    query: >
      SELECT id, title FROM tasks
      WHERE state = 'OPEN' AND created_at < unixepoch() - 172800
```

## Config Inheritance

Agents inherit from presets using `extends:`. Merge operators compose config:

```yaml
agents:
  custom-manager:
    extends: manager
    briefing: ["+initiative_status", "-sweep_status"]
```

User-defined presets for reusable templates:

```yaml
presets:
  sales-rep:
    extends: employee
    skills: [lead-gen, crm-integration]

agents:
  rep-west:
    extends: sales-rep
    title: West Coast Rep
    reports_to: sarah
```

Job presets for recurring work:

```yaml
jobs:
  weekly-review:
    extends: reflect      # built-in: strategic review
    cron: "0 9 * * FRI"
  coordination:
    extends: triage       # built-in: frequent task board check
    cron: "*/30 * * * *"
```

## Architecture

Clawforce is a **governance layer** that composes with OpenClaw. It doesn't own agent runtime (model, tools, compaction mechanics) — OpenClaw handles those. Clawforce owns the organizational layer: who does what, how much they can spend, what they're accountable for, and how they earn trust.

```
Clawforce (Governance)
├── Org Model — titles, reporting chains, departments
├── Budget — enforcement, allocation, forecasting
├── Compliance — expectations, performance policies, audit
├── Tasks — state machine, assignment, verification
├── Goals — hierarchy, initiatives, completion cascade
├── Trust — earned autonomy, progressive trust
├── Communication — protocols, meetings, channels
├── Memory — ghost recall, promotion/demotion lifecycle
└── Data Streams — catalog, routing, custom queries

OpenClaw (Runtime)
├── Model execution, tools, compaction
├── Memory RAG (vector store, embeddings)
├── Cron scheduling
├── Channel delivery (Telegram, Slack, Discord, etc.)
└── Session management
```

## Tools

| Tool | Purpose |
|------|---------|
| `clawforce_task` | Create tasks, transition states, attach evidence |
| `clawforce_log` | Write knowledge entries, log outcomes |
| `clawforce_verify` | Request verification, submit verdicts |
| `clawforce_workflow` | Multi-phase workflow management |
| `clawforce_ops` | Agent status, dispatch, budget allocation, plans |
| `clawforce_goal` | Goal hierarchy, initiatives, decomposition |
| `clawforce_message` | Agent-to-agent messaging and protocols |
| `clawforce_channel` | Channel management, meetings |
| `clawforce_compact` | Session compaction and knowledge preservation |
| `clawforce_setup` | Project onboarding, config validation |
| `clawforce_context` | Context assembly and refresh |
| `memory_search` | RAG semantic search (OpenClaw) |
| `memory_get` | Retrieve memory by ID (OpenClaw) |

## Requirements

- Node 22+ (for `node:sqlite`)
- [OpenClaw](https://github.com/openclaw/openclaw) runtime

## License

MIT
