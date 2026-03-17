# ClawForce Playground Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an interactive 3D simulation where AI agents build a pyramid together, coordinated by ClawForce. The hero visual: agents carrying blocks, placing them layer by layer, communicating, handling blockers — all governed by ClawForce team protocols. "Powered by ClawForce." No explanation needed.

**Architecture:** A Node.js server runs the agent simulation (tick-based LLM-powered agent loop + ClawForce SDK) and pushes state via WebSocket to a React frontend that renders a 3D pyramid-building scene (React Three Fiber) with interactive overlays. The primary scenario is "Build the Pyramid" — a universal, visual demonstration of multi-agent coordination.

**Tech Stack:**
- **Frontend:** React 18, React Three Fiber (R3F), Drei, Zustand, Tailwind CSS, Vite
- **3D Assets:** Kenney character models (free, CC0), low-poly environment
- **Server:** Node.js, WebSocket (ws), ClawForce SDK
- **LLM:** Claude API via @anthropic-ai/sdk (bounded decision selection)
- **Scenarios:** YAML templates extending WorkforceConfig

**Project:** `~/workplace/clawforce-playground/`

**Parallel Tracks:**
- **Track A** (Server): Scenario engine + Agent runtime + WebSocket
- **Track B** (3D World): R3F scene, environment, agent rendering, movement
- **Track C** (UI): Interaction panels, chat, approvals, protocol visualizer
- **Track D** (Integration): Wire tracks together, split-screen mode, polish

Tracks A, B, and C can be built in parallel with mock data. Track D integrates them.

---

## File Structure

```
clawforce-playground/
├── package.json
├── tsconfig.json
├── tsconfig.server.json
├── vite.config.ts
├── tailwind.config.ts
├── postcss.config.js
├── index.html
│
├── scenarios/                     # Built-in scenario templates
│   ├── schema.ts                  # Scenario TypeScript types
│   ├── startup.yaml               # "The Startup" — general showcase
│   ├── budget-crisis.yaml         # Budget gets slashed mid-project
│   ├── trust-fall.yaml            # Agent starts shipping bad work
│   ├── rogue-agent.yaml           # One agent has hidden selfish objective
│   ├── the-cascade.yaml           # Critical task fails, dependencies ripple
│   └── pull-the-plug.yaml         # Same as startup but with governance toggle
│
├── server/                        # Node.js backend
│   ├── index.ts                   # Entry point — starts WS server + sim
│   ├── ws.ts                      # WebSocket server (state push + command receive)
│   ├── runtime.ts                 # Simulation tick loop (orchestrates agents)
│   ├── agent-loop.ts              # Single-agent decision cycle (observe → decide → act)
│   ├── decision-space.ts          # Bounded action sets per role
│   ├── llm.ts                     # Claude API integration (pick action from options)
│   ├── scenario-loader.ts         # YAML → runtime config
│   ├── state.ts                   # Simulation state (positions, statuses, messages)
│   ├── protocol-tracer.ts         # Captures which validation layers fire per action
│   └── ungoverned.ts              # "Markdown vibes" mode — same agents, no SDK enforcement
│
├── src/                           # React frontend
│   ├── main.tsx                   # React entry
│   ├── App.tsx                    # Layout + routing
│   ├── store.ts                   # Zustand — sim state from WebSocket
│   │
│   ├── hooks/
│   │   ├── useSimulation.ts       # WebSocket connection + state sync
│   │   ├── useAgentSelect.ts      # Selected agent tracking
│   │   └── useScenario.ts         # Scenario selection + config
│   │
│   ├── world/                     # 3D scene (React Three Fiber)
│   │   ├── Scene.tsx              # R3F Canvas + lighting + environment
│   │   ├── Ground.tsx             # Ground plane + grid
│   │   ├── Environment.tsx        # Buildings, landmarks, props
│   │   ├── AgentModel.tsx         # Single agent — model + animation + status indicator
│   │   ├── AgentLabel.tsx         # Floating name + role label (Drei Html)
│   │   ├── SpeechBubble.tsx       # Floating message bubble (Drei Html)
│   │   ├── CommLine.tsx           # Animated line between communicating agents
│   │   ├── ProtocolBurst.tsx      # Visual burst when validation layer fires (block/allow)
│   │   └── CameraController.tsx   # Orbit controls + snap-to-agent
│   │
│   ├── ui/                        # 2D overlay panels
│   │   ├── TopBar.tsx             # Scenario name, time controls, "Pull the Plug" toggle
│   │   ├── ScenarioPicker.tsx     # Scenario selection screen
│   │   ├── AgentInspector.tsx     # Selected agent detail panel (budget, trust, tasks, reasoning)
│   │   ├── ChatPanel.tsx          # Send messages to agents
│   │   ├── ApprovalPopup.tsx      # Approval request that floats up from scene
│   │   ├── ProtocolStack.tsx      # 15-layer validation visualizer (green/red/orange per layer)
│   │   ├── TeamMetrics.tsx        # Live budget, trust, task completion bars
│   │   ├── EventLog.tsx           # Scrolling event timeline
│   │   ├── SplitScreen.tsx        # Side-by-side comparison wrapper
│   │   └── PoweredByBadge.tsx     # "Powered by ClawForce" branding
│   │
│   └── styles/
│       └── theme.ts               # Color tokens (match dashboard aesthetic)
│
└── public/
    └── models/                    # 3D assets (glTF/glb)
        ├── agent.glb              # Base character model
        └── environment/           # Building/prop models
```

---

## Chunk 1: Project Scaffolding + Scenario Engine

### Task 1.1: Initialize project

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.server.json`, `vite.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `index.html`, `.gitignore`

- [ ] **Step 1: Create project directory and package.json**

```bash
mkdir -p ~/workplace/clawforce-playground
cd ~/workplace/clawforce-playground
```

```json
{
  "name": "clawforce-playground",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "description": "Interactive 3D simulation environment for ClawForce agent teams",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
    "dev:client": "vite",
    "dev:server": "tsx watch server/index.ts",
    "build": "vite build",
    "sim": "tsx server/index.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.52.0",
    "@react-three/drei": "^9.120.0",
    "@react-three/fiber": "^8.17.0",
    "clawforce": "file:../clawforce",
    "concurrently": "^9.1.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "three": "^0.170.0",
    "ws": "^8.18.0",
    "yaml": "^2.8.0",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^25.3.2",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/three": "^0.170.0",
    "@types/ws": "^8.5.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create TypeScript configs**

`tsconfig.json` (frontend):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["node_modules", "dist", "server"]
}
```

`tsconfig.server.json` (backend):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist-server",
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["server/**/*.ts", "scenarios/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create Vite config with WebSocket proxy**

`vite.config.ts`:
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ws": {
        target: "ws://localhost:3200",
        ws: true,
      },
    },
  },
});
```

- [ ] **Step 4: Create Tailwind config (match dashboard theme)**

`tailwind.config.ts` — use the same `cf-*` color tokens as clawforce-dashboard for visual consistency.

- [ ] **Step 5: Create index.html entry point**

- [ ] **Step 6: Create .gitignore, init git**

```bash
git init
git add -A
git commit -m "feat: project scaffolding"
```

---

### Task 1.2: Scenario template format

**Files:**
- Create: `scenarios/schema.ts`

- [ ] **Step 1: Define scenario schema types**

```typescript
// scenarios/schema.ts
import type { WorkforceConfig } from "clawforce/internal";

/** A scenario template extends WorkforceConfig with simulation metadata */
export interface ScenarioTemplate {
  /** Scenario display name */
  name: string;
  /** Short description shown in picker */
  description: string;
  /** Which ClawForce capability this scenario highlights */
  showcase: (
    | "general"
    | "budget"
    | "trust"
    | "approvals"
    | "tasks"
    | "communication"
    | "safety"
    | "comparison"
  )[];
  /** Branded tagline */
  tagline: string;

  /** Agent workforce config (extends ClawForce WorkforceConfig) */
  workforce: WorkforceConfig;

  /** Simulation-specific settings */
  simulation: {
    /** Tick interval in ms (default 3000) */
    tickInterval?: number;
    /** Max ticks before scenario ends (default 100) */
    maxTicks?: number;
    /** Whether user can interact (send messages, approve) */
    interactive?: boolean;
  };

  /** Agent placement in 3D world */
  placement: Record<string, {
    /** Starting position [x, z] */
    position: [number, number];
    /** Location name (e.g., "Town Hall", "Engineering Bay") */
    location: string;
  }>;

  /** Decision spaces per role — bounded actions the LLM can choose from */
  decisions: Record<string, RoleDecisionSpace>;

  /** Chaos events that can be injected mid-simulation */
  chaos?: ChaosEvent[];

  /** For comparison scenarios: the "ungoverned" variant config */
  ungoverned?: {
    /** Markdown instructions that replace SDK enforcement */
    markdownVibes: Record<string, string>;
  };
}

/** Bounded action space for a role */
export interface RoleDecisionSpace {
  /** When agent has idle time */
  onIdle: DecisionOption[];
  /** When agent receives a task */
  onTaskReceived: DecisionOption[];
  /** When agent receives a message */
  onMessageReceived: DecisionOption[];
  /** When agent's work is reviewed */
  onReviewFeedback: DecisionOption[];
  /** When budget is running low */
  onBudgetPressure: DecisionOption[];
}

export interface DecisionOption {
  /** Action identifier */
  id: string;
  /** Human-readable description */
  label: string;
  /** What this action does (for LLM context) */
  description: string;
  /** SDK calls this action maps to */
  sdkCalls: string[];
  /** Cost estimate in cents (for LLM budget awareness) */
  estimatedCostCents?: number;
}

export interface ChaosEvent {
  /** Display name */
  name: string;
  /** What it does */
  description: string;
  /** SDK mutations to apply */
  mutations: ChaosMutation[];
}

export interface ChaosMutation {
  type: "slash_budget" | "kill_agent" | "inject_failure" | "disable_governance" | "enable_governance";
  params: Record<string, unknown>;
}
```

- [ ] **Step 2: Commit**

```bash
git add scenarios/schema.ts
git commit -m "feat: scenario template schema"
```

---

### Task 1.3: Scenario loader

**Files:**
- Create: `server/scenario-loader.ts`

- [ ] **Step 1: Build YAML loader that parses scenario templates**

Reads a YAML file, validates against ScenarioTemplate shape, resolves `workforce` config through ClawForce's `registerWorkforceConfig()`.

- [ ] **Step 2: Commit**

---

### Task 1.4: Built-in scenarios

**Files:**
- Create: `scenarios/startup.yaml`, `scenarios/budget-crisis.yaml`, `scenarios/trust-fall.yaml`, `scenarios/rogue-agent.yaml`, `scenarios/the-cascade.yaml`, `scenarios/pull-the-plug.yaml`

Each scenario should:
- Define 4-6 agents with roles, departments, titles
- Set realistic budgets
- Define goals and initial tasks
- Configure decision spaces per role
- Include agent placement coordinates
- Set the `showcase` field to the relevant capability

The **startup** and **pull-the-plug** scenarios should include `ungoverned.markdownVibes` with realistic markdown instructions that mirror what the SDK enforces.

- [ ] **Step 1: Create "The Startup" scenario (general showcase)**

5 agents (CEO, CTO, Designer, Developer, Marketer). Product launch. $50k budget. Decision spaces for each role covering task handling, budget decisions, communication.

- [ ] **Step 2: Create "Budget Crisis" scenario**

Same startup, but includes a chaos event at tick 20 that slashes budget 60%.

- [ ] **Step 3: Create "Trust Fall" scenario**

6 engineers. One (junior-dev) has a decision space weighted toward low-quality outputs. Trust system should catch and adapt.

- [ ] **Step 4: Create "Rogue Agent" scenario**

Standard team. One agent's decision space includes selfish options (hoard tasks, overspend, ignore messages). ClawForce protocols contain the damage.

- [ ] **Step 5: Create "The Cascade" scenario**

8 agents with task dependencies. A forced failure at tick 15 triggers the cascade through the state machine.

- [ ] **Step 6: Create "Pull the Plug" scenario**

Same as Startup but with `ungoverned` config. Starts governed, chaos button disables governance mid-sim.

- [ ] **Step 7: Commit all scenarios**

```bash
git add scenarios/
git commit -m "feat: 6 built-in scenario templates"
```

---

## Chunk 2: Agent Runtime + WebSocket Server

### Task 2.1: Simulation state

**Files:**
- Create: `server/state.ts`

- [ ] **Step 1: Define simulation state types**

```typescript
// server/state.ts

export interface SimulationState {
  /** Current tick number */
  tick: number;
  /** Is simulation running */
  running: boolean;
  /** Speed multiplier (1 = normal, 2 = 2x, 0.5 = slow-mo) */
  speed: number;
  /** Is governance enabled */
  governed: boolean;
  /** Active scenario name */
  scenario: string;

  /** Agent states */
  agents: Record<string, AgentState>;

  /** Recent protocol checks (for visualization) */
  protocolChecks: ProtocolCheck[];

  /** Recent events (for event log) */
  events: SimEvent[];

  /** Pending approvals */
  pendingApprovals: Approval[];

  /** Active communication lines */
  activeComms: CommLine[];
}

export interface AgentState {
  id: string;
  name: string;
  role: string;
  title: string;
  department: string;
  /** Position in 3D world [x, y, z] */
  position: [number, number, number];
  /** Movement target (agent walks toward this) */
  targetPosition: [number, number, number] | null;
  /** Current status */
  status: "idle" | "thinking" | "working" | "talking" | "blocked" | "disabled";
  /** Current task (if any) */
  currentTask: { id: string; title: string } | null;
  /** Latest reasoning from LLM */
  lastReasoning: string | null;
  /** Latest speech (for bubble) */
  lastSpeech: string | null;
  /** Speech bubble expiry tick */
  speechExpiresAt: number | null;
  /** Trust score 0-1 */
  trustScore: number;
  /** Budget remaining cents */
  budgetRemaining: number;
  /** Budget total cents */
  budgetTotal: number;
}

export interface ProtocolCheck {
  tick: number;
  agentId: string;
  action: string;
  /** Each of the 15 layers */
  layers: {
    name: string;
    status: "pass" | "block" | "skip" | "warn";
    reason?: string;
  }[];
  /** Overall result */
  allowed: boolean;
}

export interface SimEvent {
  tick: number;
  type: string;
  agentId?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface Approval {
  id: string;
  proposedBy: string;
  title: string;
  description: string;
  costCents?: number;
  riskTier: string;
  tick: number;
}

export interface CommLine {
  from: string;
  to: string;
  type: "message" | "escalation" | "task_assignment" | "approval_request";
  expiresAt: number;
}
```

- [ ] **Step 2: Commit**

---

### Task 2.2: Decision space engine

**Files:**
- Create: `server/decision-space.ts`

- [ ] **Step 1: Build the bounded decision selector**

Given an agent's current context (role, status, pending messages, current task, budget, trust), returns the applicable decision options from the scenario's decision space. The LLM picks from these options — it doesn't freeform.

```typescript
export interface DecisionContext {
  agentId: string;
  role: string;
  status: AgentState["status"];
  currentTask: AgentState["currentTask"];
  pendingMessages: number;
  budgetRemaining: number;
  budgetTotal: number;
  trustScore: number;
  tick: number;
}

export function getApplicableDecisions(
  ctx: DecisionContext,
  space: RoleDecisionSpace,
): { trigger: string; options: DecisionOption[] }
```

Logic:
- If agent has pending messages → `onMessageReceived`
- If agent has a task in REVIEW with feedback → `onReviewFeedback`
- If budget < 20% remaining → `onBudgetPressure`
- If agent has a new task → `onTaskReceived`
- Else → `onIdle`

- [ ] **Step 2: Commit**

---

### Task 2.3: LLM integration

**Files:**
- Create: `server/llm.ts`

- [ ] **Step 1: Build Claude API wrapper for bounded decision selection**

Takes: agent context + list of decision options.
Returns: selected option ID + short reasoning + optional speech text.

```typescript
export interface LLMDecision {
  /** Which option the agent chose */
  selectedOptionId: string;
  /** Brief reasoning (shown in agent inspector) */
  reasoning: string;
  /** What the agent "says" (shown in speech bubble) */
  speech: string | null;
}

export async function selectAction(
  agentContext: string,
  options: DecisionOption[],
  scenarioContext: string,
): Promise<LLMDecision>
```

Uses Claude Haiku for speed/cost. Structured output (tool_use) to get reliable JSON.

- [ ] **Step 2: Add fallback for no API key**

If `ANTHROPIC_API_KEY` is not set:
- Use deterministic random selection from decision options (seeded by agent ID + tick)
- Provide canned reasoning: `"Selected [option] (running without LLM — demo mode)"`
- Log warning to console: `"ClawForce Playground running in demo mode. Set ANTHROPIC_API_KEY for intelligent decisions."`

This ensures the playground is fully functional for demos without requiring API credentials.

- [ ] **Step 3: Commit**

---

### Task 2.4: Agent loop

**Files:**
- Create: `server/agent-loop.ts`

- [ ] **Step 1: Build the single-agent tick cycle**

```
observe (read state from SDK) → decide (LLM picks from bounded options) → act (execute via SDK) → update state
```

Each tick, one agent:
1. Observes: queries SDK for their tasks, messages, budget, trust
2. Gets applicable decisions from decision space
3. Calls LLM to pick an action
4. Executes the action through ClawForce SDK (which validates through 15 protocol layers)
5. Updates simulation state (position, status, speech bubble, etc.)
6. Returns protocol check results (which layers fired)

- [ ] **Step 2: Commit**

---

### Task 2.5: Protocol tracer

**Files:**
- Create: `server/protocol-tracer.ts`

- [ ] **Step 1: Build the protocol layer tracer**

Wraps ClawForce SDK calls to capture which validation layers fire. Uses SDK hooks (beforeTransition, beforeDispatch, onBudgetExceeded) plus direct checks to build a ProtocolCheck object for each action.

The 15 layers to trace and capture strategy:

**Direct Hook Wrapping** (hooks registered, return status):
1. SDK Hook (beforeTransition/beforeDispatch)

**Policy/Constraint Inspection** (call check functions, inspect results):
2. Policy Check (action_scope)
3. Policy Check (transition_gate)
4. Constraint Check (own_tasks_only)
5. Constraint Check (department_only)

**Risk Assessment** (query risk classifier before action):
6. Risk Classification
7. Risk Gate

**Budget Query** (cf.budget.check() before/after action):
8. Budget Check (time windows)
9. Budget Check (per-record)

**Safety Circuits** (call safety check functions directly):
10. Safety — Spawn Depth
11. Safety — Loop Detection
12. Safety — Circuit Breaker

**Rate/Concurrency** (query dispatch state):
13. Rate Limit
14. Concurrency Gate

**State Machine** (inspect transition validation):
15. Task State Machine

If a layer cannot be inspected directly via SDK, mark as "skip" with reason. Track gaps in `DOGFOOD.md` → feed back to SDK as tracing API needs.

Returns green/red/orange for each layer per action.

- [ ] **Step 2: Commit**

---

### Task 2.6: Ungoverned mode

**Files:**
- Create: `server/ungoverned.ts`

- [ ] **Step 1: Build the "markdown vibes" runtime variant**

Same agent loop, same LLM decisions, but:
- No ClawForce SDK calls for validation
- Budget is tracked but not enforced (agents see their budget in markdown instructions but nothing stops overspending)
- Tasks are created but state transitions aren't validated
- Trust is not tracked
- Approvals are not gated
- Messages send without rate limiting

The markdown instructions from the scenario's `ungoverned.markdownVibes` are injected into the LLM prompt instead. The LLM may or may not follow them.

- [ ] **Step 2: Commit**

---

### Task 2.7: Simulation runtime

**Files:**
- Create: `server/runtime.ts`

- [ ] **Step 1: Build the tick-based simulation orchestrator**

```typescript
export class SimulationRuntime {
  constructor(scenario: ScenarioTemplate, options?: { governed?: boolean });

  /** Start the simulation */
  start(): void;

  /** Pause */
  pause(): void;

  /** Resume */
  resume(): void;

  /** Set speed multiplier */
  setSpeed(multiplier: number): void;

  /** Toggle governance on/off ("Pull the Plug") */
  setGoverned(enabled: boolean): void;

  /** Inject user command */
  handleCommand(cmd: UserCommand): void;

  /** Get current state snapshot */
  getState(): SimulationState;

  /** Subscribe to state changes */
  onStateChange(cb: (state: SimulationState) => void): void;
}
```

Each tick:
1. Round-robin through agents (or priority-based: agents with pending messages go first)
2. Run agent-loop for each agent
3. Update simulation state
4. Emit state change to subscribers
5. Check end conditions (max ticks, all goals achieved, etc.)

For split-screen mode: two SimulationRuntime instances — one governed, one ungoverned — running in lockstep with the same random seed.

- [ ] **Step 2: Commit**

---

### Task 2.8: WebSocket server

**Files:**
- Create: `server/ws.ts`, `server/index.ts`

- [ ] **Step 1: Build WebSocket server**

Server → Client messages:
- `state_update` — delta state snapshot (only changed fields) to minimize bandwidth. Clients maintain local state and merge deltas. On reconnect, server sends full state once.
- `protocol_check` — validation layer results for an action
- `approval_request` — new approval needs human decision
- `event` — sim event for the log

Client → Server messages:
- `start` — start simulation with scenario name
- `pause` / `resume` — control playback
- `set_speed` — change tick speed
- `toggle_governance` — "Pull the Plug"
- `send_message` — user sends message to an agent
- `approve` / `reject` — user resolves an approval
- `inject_chaos` — trigger a chaos event
- `select_scenario` — switch scenario

- [ ] **Step 2: Build server entry point**

`server/index.ts` — starts WebSocket server on port 3200, accepts scenario selection, creates SimulationRuntime instances.

- [ ] **Step 3: Commit**

---

## Chunk 3: 3D World (React Three Fiber)

### Task 3.1: React app shell

**Files:**
- Create: `src/main.tsx`, `src/App.tsx`, `src/store.ts`

- [ ] **Step 1: Create React entry point and Zustand store**

Store mirrors SimulationState from server, updated via WebSocket. Provides actions for sending commands.

- [ ] **Step 2: Create App layout**

Two modes:
- **Scenario Picker** — shown when no sim is running
- **Simulation View** — 3D scene + UI overlays

- [ ] **Step 3: Commit**

---

### Task 3.2: WebSocket hook

**Files:**
- Create: `src/hooks/useSimulation.ts`

- [ ] **Step 1: Build WebSocket connection hook**

Connects to `ws://localhost:3200` (or proxied `/ws`). Parses incoming messages into Zustand store updates. Exposes `send()` for commands.

- [ ] **Step 2: Commit**

---

### Task 3.3: 3D Scene setup

**Files:**
- Create: `src/world/Scene.tsx`, `src/world/Ground.tsx`, `src/world/Environment.tsx`, `src/world/CameraController.tsx`

- [ ] **Step 1: Create R3F Canvas with lighting**

```tsx
// Scene.tsx
<Canvas shadows camera={{ position: [15, 15, 15], fov: 50 }}>
  <ambientLight intensity={0.4} />
  <directionalLight position={[10, 15, 10]} castShadow intensity={0.8} />
  <CameraController />
  <Ground />
  <Environment />
  {/* Agents rendered here */}
</Canvas>
```

- [ ] **Step 2: Create ground plane**

Low-poly ground with subtle grid. Receives shadows.

- [ ] **Step 3: Create environment**

Simple buildings/landmarks as colored boxes with labels. Positions come from scenario's `placement` locations. Low-poly aesthetic — clean shapes, flat colors, no textures needed.

Building types: Office, Workshop, Meeting Room, Server Room, etc. Each is a simple geometric composition (box + smaller box on top = building with roof).

- [ ] **Step 4: Create camera controller**

Orbit controls with bounds. Snap-to-agent feature (click agent → camera smoothly pans to them). Zoom limits to prevent going underground or too far out.

- [ ] **Step 5: Commit**

---

### Task 3.4: Agent rendering

**Files:**
- Create: `src/world/AgentModel.tsx`, `src/world/AgentLabel.tsx`, `src/world/SpeechBubble.tsx`

- [ ] **Step 1: Create agent model component**

Start with capsule geometry (cylinder + sphere top) colored by department. Animate:
- **Idle**: subtle float/bob
- **Thinking**: pulse glow
- **Working**: gentle spin
- **Talking**: scale pulse
- **Blocked**: red tint, stationary
- **Disabled**: grey, translucent

Trust score affects brightness/size — high trust = full brightness, low trust = dimmer, smaller.

Agent walks toward `targetPosition` using lerp each frame.

- [ ] **Step 2: Create floating label**

Drei `<Html>` positioned above agent. Shows name + role. Small trust bar underneath. Changes color based on status.

- [ ] **Step 3: Create speech bubble**

Drei `<Html>` positioned above label. Shows `lastSpeech` text. Fades out after `speechExpiresAt`. Styled like a chat bubble with agent's department color.

- [ ] **Step 4: Commit**

---

### Task 3.5: Communication visualization

**Files:**
- Create: `src/world/CommLine.tsx`, `src/world/ProtocolBurst.tsx`

- [ ] **Step 1: Create communication lines**

Animated line (or arc) between two agents when they're communicating. Color-coded:
- Blue: message
- Orange: escalation
- Green: task assignment
- Purple: approval request

Uses Three.js `Line` or `QuadraticBezierLine` from Drei. Particles or dashes moving along the line to show direction.

- [ ] **Step 2: Create protocol burst effect**

When a validation layer blocks an action: red burst particle effect at the agent's position. When an action passes all 15 layers: green shimmer. Quick, subtle, not overwhelming.

- [ ] **Step 3: Commit**

---

## Chunk 4: UI Panels

### Task 4.1: Top bar + scenario picker

**Files:**
- Create: `src/ui/TopBar.tsx`, `src/ui/ScenarioPicker.tsx`, `src/ui/PoweredByBadge.tsx`

- [ ] **Step 1: Create top bar**

Shows: scenario name, tick counter, speed controls (0.5x/1x/2x/5x), pause/play, **"Pull the Plug" toggle** (big red button that toggles governance). "Powered by ClawForce" badge.

- [ ] **Step 2: Create scenario picker**

Grid of scenario cards. Each shows: name, tagline, showcase badges (budget, trust, etc.), description. Click to start. "OpenClaw vs ClawForce" card is visually distinct (split design).

- [ ] **Step 3: Commit**

---

### Task 4.2: Agent inspector

**Files:**
- Create: `src/ui/AgentInspector.tsx`, `src/hooks/useAgentSelect.ts`

- [ ] **Step 1: Create agent selection hook**

Click agent in 3D scene → sets selected agent in store. Click empty space → deselects.

- [ ] **Step 2: Create agent inspector panel**

Slide-in panel showing:
- Agent name, role, title, department
- Current status + current task
- Trust score (bar + number)
- Budget (spent / total, bar)
- Last reasoning from LLM (the "brain" view)
- Recent messages sent/received
- Recent protocol checks for this agent

- [ ] **Step 3: Commit**

---

### Task 4.3: Chat + approvals

**Files:**
- Create: `src/ui/ChatPanel.tsx`, `src/ui/ApprovalPopup.tsx`

- [ ] **Step 1: Create chat panel**

Select an agent → type a message → sends via WebSocket → server delivers via `cf.messages.send()` → agent processes on next tick.

- [ ] **Step 2: Create approval popup**

When a pending approval exists, a styled popup rises from the bottom of the screen. Shows: who proposed it, what it is, estimated cost, risk tier. Two buttons: Approve (green), Reject (red) with optional feedback text.

Approval popup has subtle urgency — timer showing how long it's been pending.

- [ ] **Step 3: Commit**

---

### Task 4.4: Protocol stack visualizer

**Files:**
- Create: `src/ui/ProtocolStack.tsx`

- [ ] **Step 1: Create the 15-layer protocol visualizer**

A vertical stack of 15 labeled bars, one per validation layer. When an agent acts:
1. Each layer lights up in sequence (top to bottom, ~100ms each)
2. Green = passed, Red = blocked, Grey = skipped, Orange = warning
3. If any layer blocks → the remaining layers stay grey, the blocked one pulses red
4. Action result shown at the bottom: "ALLOWED" (green) or "BLOCKED: [reason]" (red)

This is the "packet through the firewall" visualization. It's the technical wow moment.

Layers shown:
```
1.  SDK Hook
2.  Policy: Action Scope
3.  Policy: Transition Gate
4.  Constraint: Task Ownership
5.  Constraint: Department
6.  Risk: Classification
7.  Risk: Gate
8.  Budget: Time Windows
9.  Budget: Per-Record
10. Safety: Spawn Depth
11. Safety: Loop Detection
12. Safety: Circuit Breaker
13. Rate Limit
14. Concurrency
15. State Machine
```

- [ ] **Step 2: Commit**

---

### Task 4.5: Team metrics + event log

**Files:**
- Create: `src/ui/TeamMetrics.tsx`, `src/ui/EventLog.tsx`

- [ ] **Step 1: Create team metrics bar**

Horizontal strip at bottom showing live:
- Total budget: spent/total (bar + percentage)
- Team trust: average trust score (bar + percentage)
- Tasks: completed/total (bar + count)
- Active agents: count with status dots
- Protocol blocks: count of blocked actions this session

- [ ] **Step 2: Create event log**

Scrollable timeline of sim events. Each entry: tick number, agent avatar dot, event description. Color-coded by type. Filter buttons: All, Decisions, Blocks, Messages, Tasks.

- [ ] **Step 3: Commit**

---

## Chunk 5: Split-Screen + Integration

### Task 5.1: Split-screen mode

**Files:**
- Create: `src/ui/SplitScreen.tsx`

- [ ] **Step 1: Build split-screen wrapper**

Side-by-side layout. Left: "OpenClaw" (ungoverned, markdown vibes). Right: "ClawForce" (governed, protocol-enforced). Each side has its own 3D scene + metrics bar. Shared top bar with sync controls.

Left side header: "OpenClaw — Markdown Vibes" with the actual markdown instructions visible in a collapsible panel.
Right side header: "ClawForce — Team Protocols" with the protocol stack visualizer.

Both simulations run from the same random seed, same LLM decisions where applicable. Divergence happens naturally when the governed side blocks an action that the ungoverned side allows.

A "divergence meter" shows how far apart the two simulations have drifted (based on budget delta, task completion delta, trust delta).

- [ ] **Step 2: Create divergence meter component**

Visual bar that grows from center. Left side (red) shows ungoverned metrics. Right side (green) shows governed metrics. The wider the gap, the more dramatic the visualization.

- [ ] **Step 3: Commit**

---

### Task 5.2: Wire everything together

**Files:**
- Modify: `src/App.tsx`, `src/store.ts`

- [ ] **Step 1: Connect WebSocket hook to store**

All incoming state updates flow into Zustand store. All user interactions dispatch commands through WebSocket.

- [ ] **Step 2: Wire 3D scene to store**

Agents read position/status/speech from store. CommLines read from store. Protocol bursts triggered by store updates.

- [ ] **Step 3: Wire UI panels to store**

Inspector reads selected agent from store. Chat sends through store actions. Approvals read/write from store. Protocol stack reads latest check from store.

- [ ] **Step 4: End-to-end test**

Start server + client. Select "The Startup" scenario. Verify:
- Agents appear in 3D scene at correct positions
- Agents make decisions each tick (speech bubbles appear)
- Communication lines animate between talking agents
- Protocol stack lights up per action
- Budget/trust/task metrics update live
- Click agent → inspector shows details
- Send message → agent responds next tick
- Approval popup appears when needed
- "Pull the Plug" toggle works
- Split-screen mode shows divergence

- [ ] **Step 5: Commit**

---

### Task 5.3: Dashboard bridge

**Files:**
- Create: `server/dashboard-bridge.ts` (optional)

- [ ] **Step 1: Verify dashboard can connect to same domain**

Since the server uses `Clawforce.init({ domain: "scenario-name" })`, the ClawForce Dashboard should be able to point at the same domain and show the same data. Verify by:
1. Starting the playground server
2. Starting the dashboard server pointing at the same data directory
3. Confirming tasks, agents, budget, events show up in both

This is the "flip to dashboard" demo moment. No new code needed if they share the same `setProjectsDir()` path — just verify and document.

- [ ] **Step 2: Commit**

---

### Task 5.4: Polish pass

- [ ] **Step 1: Smooth animations** — agent movement lerp, speech bubble fade, comm line lifecycle
- [ ] **Step 2: Loading states** — scenario loading, LLM thinking indicator
- [ ] **Step 3: Error handling** — no API key fallback, WebSocket reconnect
- [ ] **Step 4: Document "Pull the Plug" behavior**

When user clicks "Pull the Plug" toggle:
1. Both runtimes pause
2. Server switches the active runtime between governed (ClawForce SDK) and ungoverned (markdown vibes) mode
3. Both resume with current agent positions/state preserved
4. LLM seed is preserved so decisions align as much as possible

This is a scenario mode switch, not a real-time hook toggle. UI tooltip: "Switch between protocol-enforced and markdown-instruction-based coordination."

- [ ] **Step 5: "Powered by ClawForce" badge** on every screen
- [ ] **Step 5: Sound effects** (stretch) — subtle notification sounds for approvals, blocks, completions
- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: ClawForce Playground v0.1.0"
```

---

## Execution Notes

### Parallel Track Strategy

**Track A (Server)** — Tasks 2.1–2.8. No frontend dependencies. Can be tested with a simple WebSocket client or curl.

**Track B (3D World)** — Tasks 3.1–3.5. Uses mock data from store (no server needed). Can be developed with hardcoded agent positions and states.

**Track C (UI Panels)** — Tasks 4.1–4.5. Pure React components. Can be developed with mock store data. No 3D dependency.

**Track D (Integration)** — Tasks 5.1–5.4. Requires A, B, C complete. Wires everything together.

Recommended: dispatch Tracks A, B, C as parallel subagents. Then run Track D in the main session.

### SDK Dogfooding Notes

Building the playground will likely surface SDK API friction. Potential areas to watch:
- **State subscription**: Does the SDK support efficient state change notifications? May need to add event subscription for state changes.
- **Bulk queries**: Does querying all agent states, all tasks, all budgets in one tick perform well?
- **Protocol tracing**: The SDK doesn't currently expose which validation layers fired. May need to add a tracing/instrumentation API.
- **Ungoverned mode**: May need a way to disable specific protocol layers without removing the SDK entirely.

Track these in a `DOGFOOD.md` file and feed fixes back to the SDK.

### 3D Asset Strategy

Start with geometric primitives (capsules for agents, boxes for buildings). This is fast to build and looks clean with the right colors and lighting. If time allows, swap in Kenney character models and low-poly building packs for a more polished look. The component structure supports this — `AgentModel.tsx` can switch between capsule and GLTF model.

### LLM Cost Management

With 5-6 agents making decisions each tick (every 3 seconds), and Claude Haiku at ~$0.25/1M tokens, a 100-tick scenario costs roughly:
- ~100 ticks × 6 agents × ~500 tokens/decision = 300K tokens
- Cost: ~$0.08 per scenario run

Very affordable. Split-screen doubles it (~$0.16). Still trivial.
