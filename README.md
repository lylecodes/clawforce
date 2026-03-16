# ClawForce

**Governance SDK for autonomous agents.** Budget enforcement, trust scoring, task orchestration, approval flows, and event-driven coordination — in one `npm install`. Zero infrastructure. Framework-agnostic.

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

ClawForce is the governance layer that sits under any agent framework. It manages the organizational concerns so you can focus on the interesting problems.

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

Requires Node 22+ (for `node:sqlite`). No Docker. No Redis. No Postgres. Just import and go.

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

## Use Cases

ClawForce uses abstract vocabulary — groups, roles, capabilities — not corporate jargon. It works for any multi-agent system.

### AI Workforce (Content Team)

```yaml
agents:
  editor:
    role: coordinator
    title: Content Editor
    group: content
  writer:
    role: worker
    title: Content Writer
    group: content
    reportsTo: editor

budget:
  daily: { cents: 5000, tokens: 3_000_000 }
```

### Game NPCs (Sims-Style Town)

```typescript
const cf = Clawforce.init({ domain: "neighborhood-1" });

for (const npc of gameConfig.npcs) {
  cf.tasks.create({ title: npc.currentGoal, assignedTo: npc.id, group: npc.household });
}

// Game loop
cf.events.on("task_completed", (e) => {
  gameEngine.updateNPC(e.payload.agentId);
  cf.trust.record({ agentId: e.payload.agentId, category: "reliability", decision: "approved" });
});

cf.hooks.beforeDispatch((ctx) => {
  if (gameState.isSleeping(ctx.agentId)) return { block: true, reason: "NPC is sleeping" };
});
```

### Research Swarm

```typescript
const cf = Clawforce.init({ domain: "experiment-42" });

// Budget controls GPU/API spend
cf.budget.set({ daily: { cents: 50_000 } }); // $500/day cap

// Track experiment quality
cf.events.on("result_validated", (e) => {
  cf.trust.record({ agentId: e.payload.agentId, category: "accuracy", decision: "approved" });
});

// Require human approval for expensive operations
cf.hooks.beforeDispatch((ctx) => {
  const cost = estimateCost(ctx.taskId);
  if (cost > 5000) return { block: true, reason: "Expensive task — needs human approval" };
});
```

## Architecture

ClawForce is an **SDK**, not a server. It runs in-process with your application, backed by SQLite. No network calls, no infrastructure, no latency.

```
Your Application
├── Agent Framework (LangGraph, CrewAI, custom, etc.)
├── ClawForce SDK (governance layer)
│   ├── Tasks, Events, Budget, Trust, Dispatch
│   ├── Approvals, Knowledge, Goals, Messages
│   ├── Monitoring, Config, Hooks, DB
│   └── SQLite (zero-config persistence)
└── Optional: ClawForce Dashboard (plugin)
```

The dashboard is an optional plugin for visual monitoring:

```typescript
import { Clawforce } from "clawforce";
import { serveDashboard } from "clawforce/dashboard";

const cf = Clawforce.init({ domain: "my-project" });
serveDashboard(cf, { port: 5173 });
```

## Capability System

Agents have capabilities, not job titles. Built-in presets provide sensible defaults:

| Preset | Capabilities | Use Case |
|--------|-------------|----------|
| `coordinator` | coordinate, create_tasks, run_meetings, review_work, escalate | Team lead, manager, orchestrator |
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

ClawForce works standalone as an SDK, but also integrates deeply with [OpenClaw](https://github.com/openclaw/openclaw) as a plugin for full agent runtime:

```typescript
import { serveDashboard } from "clawforce/dashboard";
```

When used with OpenClaw: automatic cost capture from LLM calls, cron-based coordination, channel delivery (Telegram/Slack/Discord), memory RAG integration, and session-level compliance tracking.

## License

MIT
