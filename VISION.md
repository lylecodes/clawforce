# ClawForce Vision

> **Set the direction. Set the budget. Your AI team handles the rest.**

## What ClawForce Is

Infrastructure for self-scaling agentic engineering. Agent teams that measure, adapt, scale, and improve themselves.

ClawForce is the platform that makes autonomous agent teams actually work. Not an orchestrator. Not a safety tool. The infrastructure layer that agent teams build on — like an operating system for AI workforces.

## The Product

### For the agents
ClawForce is the environment that makes agents effective. Agents get:
- **Visibility** — trust scores, task history, cost data, performance metrics. Data-driven decisions, not guesses.
- **Structured context** — DIRECTION.md, POLICIES.md, STANDARDS.md. Agents know what to work on, what's allowed, and how to operate.
- **Tools to act** — create tasks, assign work, review output, reallocate budget. Managers manage. Employees execute.
- **Audit trail** — every action tracked, every decision logged, every outcome measured.

### For the human
The human sets direction and budget. ClawForce handles the rest. The dashboard is a window into the system, not a control panel.

Human responsibilities:
- Write DIRECTION.md (what to build, priorities, measurable targets)
- Set budget
- Approve high-stakes decisions (money, going live)
- Watch the team work through the dashboard

Everything else is the agents.

### For optimization
The same infrastructure that governs agents also enables systematic optimization:
- **Telemetry** — every session archived, every tool call captured, every config version tracked
- **Experiments** — A/B test any config change. Compare SOUL.md variants, model selection, policy strictness.
- **Canary deployments** — roll out config changes to 10% of sessions, auto-rollback if metrics degrade
- **Data-driven evolution** — agents improve their own context based on performance data

## The Paradigm

ClawForce ships with opinionated defaults — the "paradigm" — that define how teams operate. Everything is configurable, but the defaults work out of the box.

### Manager creates work with explicit expectations
Tasks include acceptance criteria and output format. The manager knows what "done" looks like because the manager defined it.

### Employees just work
Zero governance tools. They get a task, they do the work, they show the output. ClawForce handles transitions, evidence capture, and logging automatically.

### Manager verifies
The manager is the quality gate. Reviews evidence, approves or rejects with specific feedback, creates follow-up tasks. No automated approval — the manager decides.

### Configuration is the user's responsibility
ClawForce provides smart defaults and guides. But the quality of the output reflects the quality of the setup. Bad DIRECTION.md = unfocused agents. Bad POLICIES.md = agents doing things they shouldn't.

## Architecture

```
Human → DIRECTION.md + Budget
  ↓
ClawForce (auto-lifecycle, telemetry, experiments)
  ↓
Manager Agent (creates tasks, reviews, adapts)
  ↓
Employee Agents (execute, show work)
  ↓
Dashboard (visibility into everything)
```

### Key Technical Decisions
- **SQLite per project** — zero infrastructure, portable, fast
- **OpenClaw integration** — uses OpenClaw's agent runtime, cron API, channels
- **Auto-lifecycle** — task transitions and evidence capture are structural, not LLM-dependent
- **Content-addressable config** — every session linked to the exact config that produced it via SHA-256
- **Experiment-native** — A/B testing built into the dispatch pipeline, not bolted on

## What ClawForce Is NOT

- **Not a safety tool.** Governance is the implementation detail, not the pitch.
- **Not an orchestrator.** ClawForce doesn't decide what tools to call or what order to run things. Agents decide.
- **Not a framework.** No opinions on how agents think or reason. ClawForce manages the organizational layer.
- **Not OpenClaw-exclusive.** SDK works standalone. OpenClaw integration is the first-class runtime but not the only one.

## Market Position

The AI agent ecosystem has frameworks (LangGraph, CrewAI, AutoGen) and platforms (OpenClaw, Claude Code). Nobody has the infrastructure layer for agent teams that scale themselves.

ClawForce is that layer. The thing between "I have agents" and "I have a team."
