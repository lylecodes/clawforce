# Dashboard — Design Spec

> Last updated: 2026-03-14

## Overview

Full control plane for managing AI workforces. Dark theme, data-dense, organizational feel. Served from the OpenClaw gateway at `/clawforce` as a bundled React SPA. Multi-domain support with domain switcher. Real-time updates via SSE, actions via REST.

**Design principle:** Every action shows cost + consequence + risk level. No orphaned numbers. Users should feel confident they're not screwing things up.

**Mockups:** Saved in `.superpowers/brainstorm/` — Command Center, Org Chart, Task Board, Comms Center, Approval Queue, Config Editor (Agents + Budget tabs), Analytics.

---

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Framework | React SPA | Richest ecosystem for drag-and-drop, charts, real-time |
| Bundling | Bundled with Clawforce package | Zero additional setup, served as static files |
| Serving | `api.registerHttpRoute()` at `/clawforce` | Same gateway as OpenClaw Control UI (at `/`), complementary |
| Real-time | SSE (server→client) + REST (client→server) | Simpler than WebSocket, HTTP-native, auto-reconnect |
| Design | Dark theme, data-dense | Targets OpenClaw power users (terminal-native), screenshots pop on dark README |
| Multi-tenant | Domain switcher + "All Domains" aggregate | Domains = flexible abstraction (client, project, department, company) |
| Charts | Recharts or visx | React-native charting, supports bar/donut/line/area |
| Drag-and-drop | react-dnd or dnd-kit | Needed for: task reassignment, org chart reconfig, briefing builder, initiative sliders |
| State | React Query + SSE subscription | REST for mutations, SSE for live updates, React Query for cache/invalidation |

---

## API Layer

### Important: Domain = ProjectId

The dashboard uses "domain" in the UI but the entire backend uses `projectId`. These are the same thing. All API endpoints take `domain` as a path parameter which maps to `projectId` in core functions.

### Serving Approach

**The existing `src/dashboard/server.ts` is a standalone HTTP server (port 3117) with its own auth/CORS. This is REPLACED, not modified.** New approach:

1. Register routes via `api.registerHttpRoute()` on the OpenClaw gateway
2. New `src/dashboard/gateway-routes.ts` — request handler compatible with `registerHttpRoute`'s expected signature
3. Static files served at `/clawforce/*` (SPA with client-side routing)
4. API endpoints at `/clawforce/api/*`

**Prerequisite spike:** Verify `registerHttpRoute()` API signature from the plugin SDK before implementation. Register a trivial test route to confirm path, auth model, and request/response contract. If `registerHttpRoute` doesn't support the needed patterns, fall back to the standalone server approach (existing `server.ts` on a separate port).

### SSE Endpoint

`GET /clawforce/api/sse?domain={domainId}`

Pushes events:
- `budget:update` — spend changed (after every cost record)
- `task:update` — task state changed
- `agent:status` — agent became active/idle/stuck/disabled
- `approval:new` — new proposal pending
- `approval:resolved` — proposal approved/rejected
- `message:new` — new message in comms
- `plan:update` — dispatch plan created/completed
- `escalation:new` — escalation surfaced
- `meeting:started` — meeting began
- `meeting:turn` — agent spoke in meeting
- `meeting:ended` — meeting concluded
- `config:changed` — config saved/reloaded (for multi-tab sync)

### REST Endpoints — Reads

All read endpoints scoped by domain: `/clawforce/api/:domain/...`

```
GET /clawforce/api/:domain/dashboard        # Command center metrics
GET /clawforce/api/:domain/agents           # Agent list with status
GET /clawforce/api/:domain/tasks            # Task list, filterable by state/agent/initiative
GET /clawforce/api/:domain/tasks/:id        # Task detail with evidence/history
GET /clawforce/api/:domain/approvals        # Proposals, filterable by status
GET /clawforce/api/:domain/messages         # Message threads, filterable by channel/type
GET /clawforce/api/:domain/meetings         # Meeting list with status
GET /clawforce/api/:domain/meetings/:id     # Meeting transcript
GET /clawforce/api/:domain/budget           # Budget status (counters, reservations)
GET /clawforce/api/:domain/budget/forecast  # Forecast (daily snapshot, weekly trend, monthly projection)
GET /clawforce/api/:domain/trust            # Trust scores per agent per category
GET /clawforce/api/:domain/costs            # Cost records, filterable by agent/initiative/date
GET /clawforce/api/:domain/goals            # Goal hierarchy with initiative data
GET /clawforce/api/:domain/config           # Current config (read for editor)
GET /clawforce/api/:domain/org              # Org chart data (agents + reporting chains)
```

### REST Endpoints — Actions

```
POST /clawforce/api/:domain/approvals/:id/approve
POST /clawforce/api/:domain/approvals/:id/reject    { feedback? }
POST /clawforce/api/:domain/tasks/:id/reassign      { newAssignee }
POST /clawforce/api/:domain/tasks/create             { title, assignee, priority, goalId }
POST /clawforce/api/:domain/agents/:id/disable       { reason? }
POST /clawforce/api/:domain/agents/:id/enable
POST /clawforce/api/:domain/agents/:id/kill          { sessionKey }
POST /clawforce/api/:domain/agents/:id/message       { content }
POST /clawforce/api/:domain/config/save              { section, data }
POST /clawforce/api/:domain/config/validate          { section, data }
POST /clawforce/api/:domain/config/preview           { currentConfig, proposedConfig }
POST /clawforce/api/:domain/budget/allocate          { parentAgent, childAgent, allocation }
POST /clawforce/api/:domain/meetings/create          { name, participants }
POST /clawforce/api/:domain/meetings/:id/message     { content }
POST /clawforce/api/:domain/meetings/:id/end
```

**Config save/validate:** The `section` parameter specifies which config area (agents, budget, tool_gates, initiatives, jobs, safety). The `data` is the structured config for that section, not raw YAML. The backend merges it into the full config and writes YAML.

**Config preview:** Returns `ConfigChangePreview` with cost delta, consequence, and risk level. Requires server-side computation (historical data access).

**Kill endpoint:** Takes `sessionKey` in body (not just agent ID) because an agent can have multiple sessions.

These thin REST handlers call the existing Clawforce core functions (the same ones the ops-tool calls). No new business logic in the API layer.

---

## Views

### 1. Command Center (Home)

**Purpose:** Domain overview at a glance.

**Layout:**
- Top bar: Clawforce logo, domain switcher pills (colored, active highlighted), navigation tabs
- 4 metric cards: budget utilization (with exhaustion ETA), active agents, tasks in flight, pending approvals
- 3 initiative cards: allocation %, spend progress bar, task counts, active agents
- Bottom split: live activity feed (left 2/3), agent roster with status (right 1/3)

**Data sources:** Budget counters (O(1)), task counts, agent status, cost_records for activity feed.

**Real-time:** SSE pushes budget:update and task:update events. Activity feed auto-scrolls.

### 2. Org Chart

**Purpose:** Visual hierarchy with status overlay. Drag to reconfigure reporting lines.

**Layout:**
- Tree layout: top-down, centered
- Manager nodes: blue border, larger, show department and spend
- Employee nodes: green border, show team, trust score bar, spend
- Status indicators: green dot (active), orange (retry/warning), grey (idle), red ⊘ (disabled)
- Click agent → detail panel slides in from right with: stats grid (cost, trust, tasks, compliance), current task, action buttons (Message, Reassign, Disable)

**Interactions:**
- Drag agent node to new parent → updates `reports_to` → saves config
- Click agent → detail panel
- Double-click → navigate to Config Editor for that agent

### 3. Task Board

**Purpose:** Kanban view of all tasks. Drag to reassign.

**Layout:**
- 5 columns: Open, In Progress, Review, Blocked, Done (collapsed)
- Filter bar: by initiative (pills), agent (dropdown), priority (dropdown)
- Create Task button top-right
- Cards show: title, priority badge (P0 red, P1 orange), initiative color border, assigned agent avatar, cost

**Interactions:**
- Drag card between columns → state transition (with validation)
- Drag card to different agent in same column → reassign
- Click card → detail panel with evidence, history, linked goal
- Click agent avatar → navigate to Org Chart detail

### 4. Comms Center

**Purpose:** Message threads, escalation log, and live meeting mode.

**Layout:**
- Left sidebar (280px): thread list with tabs (Messages / Escalations / Meetings)
- Right panel: active conversation
- Active meetings show pulsing blue indicator
- Messages color-coded by agent role (blue = manager, green = employee, purple = user)
- User messages right-aligned, agent messages left-aligned

**Meeting mode:**
- User joins a channel and can message all participants simultaneously
- Participant avatars in header with role-colored borders
- "End Meeting" button
- Full transcript saved to audit

**Interactions:**
- Click thread → opens in right panel
- "New Meeting" button → select participants → starts meeting
- @mention in message input → tag specific agent
- Link task → reference a task in the message

### 5. Approval Queue

**Purpose:** Pending proposals with context, one-click approve/reject.

**Layout:**
- Collapsed single-line rows by default: risk badge, title, agent, category, time, inline ✓/✕ buttons
- Click to expand: full context (tool, category, task, initiative), action preview, larger action buttons, trust context
- Tabs: Pending (with count badge), Approved, Rejected
- Bulk "Approve All Low Risk" button

**Trust context bar:** Shows per-agent approval history for this action category. Suggests auto-approve when trust is high ("92% trust for calendar:create_event — Enable auto-approve").

**Interactions:**
- Inline ✓/✕ on collapsed row for quick decisions
- Expand for context before deciding
- "Edit & Approve" for high-risk items (modify the action before approving)
- "Enable auto-approve" link when trust threshold met

### 6. Config Editor

**Purpose:** Visual config editing. Drag-and-drop. Saves to YAML with hot-reload.

**Tabs:** Agents, Budget, Tool Gates, Initiatives, Jobs, Safety, Profile

**Agents tab:**
- Left sidebar: agent list with role indicators (blue dot = manager, green = employee), modification badges
- Right panel: form editor for selected agent
  - Editable fields: title, persona (textarea), reports_to (dropdown), department, team, channel
  - Briefing sources: draggable chips in "Active" zone and "Available" zone. Drag between them.
  - Expectations: list with add/remove
  - Performance policy: dropdowns (action, max_retries, then)
- YAML preview at bottom showing diff from preset defaults
- "Save & Apply" button with unsaved changes indicator

**Budget tab:**
- Operational profile selector: 4 cards (Low/Medium/High/Ultra) with summary and estimated cost
- Daily limits: sliders for cents, tokens, requests with live utilization overlay
- Hourly + Monthly: compact 3-column inputs
- Initiative allocation: stacked bar visualization + individual sliders with draggable handles, dollar equivalents
- Cost preview: three-bucket breakdown (Management / Execution / Intelligence) with expandable per-component detail

**Every config change shows:**
- Cost delta (how much more/less per day)
- Consequence (what actually changes in agent behavior)
- Risk level (LOW/MEDIUM/HIGH with explanation)

Historical data enriches consequences when available. Hardcoded descriptions as fallback for new installations.

**Tool Gates tab:**
- Grid: tools × risk tiers. Click cell to change tier.
- Categories grouped: Communication, Calendar, Financial, Code, Data

**Jobs tab:**
- List of jobs per agent with cron editor, enable/disable toggle
- Visual cron builder (instead of raw cron syntax)

**Safety tab:**
- Sliders for: circuit breaker multiplier, spawn depth, loop detection threshold
- Each shows current value, default, and consequence of change

### 7. Analytics

**Purpose:** Historical analysis — cost trends, agent performance, trust evolution.

**Layout:**
- Time range selector: Today / 7 Days / 30 Days / Custom
- 4-panel grid:
  - Daily cost bar chart (with week-over-week trend)
  - Cost by initiative donut chart with legend
  - Agent performance table (tasks, compliance %, cost, $/task — sortable)
  - Trust score bars with trend arrows (↑↓→)

**Data sources:** cost_records, audit_runs, trust_scores, task counts.

### 8. Initiative Deep Dive

**Purpose:** Per-initiative focused view. Accessed by clicking an initiative card on Command Center.

**Layout:**
- Budget: allocation vs spend, burn rate chart, forecast to exhaustion
- Task board: filtered to this initiative's goal tree
- Agents: who's working on this initiative, their status/performance
- Timeline: activity feed scoped to this initiative
- Goal tree: visual hierarchy of sub-goals with completion status

---

## Cost Preview Engine

The cost preview is a core feature that appears in:
- Config Editor Budget tab
- Profile selector
- Init wizard
- Any config change consequence preview

### Three-Bucket Breakdown

| Bucket | What's included | Why this grouping |
|--------|----------------|-------------------|
| **Management** | Coordination cycles, standups, reflection, dispatch planning | "What it costs to run the org" |
| **Execution** | Employee task sessions, verification | "What it costs to do the work" |
| **Intelligence** | Ghost recall, memory review, briefing assembly, search dedup, expectations injection | "What it costs to make agents smart" |

Each bucket expandable to show per-agent, per-component detail.

### Consequence + Risk on Every Change

```typescript
type ConfigChangePreview = {
  costDelta: number;           // cents/day change (positive = more expensive)
  consequence: string;         // human-readable description of what changes
  risk: "low" | "medium" | "high";
  riskExplanation: string;     // why this risk level
  historicalContext?: string;   // "last time this was changed, X happened" (when data available)
};
```

Risk levels:
- **LOW** — No observed impact on task completion or agent performance historically. Safe to change.
- **MEDIUM** — May affect response times or miss some learnings. Monitoring recommended.
- **HIGH** — Historical data shows direct impact on task failures, escalations, or cost overruns.

New installations with no history get hardcoded descriptions. After 1+ week of data, historical context enriches the preview.

---

## Frontend Structure

```
dashboard/
├── src/
│   ├── App.tsx                 # Router, layout, domain context
│   ├── api/
│   │   ├── client.ts           # REST client (fetch wrapper)
│   │   ├── sse.ts              # SSE subscription manager
│   │   └── types.ts            # API response types
│   ├── hooks/
│   │   ├── useDomain.ts        # Active domain context
│   │   ├── useSSE.ts           # SSE connection manager + event dispatch
│   │   ├── useBudget.ts        # Budget data + SSE updates
│   │   ├── useTasks.ts         # Task data + SSE updates
│   │   ├── useAgents.ts        # Agent status + SSE updates
│   │   ├── useApprovals.ts     # Approval queue + SSE updates
│   │   ├── useComms.ts         # Messages, threads, meetings + SSE updates
│   │   ├── useConfig.ts        # Config read/save/preview
│   │   └── useAnalytics.ts     # Cost trends, performance, trust scores
│   ├── views/
│   │   ├── CommandCenter.tsx
│   │   ├── OrgChart.tsx
│   │   ├── TaskBoard.tsx
│   │   ├── CommsCenter.tsx
│   │   ├── ApprovalQueue.tsx
│   │   ├── ConfigEditor.tsx
│   │   ├── Analytics.tsx
│   │   └── InitiativeView.tsx
│   ├── components/
│   │   ├── DomainSwitcher.tsx
│   │   ├── NavBar.tsx
│   │   ├── MetricCard.tsx
│   │   ├── InitiativeCard.tsx
│   │   ├── TaskCard.tsx
│   │   ├── AgentNode.tsx
│   │   ├── AgentDetailPanel.tsx
│   │   ├── ApprovalRow.tsx
│   │   ├── BriefingBuilder.tsx
│   │   ├── BudgetSlider.tsx
│   │   ├── CostPreview.tsx
│   │   ├── ChangeRiskBadge.tsx
│   │   ├── ActivityFeed.tsx
│   │   ├── ChatMessage.tsx
│   │   └── YamlPreview.tsx
│   └── styles/
│       └── theme.ts            # Dark theme tokens
├── public/
│   └── index.html
├── vite.config.ts
└── package.json
```

Build output goes to `dashboard/dist/` which gets served as static files from the Clawforce plugin's HTTP routes.

---

## Backend Changes

### New: SSE endpoint

`src/dashboard/sse.ts` — SSE connection manager. Subscribes to Clawforce events (task transitions, cost records, agent status changes) and pushes to connected clients.

### New: Action endpoints

`src/dashboard/actions.ts` — REST handlers for approve, reject, reassign, create task, disable agent, message agent, save config, etc. Thin wrappers around existing core functions.

### Replaced: server.ts → gateway-routes.ts

The standalone `server.ts` (port 3117) is deprecated. New `gateway-routes.ts` registers all routes via `api.registerHttpRoute()` at gateway_start:
- `/clawforce` → serve `dashboard/dist/index.html` (SPA fallback)
- `/clawforce/assets/*` → serve static files
- `/clawforce/api/:domain/*` → REST read + action endpoints
- `/clawforce/api/sse` → SSE endpoint

The old `server.ts` can be kept as a standalone fallback for non-OpenClaw deployments but is not the primary path.

### Modified: adapters/openclaw.ts

Wire SSE event emission into existing hooks:
- `after_tool_call` → emit task/budget events
- `agent_end` → emit agent status events
- Approval creation → emit approval events
- Message creation → emit message events

---

## Dependencies

- React 18+ with TypeScript
- Vite for build
- recharts or visx (charts)
- dnd-kit (drag-and-drop — lighter than react-dnd, better React 18 support)
- Existing Clawforce REST API (dashboard/routes.ts)
- OpenClaw gateway for HTTP route registration

## 100% UI-Configurable

The dashboard must support configuring EVERYTHING without touching YAML. Config Editor tabs:

| Tab | What it configures |
|-----|--------------------|
| Agents | Agent definitions, titles, persona, reports_to, department, team, channel |
| Budget | Daily/hourly/monthly limits (cents + tokens + requests), initiative allocation sliders |
| Tool Gates | Risk tiers per tool, gate actions, bulk thresholds |
| Initiatives | Goals with allocation %, priority, department assignment |
| Jobs | Per-agent job schedules, enable/disable, cron builder |
| Safety | Circuit breaker, spawn depth, loop detection, message rate |
| Profile | Operational profile selector (low/medium/high/ultra) with cost preview |
| Rules | Event trigger → action definitions (create_task, notify, escalate, etc.) |
| Event Handlers | User-defined event types and their action arrays |
| Memory | Memory governance: instructions (bool/string), expectations (bool), review config |

Additionally:
- **New Domain** flow accessible from domain switcher (+ button)
- **Domain settings** (name, paths, orchestrator) editable

---

## Clawforce Assistant Agent

A chat widget embedded in the dashboard — an actual Clawforce-managed agent that helps the user operate their workforce.

**What it does:**
- Answers questions: "Why did DevOps fail?" → searches audit logs, explains
- Takes actions: "Reassign that task to Backend" → calls the API
- Recommends: "Frontend has 45% trust for code:merge_pr — lower the approval tier?"
- Has full context: sees dashboard state, knows the config, understands the org

**Implementation:**
- Embedded OpenClaw chat session in a slide-out panel (bottom-right)
- Agent uses `assistant` preset with `clawforce_ops` and `clawforce_task` tools
- Runs on the user's model and API key (their budget)
- Tool gates on destructive actions (disable agent, kill session)
- Has memory — remembers past conversations with the user
- Is itself a Clawforce-managed agent with expectations and compliance

**Config:**
```yaml
# Auto-created when dashboard is enabled
agents:
  clawforce-assistant:
    extends: assistant
    title: Clawforce Dashboard Assistant
    persona: "You help the user manage their AI workforce through the Clawforce dashboard. You have access to all operational tools. Always explain what you're doing before taking actions."
    tools: [clawforce_ops, clawforce_task, clawforce_goal, memory_search]
```

This is Clawforce eating its own dog food — the control plane has its own AI assistant.

---

## Autonomous UI Review Skill

Post-launch: a skill that uses Playwright MCP to navigate every dashboard view, screenshot, check for bugs, and fix autonomously.

- Navigate all 8 views + config editor tabs
- Screenshot each state
- Check: layout broken? Empty states handled? Console errors? Interactions work?
- Click through key flows: approve a proposal, drag a task, expand an approval row
- Report issues with screenshots
- Fix → re-verify loop

Not part of the initial build — created after the dashboard ships as a QA tool.

---

## Non-Goals

- Mobile app (responsive web is fine)
- Real-time collaborative editing (single user per domain)
- Replacing OpenClaw's Control UI (complement, not replace)
- 3D visualizations (data-dense 2D is the aesthetic)

## Implementation Notes

- Build the API layer (SSE + actions) first — can be tested without frontend
- Then build views one at a time: Command Center → Task Board → Approval Queue (most useful first)
- Org Chart and Config Editor are the most complex (drag-and-drop) — save for later
- Analytics is pure read, no interactions — quick win
- Comms Center meeting mode requires `injectAgentMessage` integration — medium complexity
- Clawforce assistant agent is Phase 5+ — requires the chat interface from Comms Center
