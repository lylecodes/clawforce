# Integration Guide

How to use ClawForce -- standalone, with OpenClaw, or through the SDK.

## Architecture Overview

ClawForce is a governance library. It manages task lifecycle, budget enforcement, trust scoring, dispatch coordination, and event routing. It stores everything in SQLite (no external infrastructure).

There are three ways to use it:

```
1. SDK (Clawforce class)      -- highest-level, domain-scoped API
2. Core library (src/index)   -- full export surface, framework-agnostic
3. OpenClaw adapter           -- plugin that wires ClawForce into OpenClaw's lifecycle
```

## Standalone Usage (No OpenClaw)

Install and import directly:

```bash
npm install clawforce
```

```typescript
import { Clawforce } from "clawforce";

const cf = Clawforce.init({ domain: "my-agents" });

// Create and track tasks
const task = cf.tasks.create({
  title: "Analyze dataset",
  assignedTo: "analyst",
  group: "research",
});

// Record costs
cf.budget.set({ daily: { cents: 1000, tokens: 5_000_000 } });
cf.budget.recordCost({ agentId: "analyst", inputTokens: 500, outputTokens: 2000 });

// React to events
cf.events.on("task_completed", (e) => {
  cf.trust.record({ agentId: "analyst", category: "quality", decision: "approved" });
});

// Block risky actions
cf.hooks.beforeDispatch((ctx) => {
  const budget = cf.budget.check(ctx.agentId);
  if (!budget.ok) return { block: true, reason: budget.reason };
});
```

Requires Node 22+ for `node:sqlite`. No Docker, Redis, or Postgres.

## SDK API Overview

The SDK is organized into 17 lazy-loaded namespaces, all scoped to a single domain:

| Namespace | Purpose |
|---|---|
| `cf.tasks` | Create, transition, list, attach evidence |
| `cf.events` | Emit events, subscribe with `on()`/`off()`, query history |
| `cf.budget` | Set limits, check spend, record costs |
| `cf.dispatch` | Enqueue tasks, claim queue items, complete/fail |
| `cf.hooks` | Register interceptors (beforeDispatch, beforeTransition, etc) |
| `cf.agents` | List agents, check capabilities, query hierarchy |
| `cf.trust` | Record decisions, compute scores, get tier |
| `cf.approvals` | List pending proposals, approve/reject |
| `cf.goals` | Create/achieve goals, link tasks, track progress |
| `cf.messages` | Agent-to-agent messaging |
| `cf.knowledge` | Store/search shared memory entries |
| `cf.monitoring` | Health checks, SLO evaluation |
| `cf.config` | Load domain config, inspect presets |
| `cf.triggers` | External trigger definitions |
| `cf.telemetry` | Session archives, tool call capture |
| `cf.experiments` | A/B testing, canary deployments |
| `cf.db` | Raw SQL escape hatch |

### SDK Vocabulary Mapping

The SDK uses abstract vocabulary so it works for any team metaphor:

| SDK term | Internal term |
|---|---|
| group | department |
| subgroup | team |
| role | extends (preset) |
| coordinator | manager |

## OpenClaw Integration

The `adapters/openclaw.ts` file is an OpenClaw plugin that translates OpenClaw lifecycle events into ClawForce calls. It handles:

- **Session tracking** -- `startTracking()` on session start, `endSession()` on completion
- **Context assembly** -- builds briefing context from configured sources (task board, budget, policies, etc)
- **Tool gating** -- intercepts tool calls through the policy middleware
- **Compliance checking** -- validates agents met their expectations at session end
- **Dispatch injection** -- spawns agent sessions via OpenClaw's cron service
- **Cost capture** -- records token usage and maps it to tasks/agents
- **Agent sync** -- registers ClawForce agent configs with OpenClaw's agent system
- **Dashboard** -- serves the web UI through OpenClaw's HTTP routes
- **Memory** -- ghost recall, flush tracking, memory governance

### How It Sits On Top of OpenClaw

```
OpenClaw (gateway)
  |-- Agent sessions, cron jobs, messaging
  |-- Plugin system
        |
        +-- ClawForce plugin (adapters/openclaw.ts)
              |-- Hooks into: onSessionStart, onSessionEnd, onToolCall, onLlmOutput
              |-- Provides: tools, context, bootstrap files
              |-- Uses: OpenClaw's cron service for dispatch
              |-- Serves: dashboard via gateway HTTP routes
```

ClawForce does not modify OpenClaw's code or config schema. It uses OpenClaw as a library/runtime and adds governance on top.

### Key OpenClaw Integration Points

1. **Bootstrap hook** -- injects ClawForce context (task board, budget status, policies) into agent sessions at startup
2. **Tool interception** -- the `onToolCall` hook runs policy checks before tool execution, can block or require approval
3. **Session end** -- captures compliance results, transitions task states, handles continuous job re-dispatch
4. **Cron service** -- ClawForce dispatches agents by creating one-shot cron jobs via OpenClaw's scheduler

## Tool Gating

ClawForce can intercept and gate tool calls through the policy middleware:

```
Agent calls tool -> Policy middleware checks:
  1. Is the tool in the allowed list for this agent's role?
  2. Does the action require approval (risk tier)?
  3. Is there a pre-approval for this task+tool combo?
  4. Is the agent's trust score high enough?
     -> If blocked: create a proposal, pause the task
     -> If allowed: proceed with the call
```

When a tool call is blocked, ClawForce:
1. Creates an approval proposal with the action details
2. Persists a `ToolCallIntent` linking the proposal to the task
3. When approved, adds a pre-approval and re-enqueues the task
4. On re-dispatch, the agent can proceed past the gate

## Config Setup

### Standalone (SDK only)

```typescript
const cf = Clawforce.init({
  domain: "my-project",
  dbPath: "./data/my-project.sqlite",  // optional, defaults to ~/.openclaw/<domain>/
});
```

### With OpenClaw

ClawForce reads from the standard config hierarchy:

```
~/.clawforce/
  config.yaml          # global config (agents, defaults)
  domains/
    my-domain.yaml     # per-domain config (budget, dispatch, event_handlers)
```

Key config sections in `domain.yaml`: `budget`, `dispatch`, `assignment`, `event_handlers`, `safety`, `review`, `sweep`. All config is manageable via CLI:

```bash
pnpm cf config set dispatch.maxConcurrentDispatches 5
pnpm cf config set budget.daily_limit '$100'
pnpm cf config show
```

## Core Library Exports

For lower-level access, `src/index.ts` exports 200+ functions covering tasks, events, budget, dispatch, safety, config, trust, goals, channels, messaging, verification, and experiments.
