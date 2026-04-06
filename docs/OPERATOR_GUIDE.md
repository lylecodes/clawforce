# ClawForce Operator Guide

A practical reference for humans operating ClawForce through the dashboard.

---

## What is ClawForce?

ClawForce is a governance layer for autonomous AI agent teams. It enforces budgets, manages task lifecycles, routes approvals, tracks trust, and gives operators visibility into what every agent is doing and spending — without requiring agents to know ClawForce exists.

The dashboard is the primary operator interface. It surfaces live state from the ClawForce SQLite database and lets you take action without touching the CLI or config files.

---

## Accessing the Dashboard

### Embedded mode (default)

When ClawForce runs as an OpenClaw plugin, the dashboard is served at:

```
http://localhost:<openclaw-port>/clawforce/
```

OpenClaw handles authentication. If you can access OpenClaw, you can access the dashboard. No additional configuration needed.

### Standalone mode

When running the dashboard server independently:

```typescript
import { serveDashboard } from "clawforce/dashboard";
const cf = Clawforce.init({ domain: "my-team" });
serveDashboard(cf, { port: 3117 });
```

The dashboard is then at `http://localhost:3117/clawforce/`. Set `CLAWFORCE_DASHBOARD_TOKEN` to require bearer token authentication. Without a token, the server accepts connections from localhost only and refuses remote connections.

---

## Dashboard Overview

The dashboard has multiple views. A tab selector (gear icon) lets you customize which views appear.

| View | What it shows |
|------|---------------|
| **Monitor** | Single-page widget dashboard: org tree, budget usage, pipeline state, recent activity, performance metrics, alerts, health tiers |
| **Overview** | High-level domain summary with agent counts, task states, and cost summary |
| **Tasks** | Kanban board — task list by state, filterable by agent, priority, or department. Supports state transitions via drag-drop. |
| **Approvals** | Risk-based approval queue — view pending proposals, approve or reject with feedback |
| **Ops** | Operational controls — disable/enable agents and domains, intervention history |
| **Org** | Full agent hierarchy with runtime status |
| **Workspace** | Work stream view and worker assignments |
| **Comms** | Agent messaging — inbox, threads, send messages to agents |
| **Config** | Domain config editor (structured and raw), context file editor, memory settings |
| **Extensions** | Extension-contributed pages (if any extensions are registered) |

---

## Managing Domains

A domain is an isolated workspace: one database, one team, one budget.

### Switching domains

The domain selector at the top of the dashboard switches between domains. All views update to show data for the selected domain.

### Creating a domain

Via CLI:

```bash
cf config set domain my-team
```

Or use the domain creation wizard in the Config view.

### Domain status

The Monitor view shows domain health status. A domain can be in one of these states:

- **Active** — agents are dispatched normally
- **Disabled** — new dispatches are blocked (existing sessions may finish)
- **Emergency stop** — all agent tool calls are blocked immediately

---

## Agent Configuration

### Viewing agent config

The Config view shows all agents in the domain and their current configuration. Select an agent to see:

- Role and preset (`manager`, `employee`, `assistant`)
- Persona (system prompt prefix)
- Briefing sources — what context the agent sees at session start
- Expectations — what outputs are expected
- Performance policy — what happens when expectations aren't met
- Coordination schedule (for manager-role agents)
- Budget limits

### Editing agent config

The Config view has a structured editor and a raw YAML editor. The structured editor covers the most common fields. For advanced config (tool gates, custom presets), use the raw editor.

Context files (DIRECTION, STANDARDS, POLICIES, ARCHITECTURE) are edited separately in the context file section. Ownership rules apply:

| File | Who can edit |
|------|-------------|
| ARCHITECTURE | Any agent |
| STANDARDS | Manager-level agents |
| DIRECTION | Human operators only |
| POLICIES | Human operators only |

### Config versions

The Config view maintains a version history. You can view previous versions but not currently revert through the dashboard — use the CLI for rollback.

---

## Budget Management

### Viewing budget

The Monitor view has a budget widget showing:

- Daily spend (cents and tokens)
- Hourly burn rate
- Remaining budget
- Projected daily total

The Budget panel in the Config view shows the full three-dimension budget (hourly, daily, monthly) across cents, tokens, and requests.

### Adjusting budget limits

In the Config view, edit the budget section:

```yaml
budget:
  daily: { cents: 5000, tokens: 3_000_000 }
  hourly: { cents: 1000 }
```

Per-agent limits are in the `budgets.agents` section.

Via CLI:

```bash
cf config set budget.project.daily.cents 5000 --domain=my-team
```

Changes take effect on the next dispatch check.

---

## Task Operations

### Viewing tasks

The Tasks view shows a kanban board with all active tasks. Task states:

| State | Meaning |
|-------|---------|
| OPEN | Created, not yet assigned |
| ASSIGNED | Assigned to an agent, not yet started |
| IN_PROGRESS | Agent is actively working |
| REVIEW | Awaiting human or manager review |
| BLOCKED | Blocked on a dependency or approval |
| DONE | Completed successfully |
| FAILED | Failed after exhausting retries |
| CANCELLED | Cancelled by operator or system |

### Filtering tasks

Filter by state, assignee, priority, department, or team using the filter controls above the board.

### Task actions

Click a task to see its detail view. From there you can:

- Transition the state (e.g., move from REVIEW to DONE or back to IN_PROGRESS)
- Reassign to a different agent
- Add evidence (notes, links, artifacts)
- View the full audit trail

### Creating a task

Tasks are typically created by agents. Operators can create tasks via CLI:

```bash
cf tasks create --title="Fix auth bug" --assignee=worker-1 --domain=my-team
```

Dashboard task creation is not currently surfaced in the UI.

---

## Approvals

### What triggers approvals

Approvals are risk-based. Agents that attempt high-risk actions (as classified by the risk tier config) must submit a proposal before proceeding. The proposal sits in the approval queue until a human approves or rejects it.

### Viewing pending approvals

The Approvals view shows all pending proposals. Each proposal includes:

- Which agent submitted it
- What action they want to take
- Risk classification
- Supporting context

### Approving or rejecting

Click a proposal to open its detail view. Use the **Approve** or **Reject** buttons. Rejection requires a feedback reason, which is delivered back to the agent.

Via CLI:

```bash
cf approve <proposal-id> --domain=my-team
cf reject <proposal-id> --feedback="Scope too broad" --domain=my-team
```

---

## Communication

### Messaging agents

The Comms view shows agent messages, threads, and your inbox. You can send a message to any agent from the message composer. Messages are delivered to the agent in their next briefing.

You can also address messages using the dashboard assistant: type `@agent-id message content` in the assistant input field to send to a specific agent.

### Dashboard assistant

The dashboard assistant (`/clawforce/api/:domain/agents/clawforce-assistant/message`) routes messages to the domain lead or a configured target. If a live session is available, the message is injected directly. If not, it's stored for delivery at next briefing.

### Via CLI

```bash
cf message lead "Prioritize the auth feature" --domain=my-team
```

---

## Monitoring

### Monitor view

The Monitor view is a single-page dashboard showing:

- **Org tree** — agent hierarchy with status indicators
- **Budget** — spend vs limits
- **Pipeline** — task count by state
- **Activity** — recent events and session starts
- **Performance** — per-agent efficiency metrics (throughput, cycle time, failure rate)
- **Alerts** — active anomaly detection alerts
- **Health** — domain health tier

### Health tiers

ClawForce assigns a health tier to each domain based on error rates, budget pacing, and SLO compliance:

| Tier | Meaning |
|------|---------|
| Green | All systems nominal |
| Yellow | Elevated error rate or approaching budget limits |
| Red | SLO breaches, budget exhausted, or emergency stop active |

### SLOs

The SLO panel shows configured service level objectives and current compliance. SLOs are defined in domain config and tracked automatically.

### Alerts

Anomaly detection runs continuously. Alerts appear in the Monitor view when:

- Burn rate spikes above normal
- Error rate exceeds threshold
- An agent stops responding to briefings
- A task has been stuck in a state too long

---

## Emergency Controls

### Kill switch (emergency stop)

Blocks all tool calls from all managed agents. Agents can still think but cannot act.

Via dashboard: Ops view → Emergency Stop → confirm reason.

Via CLI:

```bash
cf kill --reason="Runaway costs" --domain=my-team
```

Resume:

```bash
cf kill --resume --domain=my-team
```

### Disable/enable domain

Softer than kill switch. Blocks new dispatches but lets current sessions finish.

Via dashboard: Ops view → Disable Domain.

Via CLI:

```bash
cf disable --reason="Deploying" --domain=my-team
cf enable --domain=my-team
```

### Disable/enable individual agents

Target a specific agent without affecting the rest of the domain.

Via dashboard: Org view → select agent → Disable.

Via CLI:

```bash
cf disable --agent=worker-1 --domain=my-team
cf enable --agent=worker-1 --domain=my-team
```

### Kill a stuck agent

If an agent session is stuck, you can terminate it:

Via dashboard: Org view → select agent → Kill Session.

Via CLI:

```bash
cf kill --agent=worker-1 --domain=my-team
```

---

## Config Editing

### Structured editor

The Config view provides a structured editor for common configuration sections:

- Agent definitions (persona, title, briefing, coordination)
- Budget limits
- Dispatch settings
- Performance policy
- Approval policy

### Raw editor

The raw YAML editor lets you edit the full domain config directly. Useful for fields not exposed in the structured editor. Changes are validated before save.

### Context files

Context files are team-level documents that agents read at session start. They live in `~/.clawforce/domains/<name>/context/`. Edit them in the Config view under the Context Files tab.

Context file types:

| File | Purpose |
|------|---------|
| DIRECTION | Strategic priorities and current focus |
| STANDARDS | Coding and process standards |
| POLICIES | Rules and constraints |
| ARCHITECTURE | System design and technical context |

### Config versions

Every config save creates a version entry. View version history in the Config view. The CLI supports diffing versions:

```bash
cf config versions --domain=my-team
```

---

## CLI Quick Reference

Full reference: `docs/CLI.md`

```bash
cf status --domain=my-team          # System vitals
cf dashboard --domain=my-team       # Full overview
cf watch --domain=my-team           # Only what changed
cf org --domain=my-team             # Org tree
cf health --domain=my-team          # Health check
cf tasks --domain=my-team           # Task list
cf costs --domain=my-team           # Cost breakdown
cf budget --domain=my-team          # Budget pacing
cf proposals --domain=my-team       # Pending approvals
```
