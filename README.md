# ClawForce

**Governance and control plane for agent teams: budgets, approvals, trust, audit, and operator control above any runtime.** One `npm install`. Zero infrastructure.

```typescript
import { Clawforce } from "clawforce";

const cf = Clawforce.init({ domain: "my-agents" });

// Enforce budgets
cf.budget.set({ daily: { tokens: 1_000_000, cents: 500 } });

// Orchestrate work
const task = cf.tasks.create({ title: "Research competitors", assignedTo: "analyst" });

// React to events in real-time
cf.events.on("task_completed", (e) => {
  cf.trust.record({ agentId: e.payload.agentId, category: "quality", decision: "approved" });
});

// Block actions that shouldn't happen
cf.hooks.beforeDispatch((ctx) => {
  const budget = cf.budget.check(ctx.agentId);
  if (!budget.ok) return { block: true, reason: budget.reason };
});
```

## Why ClawForce

Everyone is building agent frameworks. Nobody is building agent governance.

LangGraph, CrewAI, AutoGen — they answer "how do I make agents think and act?" None of them answer: how do I stop 50 agents from blowing my budget? How do I know which agent to trust? Who approves risky actions? Where's the audit trail?

ClawForce is the governance layer that sits above agent execution. It manages the organizational concerns so you can focus on the interesting problems.

The first thing a skeptical operator should understand is simple: ClawForce can block unsafe or over-budget work before it runs. That budget gate is the fastest proof that this is governance, not just another orchestration wrapper.

## Positioning

ClawForce is not trying to be the best general-purpose agent SDK.

It is trying to be the best system for governing agent organizations:

- budgets and pacing
- approvals and risk gates
- task state and review semantics
- trust and earned autonomy
- operator visibility, intervention, and audit

Agent frameworks and runtimes should own agent execution. ClawForce should own
the control plane above them.

ClawForce should model the governed worker identity: role, reporting chain,
budgets, trust, approvals, and work state. Integrated runtimes should model the
executable worker profile: model, tools, sandbox, memory mechanics, and service
settings.

That means ClawForce should compose with systems like AgentScope, Qwen-Agent,
Spring AI Alibaba, OpenClaw, and similar runtimes rather than trying to become
another general-purpose execution framework itself.

Concrete runtime support today is narrower than the long-term thesis:

- direct `codex` execution is the default path
- OpenClaw is an optional compatibility bridge
- legacy `claude-code` compatibility remains available

Adoption should follow three modes:

- `overlay`: existing runtime stays canonical; ClawForce adds governance
- `hybrid`: shared ownership during migration or deeper integration
- `clawforce-owned`: direct Codex-style execution with the tightest integration

For teams already running OpenClaw or another runtime, `overlay` should be the
default story. The current OpenClaw plugin still defaults to `hybrid` for
backward compatibility, but `overlay` is the recommended target.

When runtime agent IDs differ from ClawForce agent IDs, bind them with
`runtimeRef` instead of duplicating the full runtime agent definition.

The canonical product stance lives in [docs/POSITIONING.md](docs/POSITIONING.md).

| | ClawForce | CrewAI | LangGraph | AutoGen |
|---|---|---|---|---|
| Budget enforcement (hard gates) | 3 dimensions, 3 windows | No | No | No |
| Trust / earned autonomy | Track record based | No | No | No |
| Human-in-the-loop approvals | Built-in | No | No | No |
| Task orchestration | Full state machine | Basic | Patterns | No |
| Event subscriptions | In-process, real-time | No | No | No |
| Lifecycle hooks (interceptors) | Block/modify before action | No | No | No |
| Audit trail | Every action logged | No | No | No |
| Infrastructure required | None (SQLite, in-process) | Redis | Postgres | Redis |

## Install

```bash
npm install clawforce
```

Requires Node 22.22+.

For ClawForce development, use the repo-pinned runtime from `.nvmrc` (`25.6.1`). The package scripts (`pnpm build`, `pnpm test`, `pnpm typecheck`) enforce that runtime automatically so native SQLite bindings stay consistent even if your shell is on a different Node line.

If your shell and the repo runtime drift apart, run `pnpm runtime:doctor`.

Uses SQLite via `better-sqlite3`. No Docker. No Redis. No Postgres. Just import and go.

## Start Here

The canonical start path is:

1. run ClawForce with direct `codex` execution
2. keep new domains in `dry_run`
3. use the dashboard as the primary operator surface and Codex as the conversational surface
4. move the domain to `live` only when the control plane is boring and trustworthy

If you already run agents in OpenClaw, use ClawForce in `overlay` mode and treat `hybrid` as a migration state, not the destination.

## Execution Model

ClawForce is **Codex/OpenAI-first today**, while remaining architecturally
oriented toward a broader governance role above runtimes.

- If you do not configure an adapter or `dispatch.executor`, ClawForce dispatches through the direct `codex` executor.
- OpenClaw remains available as an optional compatibility bridge and transport layer.
- The legacy `claude-code` path remains in the codebase for compatibility, but it is not the recommended setup for new domains.

### Package Tiers

- `clawforce`
  Stable SDK surface for most builders.
- `clawforce/advanced`
  Supported lower-level contracts for extension and integration work.
- `clawforce/internal`
  Broad unstable surface used by ClawForce itself and tightly-coupled tooling.

## The SDK

14 namespaces covering everything you need to govern autonomous agents:

### Core Operations

```typescript
// Tasks — create, assign, track, complete
const task = cf.tasks.create({ title: "Write report", assignedTo: "writer", group: "content" });
cf.tasks.transition(task.id, "IN_PROGRESS", { actor: "writer" });
cf.tasks.transition(task.id, "DONE", { actor: "writer" });

// Events — emit, query, subscribe
cf.events.emit("custom_event", { whatever: "data" });
cf.events.on("task_completed", handler);
cf.events.on("*", (e) => console.log(e.type)); // wildcard

// Budget — enforce spending limits
cf.budget.set({ daily: { cents: 1000, tokens: 5_000_000 } });
cf.budget.check("agent-1"); // { ok: true, remaining: { cents: 800 } }
cf.budget.recordCost({ agentId: "agent-1", inputTokens: 1000, outputTokens: 5000 });

// Dispatch — trigger agent execution
cf.dispatch.enqueue(task.id, { agentId: "writer" });
const item = cf.dispatch.claimNext();
cf.dispatch.complete(item.id);
```

### Governance

```typescript
// Trust — track agent reliability
cf.trust.record({ agentId: "writer", category: "quality", decision: "approved" });
cf.trust.score("writer"); // { overall: 0.95, categories: { quality: 0.97 } }

// Approvals — human-in-the-loop
const pending = cf.approvals.pending();
cf.approvals.resolve(pending[0].id, "approved", "Looks good");

// Hooks — intercept and block actions
cf.hooks.beforeTransition((ctx) => {
  if (ctx.toState === "DONE" && !hasEvidence(ctx.taskId)) {
    return { block: true, reason: "Evidence required before completion" };
  }
});

cf.hooks.onBudgetExceeded((ctx) => {
  notify(`Agent ${ctx.agentId} hit budget limit`);
});
```

### Organization

```typescript
// Agents — identity, capabilities, hierarchy
cf.agents.list({ group: "engineering" });
cf.agents.capabilities("lead"); // ["coordinate", "create_tasks", "review_work"]
cf.agents.hierarchy("dev-1");   // { reportsTo: "lead", directReports: [] }

// Goals — objectives with task linkage
const goal = cf.goals.create({ title: "Ship v2.0", group: "engineering", owner: "lead" });
cf.goals.linkTask(task.id, goal.id);
cf.goals.achieve(goal.id, "lead");

// Messages — agent communication
cf.messages.send({ from: "lead", to: "dev-1", content: "Priority changed on task X" });
cf.messages.pending("dev-1"); // unread messages

// Knowledge — shared memory
cf.knowledge.store({ type: "decision", content: "Using React for frontend", agentId: "lead" });
cf.knowledge.search("React"); // find relevant memories
```

### Operations

```typescript
// Monitoring — health, SLOs, alerts
cf.monitoring.health();  // { tier: "GREEN", sloChecked: 3, sloBreach: 0 }
cf.monitoring.slos();    // [{ name: "completion-rate", actual: 0.92, passed: true }]

// Config — load and inspect
cf.config.load("./workforce.yaml");
cf.config.presets();     // { coordinator: {...}, worker: {...}, ... }

// DB — raw escape hatch for anything else
cf.db.query("SELECT * FROM tasks WHERE state = 'BLOCKED'");
cf.db.tables(); // list all tables
```

## Canonical Use Cases

ClawForce uses abstract vocabulary, but the docs should anchor around two concrete stories first.

### Governed Coding Team

```yaml
agents:
  lead:
    role: coordinator
    title: Engineering Lead
    group: engineering
  developer:
    role: worker
    title: Developer
    group: engineering
    reportsTo: lead

budget:
  daily: { cents: 5000, tokens: 3_000_000 }
```

Use this when you want coding agents that can plan, execute, review, and escalate work under hard budget and approval controls.

### Onboarding Or Ops Pipeline

```typescript
const cf = Clawforce.init({ domain: "source-onboarding" });

cf.hooks.beforeDispatch((ctx) => {
  if (isMutationRisky(ctx.taskId)) {
    return { block: true, reason: "Approval required before live rollout" };
  }
});
```

Use this when you need governed recurring work, staged rollout from `dry_run` to `live`, and a clear operator audit trail for approvals and exceptions.

## Architecture

ClawForce is an **SDK and control plane**, not a standalone agent runtime. It
runs in-process with your application, backed by SQLite. No network calls, no
infrastructure, no latency.

```
Your Application
├── Agent Runtime / Framework
│   ├── Codex (default today)
│   ├── Optional: OpenClaw bridge
│   └── Future adapters belong to the broader thesis, not the start-here path
├── ClawForce SDK (governance/control plane)
│   ├── Tasks, Events, Budget, Trust, Dispatch
│   ├── Approvals, Knowledge, Goals, Messages
│   ├── Monitoring, Config, Hooks, DB
│   └── SQLite (zero-config persistence)
└── Optional: ClawForce Dashboard (primary operator surface when used)
```

The dashboard is the primary visual operator surface when you want UI control over a domain:

```typescript
import { Clawforce } from "clawforce";
import { serveDashboard } from "clawforce/dashboard";

const cf = Clawforce.init({ domain: "my-project" });
serveDashboard(cf, { port: 5173 });
```

## Framework + Base Dashboard

ClawForce is the product with the durable value. The framework owns the
canonical primitives and contracts: hierarchies, tasks, approvals, budgets,
context, trust, telemetry, and config semantics.

The dashboard should act as the base control plane for the common ClawForce
surfaces that most builders share, not as the source of truth for the system.
Codex remains the primary conversational surface.

Canonical product stance:
[`docs/DASHBOARD_PRODUCT_STANCE.md`](docs/DASHBOARD_PRODUCT_STANCE.md)

Extension architecture:
[`docs/DASHBOARD_EXTENSION_ARCHITECTURE.md`](docs/DASHBOARD_EXTENSION_ARCHITECTURE.md)

That means:

- you can adopt ClawForce without adopting the dashboard
- you can use the base dashboard as the default operator UI
- you can build domain-specific views and workflows on top of the base
  dashboard without forking the framework

The intended boundary is:

- **Framework:** schemas, storage, config, query/action/event contracts
- **Base dashboard:** presentation, operator workflows, default UI
- **Extensions:** domain-specific pages, cards, actions, and config editors

If a dashboard feature needs new data or mutations, the framework contract
should be extended first. The dashboard should consume published ClawForce APIs,
not private file layouts or hidden DB assumptions.

Direction doc:
[`docs/plans/2026-04-04-framework-dashboard-direction.md`](docs/plans/2026-04-04-framework-dashboard-direction.md)

## Capability System

Agents have capabilities, not job titles. Built-in presets provide sensible defaults:

| Preset | Capabilities | Use Case |
|--------|-------------|----------|
| `coordinator` | coordinate, create_tasks, run_meetings, review_work, escalate | Team lead, manager, coordinator |
| `worker` | execute_tasks, report_status | Developer, writer, researcher |
| `assistant` | monitor, report_status | Observer, helper, dashboard bot |

Define custom presets for any use case:

```yaml
presets:
  npc-social:
    capabilities: [execute_tasks, report_status, run_meetings]
  npc-hermit:
    capabilities: [execute_tasks]
```

## Budget Enforcement

Three dimensions (cents, tokens, requests) across three time windows (hourly, daily, monthly). Any dimension can block dispatch.

```yaml
budget:
  daily: { cents: 10000, tokens: 5_000_000 }
  hourly: { cents: 2000 }
  monthly: { cents: 200000 }
```

- **Hard dispatch gates** — agents cannot exceed budget, period
- **Initiative allocation** — "UI improvements gets 40% of daily budget"
- **Pre-flight validation** — "this task costs $45, you have $30" blocks before starting
- **Cost tracking** — per-agent, per-task, per-session granularity
- **Hooks** — custom logic when budget is exceeded

## Task Lifecycle

```
OPEN → ASSIGNED → IN_PROGRESS → REVIEW → DONE
                                    ↓
                               FAILED / BLOCKED / CANCELLED
```

Every transition is recorded. Evidence can be attached. Hooks can intercept transitions. The full history is queryable.

## OpenClaw Integration

ClawForce can also integrate with [OpenClaw](https://github.com/openclaw/openclaw) when you explicitly want its transport, channel, or gateway layer:

```typescript
import { serveDashboard } from "clawforce/dashboard";
```

OpenClaw is an optional compatibility bridge, not the default execution substrate. The recommended path for new setups is direct Codex/OpenAI execution plus ClawForce governance. If you already run OpenClaw, prefer `overlay` mode and treat `hybrid` as a migration state.

## License

MIT
