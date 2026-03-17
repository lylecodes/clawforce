# ClawForce Runner Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ClawForce Runner — an OpenClaw plugin that coordinates multi-agent teams with real LLM calls, governed by ClawForce's 15 validation layers, visualized through the 3D Playground frontend.

**Architecture:** The runner is an OpenClaw plugin. It uses `injectAgentMessage()` to dispatch prompts to agents through OpenClaw's real runtime (real LLM calls, real sessions, real auth). ClawForce SDK hooks (`before_tool_call`, `agent_end`, `llm_output`, etc.) capture governance events. A WebSocket server pushes state to the existing React Three Fiber playground frontend. Scenarios are YAML templates defining agents, goals, budgets, and decision spaces.

**Tech Stack:**
- **Runtime:** OpenClaw plugin API (24 hooks + injectAgentMessage + registerHttpRoute)
- **Governance:** ClawForce SDK (budget, trust, tasks, approvals, dispatch, 15 validation layers)
- **Frontend:** Existing clawforce-playground (React Three Fiber + UI panels)
- **Agent Calls:** Real LLM via OpenClaw (Claude Haiku for speed/cost)
- **State:** SQLite via ClawForce SDK
- **Communication:** WebSocket for real-time frontend updates

**Project:** `/Users/lylejens/workplace/clawforce-runner/`

---

## How It Works

```
OpenClaw Gateway (unmodified, running normally)
  │
  └── ClawForce Runner Plugin (registered on gateway start)
      │
      ├── Scenario Engine
      │   ├── Loads YAML scenario template
      │   ├── Registers workforce config with ClawForce SDK
      │   └── Creates goals, initial tasks, budgets
      │
      ├── Tick Loop (the simulation heartbeat)
      │   ├── For each agent in the scenario:
      │   │   1. Build context prompt (current state, available actions, constraints)
      │   │   2. Call api.injectAgentMessage() → agent runs through OpenClaw
      │   │   3. Wait for agent_end hook → capture what happened
      │   │   4. Update simulation state (positions, speech, status)
      │   │   5. Record protocol check results
      │   │   └── Push state delta to frontend via WebSocket
      │   └── Check end conditions (pyramid complete? max ticks?)
      │
      ├── ClawForce SDK (governance state)
      │   ├── cf.tasks — block placement tasks with state machine
      │   ├── cf.budget — resource allocation and enforcement
      │   ├── cf.trust — quality tracking from inspections
      │   ├── cf.approvals — structural decisions need foreman approval
      │   ├── cf.hooks — beforeTransition, beforeDispatch (layer ordering)
      │   └── cf.messages — inter-agent communication
      │
      ├── Hook Listeners (capture governance events)
      │   ├── before_tool_call → record which tools agents use, block if policy violation
      │   ├── llm_output → capture token usage, cost tracking
      │   ├── agent_end → mark tick complete, record success/failure
      │   ├── before_prompt_build → inject ClawForce context (budget, trust, tasks)
      │   └── message_sending → capture inter-agent messages for visualization
      │
      └── WebSocket Server (via registerHttpRoute)
          ├── Pushes state deltas each tick
          ├── Receives user commands (start, pause, speed, approve, chat)
          └── Frontend at clawforce-playground/ connects here
```

---

## Agent Prompt Strategy

Each tick, each agent gets a prompt injected via `injectAgentMessage()`. The prompt tells the agent:

1. **Who they are**: role, title, current trust score
2. **What's happening**: pyramid progress, current tick, team status
3. **Their constraints**: budget remaining, what they're allowed to do
4. **Available actions**: bounded decision space (role-specific options)
5. **Instruction**: "Pick ONE action and respond with your choice and a brief statement."

The `before_prompt_build` hook injects ClawForce context (task board, budget summary, trust scores, pending messages) into the system prompt. This is the same mechanism the existing ClawForce adapter already uses.

The agent responds through OpenClaw's normal flow — real LLM call, real tool execution if needed. The `agent_end` hook fires when done, signaling the tick is complete for that agent.

---

## File Structure

```
clawforce-runner/
├── package.json
├── tsconfig.json
├── .gitignore
├── openclaw.plugin.json          # OpenClaw plugin manifest
│
├── src/
│   ├── index.ts                  # Plugin entry — register() + activate()
│   ├── plugin.ts                 # OpenClaw plugin definition (hooks, tools, routes)
│   │
│   ├── scenario/
│   │   ├── schema.ts             # Scenario template types
│   │   ├── loader.ts             # YAML → scenario config
│   │   ├── pyramid.yaml          # "Build the Pyramid" scenario
│   │   └── prompts.ts            # Per-role prompt templates
│   │
│   ├── runtime/
│   │   ├── state.ts              # Simulation state types + initial state builder
│   │   ├── tick.ts               # Tick loop orchestrator
│   │   ├── dispatcher.ts         # Dispatches prompts to agents via injectAgentMessage
│   │   ├── decision-space.ts     # Bounded action sets per role
│   │   └── tracker.ts            # Tracks agent run completion via agent_end hook
│   │
│   ├── governance/
│   │   ├── hooks.ts              # ClawForce SDK hook setup (budget, trust, tasks)
│   │   ├── tracer.ts             # Protocol layer tracer (captures 15-layer results)
│   │   └── context.ts            # Builds ClawForce context for before_prompt_build
│   │
│   └── server/
│       ├── ws.ts                 # WebSocket connections via registerHttpRoute
│       └── commands.ts           # Handle user commands (start, pause, approve, chat)
│
├── scenarios/                    # Additional scenario templates
│   └── (future scenarios)
│
└── test/
    ├── scenario-loader.test.ts
    ├── decision-space.test.ts
    └── state.test.ts
```

---

## Chunk 1: Project Setup + Plugin Skeleton

### Task 1.1: Initialize project

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `openclaw.plugin.json`

- [ ] **Step 1: Create project directory**

```bash
mkdir -p ~/workplace/clawforce-runner
cd ~/workplace/clawforce-runner
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "clawforce-runner",
  "version": "0.1.0",
  "type": "module",
  "description": "ClawForce Runner — OpenClaw plugin for coordinated multi-agent teams",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "clawforce": "file:../clawforce",
    "ws": "^8.18.0",
    "yaml": "^2.8.0"
  },
  "devDependencies": {
    "@types/node": "^25.3.2",
    "@types/ws": "^8.5.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  },
  "peerDependencies": {
    "openclaw": ">=2026.3.0"
  }
}
```

Note: `openclaw` is a peer dependency — it provides the plugin API at runtime. We don't import it directly; OpenClaw calls our plugin's `register()` with the API object.

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 4: Create OpenClaw plugin manifest**

`openclaw.plugin.json`:
```json
{
  "id": "clawforce-runner",
  "name": "ClawForce Runner",
  "description": "Coordinated multi-agent teams with 15 validation layers",
  "version": "0.1.0",
  "configSchema": {
    "type": "object",
    "properties": {
      "scenarioDir": {
        "type": "string",
        "description": "Path to scenario YAML files"
      },
      "playgroundPort": {
        "type": "number",
        "description": "WebSocket port for playground frontend",
        "default": 3200
      },
      "defaultScenario": {
        "type": "string",
        "description": "Scenario to load on startup",
        "default": "pyramid"
      }
    }
  }
}
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
*.tsbuildinfo
```

- [ ] **Step 6: Init git, install deps, commit**

```bash
git init
npm install
git add -A
git commit -m "feat: project scaffolding + openclaw plugin manifest"
```

---

### Task 1.2: Plugin entry point

**Files:**
- Create: `src/index.ts`, `src/plugin.ts`

- [ ] **Step 1: Create plugin entry point**

`src/index.ts`:
```typescript
import { createClawforceRunnerPlugin } from "./plugin.js";
export default createClawforceRunnerPlugin;
```

- [ ] **Step 2: Create plugin skeleton**

`src/plugin.ts` — the main OpenClaw plugin. The `register()` function receives the plugin API and:

1. Reads plugin config (scenario dir, playground port, default scenario)
2. Registers hooks:
   - `gateway_start` → initialize ClawForce SDK, start WebSocket server
   - `gateway_stop` → cleanup
   - `before_prompt_build` → inject ClawForce context into agent prompts
   - `before_tool_call` → policy enforcement, protocol tracing
   - `llm_output` → cost tracking via cf.budget.recordCost()
   - `agent_end` → mark tick complete, record trust, check compliance
   - `message_sending` → capture inter-agent messages for visualization
3. Registers HTTP route for WebSocket upgrade (`/clawforce-playground/ws`)
4. Registers gateway methods for playground commands

The plugin API type is received as a parameter — we don't import it. Define a minimal type for it:

```typescript
// Minimal type for the OpenClaw plugin API we use
// (we don't import from openclaw — it calls us)
interface PluginApi {
  id: string;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  on(hook: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }): void;
  registerHttpRoute(params: { path: string; handler: (req: unknown, res: unknown) => void }): void;
  registerGatewayMethod(method: string, handler: (params: unknown) => Promise<unknown>): void;
  registerTool(tool: unknown, opts?: { names?: string[] }): void;
  registerService(service: { id: string; start: () => Promise<void>; stop: () => Promise<void> }): void;
  injectAgentMessage(params: { sessionKey: string; message: string; idempotencyKey?: string }): Promise<{ runId?: string }>;
}
```

- [ ] **Step 3: Commit**

---

## Chunk 2: Scenario Engine

### Task 2.1: Scenario types

**Files:**
- Create: `src/scenario/schema.ts`

- [ ] **Step 1: Define scenario template types**

Adapt from the playground's schema but simpler — focused on what the runner needs:

```typescript
export interface ScenarioTemplate {
  name: string;
  description: string;
  tagline: string;

  // Agent definitions for ClawForce workforce registration
  agents: Record<string, ScenarioAgent>;

  // Simulation settings
  tickIntervalMs: number;  // default 5000 (agents need time for LLM calls)
  maxTicks: number;        // default 200

  // Budget
  totalBudgetCents: number;
  agentBudgets: Record<string, number>;  // cents per agent

  // Goals
  goals: ScenarioGoal[];

  // Per-role decision spaces
  decisions: Record<string, RoleDecisionSpace>;

  // 3D placement (for frontend)
  placement: Record<string, { position: [number, number]; location: string }>;
}

export interface ScenarioAgent {
  role: string;       // coordinator | employee
  title: string;
  department: string;
  persona: string;    // personality for LLM prompt
}

export interface ScenarioGoal {
  id: string;
  title: string;
  description: string;
  parentGoalId?: string;
}

export interface RoleDecisionSpace {
  onIdle: DecisionOption[];
  onTaskAssigned: DecisionOption[];
  onMessageReceived: DecisionOption[];
  onBudgetPressure: DecisionOption[];
}

export interface DecisionOption {
  id: string;
  label: string;
  description: string;
}
```

- [ ] **Step 2: Commit**

---

### Task 2.2: Pyramid scenario

**Files:**
- Create: `src/scenario/pyramid.yaml`, `src/scenario/prompts.ts`

- [ ] **Step 1: Create pyramid scenario YAML**

Define the 6 agents (Architect Nefertari, Foreman Khufu, Worker Alpha Amon, Worker Beta Bastet, Inspector Thoth, Supplier Hathor), their roles, decision spaces, budgets, and goals (one per pyramid layer + overall completion goal).

- [ ] **Step 2: Create prompt templates**

`src/scenario/prompts.ts` — templates for the tick prompt injected to each agent:

```typescript
export function buildTickPrompt(agent: AgentContext, state: SimState): string {
  return `
## Current Situation (Tick ${state.tick})

Pyramid Progress: ${state.blocksPlaced}/${state.blocksTotal} blocks placed
Current Layer: ${state.currentLayer} (${state.currentLayerProgress})
Your Budget: $${agent.budgetRemaining} remaining of $${agent.budgetTotal}
Your Trust Score: ${agent.trustScore}%

## Your Status
${agent.currentTask ? `Working on: ${agent.currentTask.title}` : "No current task"}
${agent.pendingMessages > 0 ? `You have ${agent.pendingMessages} unread messages` : ""}

## Available Actions
${agent.availableActions.map((a, i) => `${i + 1}. **${a.label}**: ${a.description}`).join("\n")}

## Instructions
Choose ONE action by number. Then write a brief statement (1-2 sentences) explaining your choice — this will be visible to your team.

Respond in this format:
ACTION: <number>
SPEECH: <your statement>
`.trim();
}
```

- [ ] **Step 3: Commit**

---

### Task 2.3: Scenario loader

**Files:**
- Create: `src/scenario/loader.ts`

- [ ] **Step 1: Build YAML scenario loader**

Reads YAML, parses into ScenarioTemplate, validates required fields.

- [ ] **Step 2: Write test**

Test that pyramid.yaml loads correctly, all agents present, all decision spaces defined.

- [ ] **Step 3: Commit**

---

## Chunk 3: Runtime Engine

### Task 3.1: Simulation state

**Files:**
- Create: `src/runtime/state.ts`

- [ ] **Step 1: Define simulation state**

Same types as the playground's `server/state.ts` but adapted for the runner context. Include pyramid state, agent states, protocol checks, events, approvals, comm lines.

- [ ] **Step 2: Build initial state from scenario**

Function that takes a ScenarioTemplate and creates the initial SimulationState with all agents in starting positions, empty pyramid, budgets set.

- [ ] **Step 3: Commit**

---

### Task 3.2: Agent dispatcher

**Files:**
- Create: `src/runtime/dispatcher.ts`

- [ ] **Step 1: Build the agent dispatch function**

For each agent per tick:
1. Build the tick prompt using `buildTickPrompt()`
2. Construct session key: `agent:<agentId>:playground-<scenarioId>`
3. Call `api.injectAgentMessage({ sessionKey, message: prompt, idempotencyKey: tick-agent-id })`
4. Return the runId for tracking

```typescript
export async function dispatchAgentTick(
  api: PluginApi,
  agentId: string,
  scenarioId: string,
  prompt: string,
  tick: number,
): Promise<string | undefined> {
  const sessionKey = `agent:${agentId}:playground-${scenarioId}`;
  const result = await api.injectAgentMessage({
    sessionKey,
    message: prompt,
    idempotencyKey: `tick-${tick}-${agentId}`,
  });
  return result.runId;
}
```

- [ ] **Step 2: Commit**

---

### Task 3.3: Run completion tracker

**Files:**
- Create: `src/runtime/tracker.ts`

- [ ] **Step 1: Build the completion tracker**

Tracks which agent runs are in-flight and resolves when all complete for a tick.

```typescript
export class TickTracker {
  private pending = new Map<string, { resolve: () => void }>();

  /** Register that we're waiting for agentId to complete */
  expectCompletion(agentId: string): Promise<void> {
    return new Promise(resolve => {
      this.pending.set(agentId, { resolve });
    });
  }

  /** Called from agent_end hook when an agent's run completes */
  markComplete(agentId: string): void {
    const entry = this.pending.get(agentId);
    if (entry) {
      entry.resolve();
      this.pending.delete(agentId);
    }
  }

  /** Wait for all pending agents to complete, with timeout */
  async waitAll(timeoutMs: number): Promise<void> {
    const promises = [...this.pending.values()].map(e =>
      Promise.race([
        new Promise<void>(r => { e.resolve = r; }),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Tick timeout")), timeoutMs)
        ),
      ])
    );
    await Promise.allSettled(promises);
    this.pending.clear();
  }
}
```

- [ ] **Step 2: Commit**

---

### Task 3.4: Decision space engine

**Files:**
- Create: `src/runtime/decision-space.ts`

- [ ] **Step 1: Build context-aware decision filtering**

Given agent role + current state, returns applicable actions from the scenario's decision space. Same logic as playground but adapted for the runner.

- [ ] **Step 2: Commit**

---

### Task 3.5: Tick loop

**Files:**
- Create: `src/runtime/tick.ts`

- [ ] **Step 1: Build the tick orchestrator**

```typescript
export class SimulationRuntime {
  private state: SimulationState;
  private tracker: TickTracker;
  private scenario: ScenarioTemplate;
  private api: PluginApi;
  private cf: Clawforce;
  private running = false;
  private speed = 1;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(api: PluginApi, scenario: ScenarioTemplate) { /* ... */ }

  async start(): Promise<void> {
    this.running = true;
    this.initClawforce();  // Set up SDK, register workforce, create goals
    this.scheduleTick();
  }

  private scheduleTick(): void {
    if (!this.running) return;
    const interval = this.scenario.tickIntervalMs / this.speed;
    this.tickTimer = setTimeout(() => this.executeTick(), interval);
  }

  private async executeTick(): Promise<void> {
    this.state.tick++;

    // 1. Determine which agents act this tick
    const activeAgents = this.getActiveAgents();

    // 2. Build prompts and dispatch all agents in parallel
    for (const agent of activeAgents) {
      const prompt = buildTickPrompt(agent, this.state);
      this.tracker.expectCompletion(agent.id);
      await dispatchAgentTick(this.api, agent.id, this.scenario.name, prompt, this.state.tick);
    }

    // 3. Wait for all agents to complete (timeout: 30s per agent)
    // Note: agent_end fires per injectAgentMessage call since each injection
    // triggers a full agent turn via the "agent" gateway method.
    // Session keys are reused across ticks (agent:<id>:playground-<scenario>)
    // so agents maintain conversation continuity.
    await this.tracker.waitAll(30_000);

    // 4. Update simulation state from ClawForce SDK
    this.syncStateFromSdk();

    // 5. Push state to frontend
    this.emitStateUpdate();

    // 6. Check end conditions
    if (this.state.pyramid.complete || this.state.tick >= this.scenario.maxTicks) {
      this.running = false;
      this.emitSimulationEnd();
      return;
    }

    // 7. Schedule next tick
    this.scheduleTick();
  }

  pause(): void { /* ... */ }
  resume(): void { /* ... */ }
  setSpeed(multiplier: number): void { /* ... */ }

  /** Called by agent_end hook */
  onAgentComplete(agentId: string, result: AgentEndResult): void {
    this.updateAgentState(agentId, result);
    this.tracker.markComplete(agentId);
  }

  /** Called by before_tool_call hook */
  onToolCall(agentId: string, toolName: string, params: unknown): void {
    // Record protocol check, update state
  }

  getState(): SimulationState { return this.state; }
  onStateChange(cb: (state: SimulationState) => void): void { /* ... */ }
}
```

- [ ] **Step 2: Commit**

---

## Chunk 4: Governance Integration

### Task 4.1: ClawForce SDK setup

**Files:**
- Create: `src/governance/hooks.ts`

- [ ] **Step 1: Build ClawForce initialization for scenarios**

When a scenario starts:
1. Create temp directory for ClawForce data
2. `Clawforce.init({ domain: scenarioId })`
3. `registerWorkforceConfig()` with scenario's agents
4. Set budgets (global + per-agent)
5. Create goals from scenario
6. Register hooks: `beforeTransition` (layer ordering), `beforeDispatch` (budget gate)

- [ ] **Step 2: Commit**

---

### Task 4.2: Protocol tracer

**Files:**
- Create: `src/governance/tracer.ts`

- [ ] **Step 1: Build protocol layer capture**

Wraps ClawForce SDK calls to record which of the 15 validation layers fire per agent action. Same approach as the playground's tracer but integrated into the real runtime.

- [ ] **Step 2: Commit**

---

### Task 4.3: Context injection

**Files:**
- Create: `src/governance/context.ts`

- [ ] **Step 1: Build before_prompt_build context**

The `before_prompt_build` hook injects ClawForce governance context into every agent prompt:
- Current task assignment and state
- Budget remaining
- Trust score
- Pending messages from other agents
- Active goals and progress
- Recent protocol check results (so agents know what got blocked)

This uses the same pattern as the existing ClawForce adapter (`adapters/openclaw.ts`).

- [ ] **Step 2: Commit**

---

## Chunk 5: WebSocket + Frontend Integration

### Task 5.1: WebSocket server

**Files:**
- Create: `src/server/ws.ts`, `src/server/commands.ts`

- [ ] **Step 1: Build WebSocket server via OpenClaw HTTP route**

Register `/clawforce-playground/ws` as an HTTP route that upgrades to WebSocket. Same protocol as the playground's server:

Server → Client:
- `state_update` — delta state each tick
- `approval_request` — new approval needed
- `simulation_end` — scenario complete

Client → Server:
- `start` — begin scenario
- `pause` / `resume`
- `set_speed`
- `approve` / `reject`
- `send_message`

- [ ] **Step 2: Build command handler**

Process incoming user commands and forward to SimulationRuntime.

- [ ] **Step 3: Commit**

---

### Task 5.2: Wire plugin together

**Files:**
- Modify: `src/plugin.ts`

- [ ] **Step 1: Connect all components in the plugin register function**

Wire up:
1. `gateway_start` → init ClawForce, start WebSocket, load default scenario
2. `before_prompt_build` → inject context from `governance/context.ts`
3. `before_tool_call` → run protocol tracer, enforce policies
4. `llm_output` → record costs via `cf.budget.recordCost()`
5. `agent_end` → notify tick tracker, record trust, update state
6. `message_sending` → capture for comm line visualization
7. `gateway_stop` → cleanup temp dirs, close WebSocket

- [ ] **Step 2: Commit**

---

### Task 5.3: Update playground frontend

**Files:**
- Modify: files in `/Users/lylejens/workplace/clawforce-playground/`

- [ ] **Step 1: Update WebSocket URL**

Change the playground's `useSimulation.ts` hook to connect to the runner's WebSocket endpoint (`/clawforce-playground/ws` on the OpenClaw gateway port) instead of the standalone `ws://localhost:3200`.

- [ ] **Step 2: Convert standalone server to proxy mode**

Don't delete `clawforce-playground/server/`. Instead, add a proxy mode:
- **Standalone mode** (default): runs the local simulation runtime (existing behavior, works without OpenClaw for development/testing)
- **Proxy mode** (`--proxy`): forwards user commands to the runner plugin's WebSocket, relays state updates back to the frontend

This keeps the playground working independently for dev while also supporting the real OpenClaw-backed runtime.

- [ ] **Step 3: Update dev scripts**

```json
{
  "scripts": {
    "dev": "npm run dev:client",
    "dev:standalone": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
    "dev:client": "vite"
  }
}
```

When using the runner:
1. Start OpenClaw with runner plugin: `openclaw gateway`
2. Run `npm run dev` in clawforce-playground
3. Frontend connects to OpenClaw gateway's WebSocket at `/clawforce-playground/ws`

When developing without OpenClaw:
1. Run `npm run dev:standalone`
2. Uses the local standalone server (existing behavior)

- [ ] **Step 4: Commit**

---

## Chunk 6: End-to-End Testing

### Task 6.1: Integration test

- [ ] **Step 1: Install the plugin in OpenClaw**

Add `clawforce-runner` to OpenClaw's plugin config.

Create or update `~/.openclaw/config.json5`:
```json5
{
  // Existing config...

  // Register the runner plugin
  "plugins": {
    "clawforce-runner": {
      // Path to the plugin (for local dev, use the workspace path)
      // In production, this would be an npm package name
      "source": "~/workplace/clawforce-runner",
      "scenarioDir": "~/workplace/clawforce-runner/src/scenario",
      "defaultScenario": "pyramid"
    }
  },

  // Register the 6 pyramid agents
  // Each agent needs:
  // - A unique ID matching the scenario's agent IDs
  // - A model assignment (Haiku for speed/cost)
  // - Access to the Anthropic auth profile
  "agents": {
    "defaults": {
      "model": "claude-haiku-4-5-20251001",
      "maxConcurrent": 6
    },
    "list": {
      "architect": {
        "title": "Architect Nefertari",
        "model": "claude-haiku-4-5-20251001"
      },
      "foreman": {
        "title": "Foreman Khufu",
        "model": "claude-haiku-4-5-20251001"
      },
      "worker-alpha": {
        "title": "Worker Amon",
        "model": "claude-haiku-4-5-20251001"
      },
      "worker-beta": {
        "title": "Worker Bastet",
        "model": "claude-haiku-4-5-20251001"
      },
      "inspector": {
        "title": "Inspector Thoth",
        "model": "claude-haiku-4-5-20251001"
      },
      "supplier": {
        "title": "Supplier Hathor",
        "model": "claude-haiku-4-5-20251001"
      }
    }
  }
}
```

**Important:** The `maxConcurrent: 6` setting is critical — it allows all 6 agents to run LLM calls simultaneously within a single tick. The default of 4 would bottleneck the simulation.

**Auth:** Agents inherit the default Anthropic API key from `~/.openclaw/agents/defaults/agent/auth-profiles.json` or from environment variable `ANTHROPIC_API_KEY`. No per-agent auth setup needed if using a single API key.

- [ ] **Step 2: Configure agents in OpenClaw**

Verify the agents are recognized:
```bash
openclaw agents list
```

Should show all 6 agents. If not, check the config format against OpenClaw's documentation.

- [ ] **Step 3: Start OpenClaw and verify**

```bash
openclaw gateway
```

Verify in logs:
- `[clawforce-runner] Plugin loaded`
- `[clawforce-runner] WebSocket server ready on /clawforce-playground/ws`
- `[clawforce-runner] Scenario "pyramid" loaded (6 agents, 30 blocks)`

- [ ] **Step 4: Start playground frontend**

```bash
cd ~/workplace/clawforce-playground
npm run dev:client
```

Open browser. Verify:
- 3D scene loads with 6 agents
- Simulation starts, agents make real LLM-powered decisions
- Speech bubbles show real agent reasoning
- Protocol stack lights up with real validation results
- Budget tracks real token costs
- Trust updates from real inspector decisions
- Approvals appear when foreman needs to approve structural decisions

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: ClawForce Runner v0.1.0 — OpenClaw plugin with 3D playground"
```

---

## Execution Notes

### Agent Configuration Requirements

Each agent in the scenario needs to be registered in OpenClaw's config with:
- A model assignment (Claude Haiku recommended for speed/cost)
- Auth profile access (Anthropic API key)
- No special tools needed (the plugin injects prompts, not tool calls)

### Cost Estimate

Using Claude Haiku at ~$0.25/1M input, ~$1.25/1M output:
- 6 agents × ~500 tokens/tick × 100 ticks = 300K tokens
- Estimated cost per scenario run: ~$0.10-0.20
- Very affordable for demos

### Tick Interval

Default 5000ms (5 seconds) per tick. This gives OpenClaw time to:
1. Receive the injected message
2. Queue the agent run
3. Build the prompt (with ClawForce context injection)
4. Make the LLM call (~1-3 seconds for Haiku)
5. Process the response
6. Fire agent_end hook

For faster demos, reduce to 3000ms. For development/debugging, increase to 10000ms.

### Parsing Agent Responses

Agents respond in the format:
```
ACTION: 3
SPEECH: "Let me inspect that block placement for structural integrity."
```

The runner parses this to extract:
1. Which action the agent chose (maps to decision space option)
2. What they "said" (shown in speech bubble)

If parsing fails (LLM didn't follow format), do NOT silently default. Instead:
1. Record a protocol violation for the agent
2. Re-inject the prompt with a reminder: "Respond in the required format: ACTION: <number>\nSPEECH: <text>"
3. If second attempt also fails, mark the agent's tick as failed and skip them
4. Never silently default to action 1 — that defeats the validation layers

### SDK Dogfooding

Building the runner will surface SDK friction. Track issues in `DOGFOOD.md`:
- Does the SDK support efficient bulk state queries per tick?
- Is the hook system fast enough for real-time governance?
- Does protocol tracing expose enough detail?
- Are there race conditions with parallel agent runs updating shared state?
