# ClawForce Runner — Standalone Migration Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the ClawForce Runner as a standalone process that uses OpenClaw as a library (not a gateway plugin). Direct LLM calls via `runEmbeddedPiAgent()`, own WebSocket server, own session management. No gateway dependency. No fallbacks. No legacy code.

**Architecture:** The runner is a standalone Node.js process. It imports `runEmbeddedPiAgent` from OpenClaw for LLM calls (any provider, auth from `~/.openclaw/`). It imports `Clawforce` from the SDK for governance. It runs its own WebSocket server for the playground frontend. Scenarios are YAML templates. Each tick dispatches agent runs in parallel, governed by ClawForce's 15 validation layers.

**Tech Stack:**
- **LLM Calls:** `runEmbeddedPiAgent` from `openclaw` (supports Anthropic, OpenAI, Google, local models)
- **Governance:** `Clawforce` from `clawforce` SDK
- **Frontend:** Existing `clawforce-playground` React Three Fiber app
- **Sessions:** SQLite (via ClawForce SDK's `cf.db`)
- **WebSocket:** `ws` package, standalone server
- **Scenarios:** YAML templates

**Project:** `/Users/lylejens/workplace/clawforce-runner/`

**What gets deleted:** ALL existing runner code. Clean rewrite. The current code is a gateway plugin — every file assumes the gateway is the host. Patching it would be more work than rewriting.

---

## What Changes

| Before (gateway plugin) | After (standalone) |
|---|---|
| Runs inside OpenClaw gateway process | Runs as its own `node` process |
| `api.injectAgentMessage()` for LLM calls | `runEmbeddedPiAgent()` imported from openclaw |
| Gateway handles auth, model routing | OpenClaw library handles auth, model routing |
| `api.registerHttpRoute()` for WebSocket | Own `ws.Server` on dedicated port |
| `api.on("agent_end", ...)` for completion | Direct `await runEmbeddedPiAgent()` returns when done |
| `api.on("before_prompt_build", ...)` for context | Build prompt directly before calling `runEmbeddedPiAgent()` |
| `openclaw.plugin.json` manifest | `npm run start` / `npx clawforce-runner` |
| Plugin config via gateway | Own config file or CLI args |
| Gateway's session store | Own session files (JSONL per agent, managed by runner) |

---

## File Structure (after migration)

```
clawforce-runner/
├── package.json
├── tsconfig.json
├── .gitignore
│
├── src/
│   ├── index.ts                  # Entry point — parse args, start runner
│   ├── runner.ts                 # Main Runner class (start, stop, configure)
│   │
│   ├── agent/
│   │   ├── call.ts               # Wraps runEmbeddedPiAgent() — single LLM call
│   │   ├── auth.ts               # Reads OpenClaw auth profiles from disk
│   │   ├── session.ts            # Manages per-agent session JSONL files
│   │   └── prompt.ts             # Builds full prompt (scenario context + governance context + tick prompt)
│   │
│   ├── scenario/
│   │   ├── schema.ts             # Scenario template types (KEEP from current)
│   │   ├── loader.ts             # YAML loader (KEEP from current)
│   │   ├── pyramid.yaml          # Pyramid scenario (KEEP from current)
│   │   └── decisions.ts          # Decision space engine (KEEP from current)
│   │
│   ├── runtime/
│   │   ├── state.ts              # Simulation state types (KEEP from current)
│   │   ├── tick.ts               # Tick loop — dispatch all agents, await results, update state
│   │   ├── parser.ts             # Parse agent responses (KEEP from current)
│   │   └── actions.ts            # Execute parsed actions through ClawForce SDK
│   │
│   ├── governance/
│   │   ├── hooks.ts              # ClawForce SDK init (KEEP from current)
│   │   ├── tracer.ts             # Protocol layer tracer (KEEP from current)
│   │   └── context.ts            # Governance context builder (KEEP from current)
│   │
│   └── server/
│       ├── ws.ts                 # Standalone WebSocket server
│       └── commands.ts           # Handle user commands from frontend
│
├── test/
│   ├── call.test.ts              # Test agent LLM call wrapper
│   ├── loader.test.ts            # (KEEP from current)
│   ├── parser.test.ts            # (KEEP from current)
│   ├── decision-space.test.ts    # (KEEP from current)
│   └── runner.test.ts            # Integration test — full tick cycle
│
└── sessions/                     # Runtime: per-agent JSONL session files
    └── (created at runtime)
```

**Files to KEEP** (move to new locations, minimal changes):
- `src/scenario/schema.ts` — types are correct
- `src/scenario/loader.ts` — YAML loading is correct
- `src/scenario/pyramid.yaml` — scenario definition is correct
- `src/runtime/state.ts` — state types are correct
- `src/runtime/parser.ts` — response parsing is correct
- `src/runtime/decision-space.ts` → `src/scenario/decisions.ts`
- `src/governance/hooks.ts` — ClawForce SDK init is correct
- `src/governance/tracer.ts` — protocol tracing is correct
- `src/governance/context.ts` — context building is correct
- `test/loader.test.ts`, `test/parser.test.ts`, `test/decision-space.test.ts` — tests pass

**Files to DELETE** (gateway-dependent):
- `src/index.ts` — exports plugin, rewrite as CLI entry
- `src/plugin.ts` — entire gateway plugin, delete
- `src/types.ts` — PluginApi type, delete
- `src/runtime/tick.ts` — uses plugin API for dispatch, rewrite
- `src/runtime/dispatcher.ts` — calls gateway HTTP endpoint, rewrite
- `src/runtime/tracker.ts` — tracks agent_end hooks, delete (not needed — `runEmbeddedPiAgent` is synchronous/awaitable)
- `openclaw.plugin.json` — plugin manifest, delete
- `src/openclaw.plugin.json` — duplicate manifest, delete

---

## Chunk 1: Strip Gateway, Add OpenClaw Library Calls

### Task 1.1: Clean house

**Files:**
- Delete: `src/index.ts`, `src/plugin.ts`, `src/types.ts`, `src/runtime/dispatcher.ts`, `src/runtime/tracker.ts`, `openclaw.plugin.json`, `src/openclaw.plugin.json`

- [ ] **Step 1: Delete all gateway-dependent files**

```bash
cd ~/workplace/clawforce-runner
rm -f src/index.ts src/plugin.ts src/types.ts src/runtime/dispatcher.ts src/runtime/tracker.ts openclaw.plugin.json src/openclaw.plugin.json
```

- [ ] **Step 2: Update package.json**

Remove `peerDependencies` on openclaw. Add it as a real dependency. Update scripts. Add bin entry.

```json
{
  "name": "clawforce-runner",
  "version": "0.1.0",
  "type": "module",
  "description": "Standalone runner for ClawForce agent teams — direct LLM calls, no gateway",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "clawforce-runner": "./dist/index.js"
  },
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "clawforce": "file:../clawforce",
    "openclaw": "^2026.3.0",
    "ws": "^8.18.0",
    "yaml": "^2.8.0"
  },
  "devDependencies": {
    "@types/node": "^25.3.2",
    "@types/ws": "^8.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: strip gateway plugin code — preparing for standalone rewrite"
```

---

### Task 1.2: Agent LLM call wrapper

**Files:**
- Create: `src/agent/call.ts`

- [ ] **Step 1: Build the LLM call wrapper**

Wraps `runEmbeddedPiAgent()` from OpenClaw. This is the ONLY place LLM calls happen.

```typescript
import { runEmbeddedPiAgent } from "openclaw";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface AgentCallParams {
  agentId: string;
  prompt: string;
  /** Model override (default: from OpenClaw config) */
  model?: string;
  /** Provider override (default: from OpenClaw config) */
  provider?: string;
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Session directory for this agent */
  sessionDir: string;
  /** Agent workspace directory */
  workspaceDir: string;
  /** Agent config directory (~/.openclaw/agents/<id>/agent) */
  agentDir: string;
  /** OpenClaw config object */
  config?: Record<string, unknown>;
}

export interface AgentCallResult {
  /** The agent's text response */
  text: string | null;
  /** Token usage */
  usage?: { input: number; output: number; total: number };
  /** Duration in ms */
  durationMs: number;
  /** Whether the call succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

export async function callAgent(params: AgentCallParams): Promise<AgentCallResult> {
  const sessionFile = path.join(params.sessionDir, `${params.agentId}.jsonl`);

  // Ensure session file exists
  if (!fs.existsSync(sessionFile)) {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "");
  }

  const runId = crypto.randomUUID();

  try {
    const result = await runEmbeddedPiAgent({
      sessionId: `clawforce-${params.agentId}-${Date.now()}`,
      sessionFile,
      workspaceDir: params.workspaceDir,
      prompt: params.prompt,
      timeoutMs: params.timeoutMs ?? 30_000,
      runId,
      provider: params.provider,
      model: params.model,
      agentDir: params.agentDir,
      config: params.config,
    });

    const text = result.payloads?.[0]?.text ?? null;
    const usage = result.meta?.agentMeta?.usage;

    return {
      text,
      usage: usage ? {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        total: usage.total ?? 0,
      } : undefined,
      durationMs: result.meta?.durationMs ?? 0,
      success: !result.meta?.error,
      error: result.meta?.error?.message,
    };
  } catch (err) {
    return {
      text: null,
      durationMs: 0,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

Key points:
- Uses `runEmbeddedPiAgent` from openclaw — works with ANY provider
- Auth resolved automatically from `~/.openclaw/` config
- Each agent gets its own session JSONL file (conversation continuity across ticks)
- Returns clean result type — text, usage, duration, success/error
- No gateway, no HTTP, no plugin API

- [ ] **Step 2: Commit**

---

### Task 1.3: Auth profile resolution

**Files:**
- Create: `src/agent/auth.ts`

- [ ] **Step 1: Build auth resolution helper**

Resolves OpenClaw paths for agent directories and workspace.

```typescript
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "openclaw";
import { loadConfig } from "openclaw";  // or however config is loaded
import path from "node:path";
import os from "node:os";

export interface ResolvedAgentPaths {
  agentDir: string;       // ~/.openclaw/agents/<id>/agent
  workspaceDir: string;   // ~/.openclaw/state/workspace-<id>
}

/**
 * Resolve OpenClaw paths for an agent.
 * Falls back to default agent if specific agent dir doesn't exist.
 */
export function resolveAgentPaths(
  agentId: string,
  openclawConfig?: Record<string, unknown>,
): ResolvedAgentPaths {
  const cfg = openclawConfig ?? {};

  try {
    const agentDir = resolveAgentDir(cfg as any, agentId);
    const workspaceDir = resolveAgentWorkspaceDir(cfg as any, agentId);
    return { agentDir, workspaceDir };
  } catch {
    // Fall back to default agent paths
    const home = os.homedir();
    return {
      agentDir: path.join(home, ".openclaw", "agents", agentId, "agent"),
      workspaceDir: path.join(home, ".openclaw", "state", `workspace-${agentId}`),
    };
  }
}

/**
 * Load OpenClaw config from disk.
 * Reads ~/.openclaw/openclaw.json or config.json5
 */
export function loadOpenClawConfig(): Record<string, unknown> {
  // Try to use OpenClaw's config loader
  try {
    const { loadConfigFromDisk } = require("openclaw");
    return loadConfigFromDisk();
  } catch {
    // Manual fallback — read JSON from default path
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    try {
      const raw = require("node:fs").readFileSync(configPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
}
```

- [ ] **Step 2: Commit**

---

### Task 1.4: Session management

**Files:**
- Create: `src/agent/session.ts`

- [ ] **Step 1: Build per-agent session management**

Each agent gets a JSONL session file. The runner manages these — not OpenClaw, not the gateway.

```typescript
import fs from "node:fs";
import path from "node:path";

/**
 * Manages session JSONL files for agents in a scenario run.
 * Sessions persist across ticks — agents have conversation continuity.
 */
export class SessionManager {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    fs.mkdirSync(baseDir, { recursive: true });
  }

  /** Get the session file path for an agent */
  getSessionFile(agentId: string): string {
    return path.join(this.baseDir, `${agentId}.jsonl`);
  }

  /** Ensure a session file exists (create empty if needed) */
  ensureSession(agentId: string): string {
    const file = this.getSessionFile(agentId);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, "");
    }
    return file;
  }

  /** Reset a session (clear the JSONL file) */
  resetSession(agentId: string): void {
    const file = this.getSessionFile(agentId);
    fs.writeFileSync(file, "");
  }

  /** Reset all sessions */
  resetAll(): void {
    if (fs.existsSync(this.baseDir)) {
      for (const f of fs.readdirSync(this.baseDir)) {
        if (f.endsWith(".jsonl")) {
          fs.writeFileSync(path.join(this.baseDir, f), "");
        }
      }
    }
  }

  /** Get the base directory */
  getBaseDir(): string {
    return this.baseDir;
  }

  /** Clean up session directory */
  cleanup(): void {
    fs.rmSync(this.baseDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Commit**

---

### Task 1.5: Prompt builder

**Files:**
- Create: `src/agent/prompt.ts`

- [ ] **Step 1: Build the full prompt assembler**

Combines: scenario persona + governance context + tick-specific state + available actions.

This replaces what `before_prompt_build` hook did in the plugin version. Now it's just a function call before `callAgent()`.

```typescript
import { buildGovernanceContext } from "../governance/context.js";
import { buildTickPrompt } from "../scenario/prompts.js";
import { getApplicableDecisions } from "../scenario/decisions.js";
import type { Clawforce } from "clawforce";
import type { ScenarioTemplate, ScenarioAgent } from "../scenario/schema.js";
import type { SimulationState, AgentState } from "../runtime/state.js";

export function buildFullPrompt(
  cf: Clawforce,
  scenario: ScenarioTemplate,
  agent: ScenarioAgent & { id: string },
  agentState: AgentState,
  simState: SimulationState,
): string {
  // 1. Agent persona from scenario
  const persona = `You are ${agent.title}. ${agent.persona}`;

  // 2. Governance context from ClawForce (budget, trust, tasks, messages)
  const governance = buildGovernanceContext(cf, agent.id, scenario.name);

  // 3. Tick-specific prompt (pyramid state, available actions, instructions)
  const decisions = getApplicableDecisions(agent.id, agentState, simState);
  const tickPrompt = buildTickPrompt(
    { ...agentState, availableActions: decisions.options },
    simState,
  );

  return `${persona}\n\n${governance}\n\n${tickPrompt}`;
}
```

- [ ] **Step 2: Commit**

---

## Chunk 2: Rewrite Tick Loop + WebSocket

### Task 2.1: Rewrite tick loop

**Files:**
- Rewrite: `src/runtime/tick.ts`

- [ ] **Step 1: Build standalone tick loop**

The core difference: instead of injecting messages via plugin API and waiting for `agent_end` hooks, we directly `await callAgent()` for each agent. It's synchronous per agent, parallel across agents.

```typescript
import { callAgent } from "../agent/call.js";
import { buildFullPrompt } from "../agent/prompt.js";
import { parseAgentResponse } from "./parser.js";
import { executeAction } from "./actions.js";
import { traceAction } from "../governance/tracer.js";
import type { Clawforce } from "clawforce";
import type { ScenarioTemplate } from "../scenario/schema.js";
import type { SimulationState } from "./state.js";

export class SimulationRuntime {
  private state: SimulationState;
  private scenario: ScenarioTemplate;
  private cf: Clawforce;
  private running = false;
  private speed = 1;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private stateListeners: ((state: SimulationState) => void)[] = [];

  // OpenClaw config + agent paths
  private openclawConfig: Record<string, unknown>;
  private sessionDir: string;
  private model: string;
  private provider?: string;

  constructor(params: {
    scenario: ScenarioTemplate;
    cf: Clawforce;
    openclawConfig: Record<string, unknown>;
    sessionDir: string;
    model?: string;
    provider?: string;
  }) { /* ... */ }

  async start(): Promise<void> {
    this.running = true;
    this.scheduleTick();
  }

  private scheduleTick(): void {
    if (!this.running) return;
    const interval = this.scenario.tickIntervalMs / this.speed;
    this.tickTimer = setTimeout(() => this.executeTick(), interval);
  }

  private async executeTick(): Promise<void> {
    this.state.tick++;

    // Dispatch ALL agents in parallel — real LLM calls
    const agents = Object.entries(this.scenario.agents);
    const results = await Promise.allSettled(
      agents.map(async ([agentId, agentDef]) => {
        const agentState = this.state.agents[agentId];
        if (!agentState || agentState.status === "disabled") return null;

        // Build full prompt (persona + governance + tick state)
        const prompt = buildFullPrompt(
          this.cf, this.scenario, { ...agentDef, id: agentId },
          agentState, this.state,
        );

        // Resolve agent paths from OpenClaw config
        const { resolveAgentPaths } = await import("../agent/auth.js");
        const paths = resolveAgentPaths(agentId, this.openclawConfig);

        // Make real LLM call — direct, no gateway
        const result = await callAgent({
          agentId,
          prompt,
          model: this.model,
          provider: this.provider,
          timeoutMs: 30_000,
          sessionDir: this.sessionDir,
          workspaceDir: paths.workspaceDir,
          agentDir: paths.agentDir,
          config: this.openclawConfig,
        });

        if (!result.success) {
          console.error(`[${agentId}] LLM call failed: ${result.error}`);
          return { agentId, result, parsed: null };
        }

        // Record token costs through ClawForce
        if (result.usage) {
          this.cf.budget.recordCost({
            agentId,
            inputTokens: result.usage.input,
            outputTokens: result.usage.output,
            model: this.model ?? "default",
            provider: this.provider ?? "default",
          });
        }

        // Parse response (strict — no silent fallback)
        const decisions = (await import("../scenario/decisions.js"))
          .getApplicableDecisions(agentId, agentState, this.state);
        const parsed = parseAgentResponse(result.text ?? "", decisions.options);

        if (!parsed) {
          // Retry once with reminder
          const retryResult = await callAgent({
            agentId,
            prompt: `${prompt}\n\nIMPORTANT: You must respond in this exact format:\nACTION: <number>\nSPEECH: <your statement>`,
            model: this.model,
            provider: this.provider,
            timeoutMs: 15_000,
            sessionDir: this.sessionDir,
            workspaceDir: paths.workspaceDir,
            agentDir: paths.agentDir,
            config: this.openclawConfig,
          });

          const retryParsed = retryResult.text
            ? parseAgentResponse(retryResult.text, decisions.options)
            : null;

          return { agentId, result: retryResult, parsed: retryParsed };
        }

        return { agentId, result, parsed };
      }),
    );

    // Process results — execute actions through ClawForce SDK
    for (const settled of results) {
      if (settled.status === "rejected" || !settled.value) continue;
      const { agentId, result, parsed } = settled.value;

      // Update agent speech
      if (result.text) {
        const agentState = this.state.agents[agentId];
        if (agentState) {
          agentState.lastSpeech = parsed?.speech ?? result.text.slice(0, 200);
          agentState.speechExpiresAt = this.state.tick + 3;
        }
      }

      // Execute the chosen action through ClawForce
      if (parsed) {
        const decisions = (await import("../scenario/decisions.js"))
          .getApplicableDecisions(agentId, this.state.agents[agentId]!, this.state);
        const action = decisions.options[parsed.actionIndex];
        if (action) {
          // Trace through protocol layers
          const check = traceAction(this.cf, agentId, action.id, this.state.tick);
          this.state.protocolChecks.push(check);

          // Execute if allowed
          if (check.allowed) {
            executeAction(this.cf, agentId, action, this.state);
          }
        }
      }
    }

    // Sync state from ClawForce SDK (trust scores, budget, etc.)
    this.syncStateFromSdk();

    // Push to frontend
    this.emitStateUpdate();

    // Check end conditions
    if (this.state.pyramid.complete || this.state.tick >= this.scenario.maxTicks) {
      this.running = false;
      return;
    }

    this.scheduleTick();
  }

  pause(): void { this.running = false; if (this.tickTimer) clearTimeout(this.tickTimer); }
  resume(): void { if (!this.running) { this.running = true; this.scheduleTick(); } }
  setSpeed(s: number): void { this.speed = s; }
  getState(): SimulationState { return this.state; }
  onStateChange(cb: (s: SimulationState) => void): void { this.stateListeners.push(cb); }

  private emitStateUpdate(): void {
    for (const cb of this.stateListeners) cb(this.state);
  }

  private syncStateFromSdk(): void {
    // Update trust scores, budget remaining from ClawForce
    for (const [agentId, agentState] of Object.entries(this.state.agents)) {
      const score = this.cf.trust.score();
      agentState.trustScore = Math.round(score.overall * 100);
      const budget = this.cf.budget.check();
      // ... sync budget, tasks, etc.
    }
  }
}
```

Key difference from the plugin version:
- `await callAgent()` replaces `api.injectAgentMessage()` + `agent_end` hook tracking
- Each call returns directly — no fire-and-forget, no tracker, no timeouts
- All agents dispatch in parallel via `Promise.allSettled`
- Governance context built inline, not via hooks
- Token costs recorded directly after each call

- [ ] **Step 2: Commit**

---

### Task 2.2: Action executor

**Files:**
- Create: `src/runtime/actions.ts`

- [ ] **Step 1: Build action executor**

Maps parsed agent decisions to ClawForce SDK calls. When the architect chooses "design_next_layer", the executor calls `cf.tasks.create()` for each block in that layer. When a worker chooses "place_block", it calls `cf.tasks.transition()`.

Actions by role:
- **Architect**: design_next_layer → create block tasks for next layer
- **Foreman**: assign_block_task → cf.tasks.transition(OPEN → ASSIGNED), check_progress → cf.goals.list(), approve → cf.approvals.resolve()
- **Worker**: pick_up_block → update agent state, place_block → cf.tasks.transition(IN_PROGRESS → REVIEW)
- **Inspector**: approve_placement → cf.tasks.transition(REVIEW → DONE) + cf.trust.record(approved), reject_placement → cf.trust.record(rejected, severity)
- **Supplier**: allocate_budget → cf.budget.set(), procure_blocks → cf.budget.recordCost()

Each action updates both the ClawForce SDK state AND the simulation state (pyramid blocks, agent positions, etc.).

- [ ] **Step 2: Commit**

---

### Task 2.3: Standalone WebSocket server

**Files:**
- Rewrite: `src/server/ws.ts`

- [ ] **Step 1: Build standalone WebSocket server**

No gateway, no HTTP route registration. Just a `ws.Server` on a configurable port (default 3210).

```typescript
import { WebSocketServer, WebSocket } from "ws";
import type { SimulationState } from "../runtime/state.js";

export class PlaygroundServer {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();

  constructor(port: number = 3210) {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      ws.on("message", (data) => this.handleMessage(ws, data));
    });
  }

  /** Push state update to all connected clients */
  broadcast(state: SimulationState): void {
    const msg = JSON.stringify({ type: "state_update", state });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  /** Register command handler */
  onCommand: ((cmd: string, params: Record<string, unknown>) => void) | null = null;

  private handleMessage(ws: WebSocket, data: unknown): void {
    try {
      const msg = JSON.parse(String(data));
      this.onCommand?.(msg.command, msg);
    } catch { /* ignore malformed */ }
  }

  close(): void {
    this.wss.close();
  }
}
```

- [ ] **Step 2: Commit**

---

### Task 2.4: Runner entry point

**Files:**
- Create: `src/index.ts`, `src/runner.ts`

- [ ] **Step 1: Build the Runner class**

`src/runner.ts` — orchestrates everything:

```typescript
import { Clawforce } from "clawforce";
import { registerWorkforceConfig, setProjectsDir } from "clawforce/internal";
import { initGovernance } from "./governance/hooks.js";
import { loadScenario } from "./scenario/loader.js";
import { SimulationRuntime } from "./runtime/tick.js";
import { PlaygroundServer } from "./server/ws.js";
import { SessionManager } from "./agent/session.js";
import { loadOpenClawConfig } from "./agent/auth.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface RunnerConfig {
  /** Scenario name or path to YAML */
  scenario?: string;
  /** WebSocket port for playground frontend */
  port?: number;
  /** LLM model to use */
  model?: string;
  /** LLM provider to use */
  provider?: string;
}

export class ClawforceRunner {
  private runtime: SimulationRuntime | null = null;
  private server: PlaygroundServer | null = null;
  private sessions: SessionManager | null = null;
  private governance: { cf: Clawforce; cleanup: () => void } | null = null;

  async start(config: RunnerConfig = {}): Promise<void> {
    const port = config.port ?? 3210;
    const scenarioName = config.scenario ?? "pyramid";
    const model = config.model ?? "claude-haiku-4-5-20251001";

    console.log(`[clawforce-runner] Starting...`);

    // 1. Load OpenClaw config (for auth, model routing)
    const openclawConfig = loadOpenClawConfig();

    // 2. Load scenario
    const scenario = loadScenario(scenarioName);
    console.log(`[clawforce-runner] Scenario "${scenario.name}" loaded (${Object.keys(scenario.agents).length} agents)`);

    // 3. Initialize ClawForce governance
    this.governance = initGovernance(scenario);
    console.log(`[clawforce-runner] Governance initialized`);

    // 4. Set up session management
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-runner-sessions-"));
    this.sessions = new SessionManager(sessionDir);

    // 5. Create simulation runtime
    this.runtime = new SimulationRuntime({
      scenario,
      cf: this.governance.cf,
      openclawConfig,
      sessionDir,
      model,
      provider: config.provider,
    });

    // 6. Start WebSocket server
    this.server = new PlaygroundServer(port);
    console.log(`[clawforce-runner] WebSocket server on port ${port}`);

    // Wire state updates to WebSocket
    this.runtime.onStateChange((state) => {
      this.server?.broadcast(state);
    });

    // Wire commands from frontend to runtime
    this.server.onCommand = (cmd, params) => {
      switch (cmd) {
        case "start": this.runtime?.start(); break;
        case "pause": this.runtime?.pause(); break;
        case "resume": this.runtime?.resume(); break;
        case "set_speed": this.runtime?.setSpeed(params.speed as number); break;
        // ... approve, reject, send_message
      }
    };

    console.log(`[clawforce-runner] Ready. Waiting for "start" command from playground.`);
  }

  async stop(): Promise<void> {
    this.runtime?.pause();
    this.server?.close();
    this.sessions?.cleanup();
    this.governance?.cleanup();
    console.log(`[clawforce-runner] Stopped.`);
  }
}
```

- [ ] **Step 2: Build CLI entry point**

`src/index.ts`:
```typescript
#!/usr/bin/env node
import { ClawforceRunner } from "./runner.js";

const runner = new ClawforceRunner();

const args = process.argv.slice(2);
const config: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]?.replace(/^--/, "");
  const val = args[i + 1];
  if (key && val) config[key] = val;
}

runner.start({
  scenario: config.scenario,
  port: config.port ? parseInt(config.port) : undefined,
  model: config.model,
  provider: config.provider,
}).catch(console.error);

process.on("SIGINT", () => runner.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => runner.stop().then(() => process.exit(0)));
```

Usage:
```bash
# Default (pyramid scenario, port 3210)
npm start

# Custom
npm start -- --scenario pyramid --model claude-haiku-4-5-20251001 --port 3210
```

- [ ] **Step 3: Commit**

---

## Chunk 3: Update Playground Frontend

### Task 3.1: Wire frontend to standalone runner

**Files:**
- Modify: `clawforce-playground/src/hooks/useSimulation.ts`
- Modify: `clawforce-playground/vite.config.ts`
- Modify: `clawforce-playground/package.json`

- [ ] **Step 1: Update WebSocket connection**

Connect to `ws://localhost:3210` (the standalone runner). Remove all references to the gateway, standalone server mode, and `VITE_STANDALONE` env var. One mode: connect to the runner.

- [ ] **Step 2: Update vite proxy**

Proxy `/ws` to `ws://localhost:3210` for development.

- [ ] **Step 3: Simplify package.json scripts**

```json
{
  "scripts": {
    "dev": "vite"
  }
}
```

Just the frontend. The runner is a separate process.

- [ ] **Step 4: Delete standalone server**

```bash
rm -rf ~/workplace/clawforce-playground/server/
```

The runner replaces it. No fallback. No dual mode.

- [ ] **Step 5: Commit**

---

### Task 3.2: Verify state compatibility

- [ ] **Step 1: Verify the runner's `SimulationState` type matches what the frontend store expects**

Read `clawforce-playground/src/store.ts` and compare with `clawforce-runner/src/runtime/state.ts`. Fix any mismatches. The runner's state should be the source of truth — update the frontend store mapping if needed.

- [ ] **Step 2: Commit**

---

## Chunk 4: End-to-End Test

### Task 4.1: Integration test

- [ ] **Step 1: Verify OpenClaw is installed and auth is configured**

```bash
# Check OpenClaw is installed
node -e "const oc = require('openclaw'); console.log('OpenClaw loaded')"

# Check auth profiles exist
ls ~/.openclaw/agents/main/agent/auth-profiles.json
```

- [ ] **Step 2: Start the runner**

```bash
cd ~/workplace/clawforce-runner
npm start
```

Verify in console:
- `[clawforce-runner] Starting...`
- `[clawforce-runner] Scenario "pyramid" loaded (6 agents)`
- `[clawforce-runner] Governance initialized`
- `[clawforce-runner] WebSocket server on port 3210`
- `[clawforce-runner] Ready.`

- [ ] **Step 3: Start the playground frontend**

```bash
cd ~/workplace/clawforce-playground
npm run dev
```

Open browser at `http://localhost:5173`.

- [ ] **Step 4: Verify real LLM calls**

Trigger the simulation. Verify:
- Agents make REAL decisions (speech bubbles show unique, contextual text)
- Blocks get placed in the pyramid
- Budget decreases with real token costs
- Trust updates from inspector decisions
- Protocol stack shows real validation results
- No canned/scripted responses

- [ ] **Step 5: Commit**

```bash
cd ~/workplace/clawforce-runner
git add -A
git commit -m "feat: standalone ClawForce Runner v0.2.0 — no gateway dependency"
```

---

## Execution Notes

### Development Workflow

Two terminal tabs:
```bash
# Tab 1: Runner
cd ~/workplace/clawforce-runner && npm start

# Tab 2: Playground frontend
cd ~/workplace/clawforce-playground && npm run dev
```

That's it. No OpenClaw gateway. No plugin registration. No config files to set up.

### Agent Auth Resolution

The runner reads API keys from `~/.openclaw/agents/*/agent/auth-profiles.json`. This is where OpenClaw stores provider credentials. If a user has used OpenClaw before, auth is already configured. If not, they need to run `openclaw` once to set up auth profiles.

For development, the runner can also read `ANTHROPIC_API_KEY` from environment.

### Model Selection

Default: `claude-haiku-4-5-20251001` (fast, cheap — ~$0.10 per scenario run).

Override via CLI: `npm start -- --model claude-sonnet-4-5-20241022` or any model OpenClaw supports.

The runner passes the model/provider to `runEmbeddedPiAgent()` which handles provider resolution, auth profile selection, and failover.

### What OpenClaw Provides (as a library)

- `runEmbeddedPiAgent()` — make LLM calls with any provider
- `resolveAgentDir()` / `resolveAgentWorkspaceDir()` — find agent config paths
- Auth profile resolution — API keys from `~/.openclaw/`
- Model routing — provider selection, failover

### What OpenClaw Does NOT Provide (we handle ourselves)

- Session management (our `SessionManager`)
- WebSocket server (our `PlaygroundServer`)
- Tick loop orchestration (our `SimulationRuntime`)
- Governance (ClawForce SDK)
- Scenario engine (our YAML loader)
- State management (our `SimulationState`)

### Cost Estimate

Using Claude Haiku:
- 6 agents × ~500 tokens/tick × 100 ticks = 300K tokens
- Cost: ~$0.10-0.20 per scenario run
- All 6 agents run in parallel → each tick takes ~2-3 seconds (Haiku response time)
- Full 100-tick scenario: ~4-5 minutes real time at 1x speed
