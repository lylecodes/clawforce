# Integration Guide

How to use ClawForce as the governance layer above an execution runtime.

The only runtime stories that should be treated as product-real in setup docs
today are:

- direct Codex/OpenAI execution
- OpenClaw as an optional compatibility bridge
- legacy Claude Code only for compatibility, not as the primary path

## Architecture Overview

ClawForce is a governance library. It manages task lifecycle, budget
enforcement, trust scoring, dispatch coordination, approvals, and event
routing. It stores everything in SQLite (no external infrastructure).

ClawForce does not aim to replace a strong agent runtime. It is the control
plane that sits above one.

There are three practical integration stories today:

1. Direct Codex executor: default runtime path and canonical start-here story.
2. SDK (`Clawforce` class): highest-level, domain-scoped governance API.
3. OpenClaw adapter: optional compatibility bridge into OpenClaw's lifecycle.

Conceptually:

```text
Agent runtime/framework -> executes work
ClawForce              -> governs work
Dashboard/CLI          -> operates work
```

Broader runtime interoperability is still part of the thesis, but it should be
explained in positioning docs rather than treated as fully supported setup
surface today.

## Agent Modeling Contract

ClawForce and an execution runtime can both talk about the same logical agent,
but they should not own the same parts of that agent.

ClawForce should own the governed worker identity:

- stable agent ID
- role, title, persona, and reporting chain
- department/team placement
- briefing and expectations
- budgets, trust, approval policy, and compliance posture
- assignment and coordination metadata

The runtime should own the executable worker profile:

- model/provider selection
- concrete tool wiring
- sandbox and workspace configuration
- memory backend and compaction mechanics
- session loop, multimodal, and service deployment settings

In other words: ClawForce models the organization around the worker; the runtime
models how the worker actually runs.

### Shared IDs, Not Duplicated Truth

The clean integration shape is:

1. ClawForce stores the governed worker record.
2. The runtime stores the executable worker record.
3. An adapter binds them through a stable ID or runtime reference.

ClawForce can still send governance-level overrides into execution, such as:

- run this task on a more expensive model
- deny this tool category without approval
- restrict this run to a budget or risk tier

But it should not need to restate the runtime's full native agent definition to
do that.

### Current Transition State

Today the boundary is not fully clean yet:

- direct Codex execution keeps some execution settings close to ClawForce
- the OpenClaw sync path still projects some runtime-shaped fields

That is implementation debt, not the target architecture. New integrations
should move toward binding to external runtime agents rather than duplicating
their full config inside ClawForce.

## Integration Modes

ClawForce should be explicit about three ways it can sit next to a runtime.

### Overlay Mode

Recommended for users who already have agents and context systems in another
runtime.

- the runtime remains canonical for prompt, tools, model, workspace, bootstrap,
  and memory
- ClawForce injects governance context at run time
- ClawForce records and enforces task lifecycle, budgets, approvals, trust, and
  audit
- agent sync or config projection should be optional, not assumed

This is the right default for existing OpenClaw users and the default story for
bring-your-own-runtime adoption in general.

In the current OpenClaw integration, the practical way to do this is:

- set the plugin `integrationMode` to `overlay`
- disable sync/projection if you do not want ClawForce mutating `agents.list[]`
- set `runtimeRef` on any ClawForce agent whose OpenClaw agent ID differs from
  the ClawForce agent ID

Example:

```yaml
# config.yaml
agents:
  lead:
    extends: manager
    runtimeRef: existing-openclaw-lead
    runtime:
      allowedTools: [Read, Edit, Write]
  worker:
    extends: employee
    runtimeRef: existing-openclaw-worker
    runtime:
      workspacePaths: [packages/app]
```

```json
{
  "plugins": {
    "entries": {
      "clawforce": {
        "enabled": true,
        "config": {
          "integrationMode": "overlay",
          "syncAgents": false
        }
      }
    }
  }
}
```

### Hybrid Mode

Recommended only when users intentionally want shared ownership.

- the runtime owns execution primitives
- ClawForce owns more of the governed identity and briefing layer
- some execution settings may still be mirrored or overridden by policy

This is useful for migration or for tightly integrated first-party setups, but
it should be a named mode with a documented boundary.

For backward compatibility, the current OpenClaw plugin default is still
`hybrid`.

### ClawForce-Owned Mode

Recommended for direct Codex execution and similar first-party flows.

- ClawForce owns governance
- ClawForce also carries the minimal execution profile needed to dispatch work
- no separate external runtime registry is required

This is the most integrated path, but it should not be the mental model forced
on users who already run their agents elsewhere.

## Direct Usage (No OpenClaw Required)

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

Requires Node 22.22+ plus an authenticated Codex CLI if you want ClawForce to
dispatch work directly. ClawForce development is pinned to `.nvmrc`
(`25.6.1`), and the repo package scripts enforce that runtime so native SQLite
bindings do not drift across shells.

Uses SQLite via `better-sqlite3`. No Docker, Redis, or Postgres.

This should be read as "lightweight control plane," not "full runtime stack."

If you are choosing a path for a new domain, stop here and start with this
direct story. Only move on to OpenClaw if you already need its surrounding
runtime features.

## SDK API Overview

The SDK is organized into 16 lazy-loaded namespaces, all scoped to a single domain:

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

The `adapters/openclaw.ts` file is an optional OpenClaw compatibility bridge
that translates OpenClaw lifecycle events into ClawForce calls. It handles:

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

ClawForce does not modify OpenClaw's code or config schema. It uses OpenClaw
as an optional runtime layer and adds governance on top. New domains should
default to direct Codex/OpenAI execution unless they explicitly need
OpenClaw's surrounding runtime features.

Strategically, this is the intended pattern for other runtimes too: ClawForce
should compose with them rather than replace them.

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
  dbPath: "./data/my-project.sqlite",  // optional, defaults to ~/.clawforce/data/<domain>.db
});
```

### With OpenClaw

Prefer this only when you already run OpenClaw or explicitly need its gateway,
plugin, or channel surfaces. When you do use it, prefer `overlay` mode first.

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

For lower-level but still intentional contracts, `clawforce/advanced` exports:
- canonical config document / patch APIs
- dashboard extension registration contracts
- runtime port types
- session key parsing helpers

For lower-level access, `clawforce/internal` maps to `src/internal.ts` and exports the broad low-level surface covering tasks, events, budget, dispatch, safety, config, trust, goals, channels, messaging, verification, and dashboard/runtime helpers. It is intentionally less stable than the SDK entry.
