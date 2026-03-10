# Clawforce Roadmap

> Last updated: 2026-03-08

## What is Clawforce

Clawforce is the agentic operations layer for OpenClaw. OpenClaw is the runtime — Clawforce is the operating system on top: accountability, policy enforcement, task orchestration, compliance tracking, cost governance, memory, audit trails, and now — human-in-the-loop approval, multi-channel communication, and autonomous project advancement.

Roles that compose into any configuration:

- **Manager** — coordinates team, reviews work, escalates issues
- **Employee** — completes assigned tasks, reports back
- **Scheduled** — runs on cron, reports outcome
- **Assistant** — handles clerical/admin work with approval gates on external actions. Works standalone (personal assistant, human at top) OR within an org (executive assistant, reports to manager). Same role either way.

---

## Architecture Principles

1. **Leverage OpenClaw, don't reinvent it.** Use native cron, approvals, messaging (22+ channels), memory tools, agent spawning, cost tracking, and the `before_tool_call` hook. Clawforce adds workforce-level governance on top.
2. **Single throttle point.** All agent work flows through the dispatch queue. No bypass paths. Priority-based, budget-checked, risk-gated.
3. **Universal tool gating.** OpenClaw's `before_tool_call` hook intercepts ALL tool calls — MCP servers, native tools, clawforce tools. One hook gates everything.
4. **Telegram (and every channel) as control plane.** Users DM any agent, approve proposals, join meetings, get status — all via OpenClaw's native channel system.
5. **Configurable with opinionated defaults.** Safety rails, assignment strategies, approval tiers — all configurable per project, all ship with conservative defaults.

---

## Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Telegram integration | OpenClaw native (`sendMessageTelegram`, inline buttons, groups) | Already built, supports 22+ channels, no custom bot needed |
| Pre-tool gating | OpenClaw `before_tool_call` hook | Gates ALL tools universally, not just clawforce-wrapped tools |
| Approval system | Keep clawforce proposals; use ExecApprovalManager only for shell command gating | ExecApprovalManager is shell-command-level, not task-level. Different abstractions. |
| Cron/scheduling | Migrate to OpenClaw `CronJob` API | Persistence, timezones, delivery modes, run tracking |
| Agent spawning | Migrate to OpenClaw `sessions_spawn` | CLI spawn bypasses clawforce hooks — unaccountable workers. Must unify. |
| Dispatch bypass | Remove entirely | Everything queued — budget, risk, lease checks enforced uniformly |
| Assistant role | `role: assistant` — works standalone OR in org | Personal assistant and clerical/EA agent are the same role, different authority chain |
| Async approval | Re-dispatch pattern | Tool blocked → intent persisted → approved via Telegram → task re-dispatched with pre-approval |
| Auto-assignment | Framework + defaults | `workload_balanced` default, configurable strategies, manager can override |
| Goal model | Full hierarchy with cascade | CEO → dept → team → tasks, completion rolls up automatically |
| Integrations | Gate OpenClaw's native tools, don't rebuild | Map tool names → action categories → risk tiers in YAML |
| Safety limits | Configurable per project | Conservative defaults, power users can loosen |
| Agent comms | Full stack (DMs, protocols, channels, meetings) | Humans participate via Telegram, meetings mirrored to groups |

---

## Phase 0: OpenClaw Consolidation

Reduce tech debt. Stop reinventing OpenClaw primitives.

### 0.1 Migrate cron system

Refactor `src/manager-cron.ts` + `src/jobs.ts` to use OpenClaw's `CronJob` API.

- **Gain:** Persistence, timezone support, delivery modes (announce to channels), run status tracking
- **Keep:** State-aware nudge payload generation, clawforce-specific context assembly
- **Remove:** Custom interval-based scheduling

### ~~0.2 Migrate approval system~~ — DESCOPED

~~Refactor `src/approval/resolve.ts` to build on OpenClaw's `ExecApprovalManager`.~~

**Why descoped:** ExecApprovalManager is designed for shell command execution approval (`command`, `commandArgv`, `allow-once | allow-always | deny`). Clawforce proposals gate task-level actions with domain-specific metadata (risk tier, policy snapshot, task context). Different abstraction levels — forcing one onto the other creates a worse system.

The listed gains are covered elsewhere:
- Channel forwarding → Phase 1A.2 (Telegram integration)
- Cooldowns → sweep expiry (already works)
- Filtering → trivial SQL addition if needed
- Allowlist tracking → Phase 4B.1 (trust evolution)

The existing `src/approval/resolve.ts` is clean (4 functions, ~80 lines) and does its job. ExecApprovalManager will be used for its intended purpose (gating shell commands) via `before_tool_call` in Phase 0.3.

### 0.3 Add `before_tool_call` hook

Register OpenClaw's `before_tool_call` hook in the adapter for universal tool gating.

- Current `withPolicyCheck()` only wraps clawforce's own tools
- The hook intercepts ALL tool calls: MCP servers, OpenClaw native tools, everything
- Policy engine, risk classification, and approval gates apply universally
- Existing `withPolicyCheck()` becomes redundant for clawforce tools (but keep as defense-in-depth)

### 0.4 Migrate dispatcher to `sessions_spawn`

Replace `child_process.spawn("claude")` in `src/dispatch/spawn.ts` with OpenClaw's `sessions_spawn`.

The CLI spawn path creates **unaccountable workers** — agents that bypass clawforce entirely:
- No `before_prompt_build` → no context injection, no compliance tracking setup
- No `after_tool_call` → no per-tool compliance tracking
- No `agent_end` → no compliance enforcement, no retries/alerts
- Clawforce only sees raw stdout at the end — can't observe or govern the session

With `sessions_spawn`, every dispatched worker becomes a first-class clawforce-managed agent:
- Full hook lifecycle fires → context injection, compliance tracking, enforcement all work
- OpenClaw's subagent registry provides lifecycle tracking, parent-child relationships, discovery
- `subagent_ended` hook already wired for failure capture
- Cost tracking via OpenClaw's `SessionCostSummary` instead of parsing CLI JSON output

- **Gain:** Full accountability on dispatched workers, lifecycle tracking, subagent discovery, reliable cost tracking
- **Keep:** Queue-based throttling, budget/risk gates, lease management, retry context, task prompt building — all happen BEFORE spawn
- **Remove:** `dispatchClaudeCode()`, raw CLI subprocess management, stdout/stderr buffer handling, JSON output parsing, env filtering
- **Change:** Evidence capture moves from "parse CLI stdout" to hook-based tracking (more reliable)

---

## Phase 1: Foundation

Two parallel tracks.

### Track A: Approval + Channel Routing

#### 1A.1 Approval channel router

Route proposals and confirmations to the right channel based on agent config.

- Channels: inline (in-session), Telegram, Slack, Discord, dashboard, batch digest
- Activate the dormant `channel` field on `AgentConfig`
- Timeout → auto-reject or auto-escalate
- Channel configured per agent or per action category
- Built on OpenClaw's `ExecApprovalManager` (from Phase 0.2)

#### 1A.2 Telegram integration

Wire clawforce events to OpenClaw's native Telegram system.

- Proposals → `sendMessageTelegram()` with inline approve/reject buttons
- Multi-option decisions → `sendPollTelegram()`
- Button press callbacks → gateway method → resolve proposal
- Task completions, escalations, status changes → pushed to project Telegram groups
- Human messages from Telegram → `injectAgentMessage()` into agent sessions
- Agent addressability: user can DM any agent (CEO, CFO, assistant) via Telegram

Config:
```yaml
agents:
  ceo:
    channel: telegram
  assistant:
    channel: telegram
```

#### 1A.3 Pre-tool-use gate

Universal tool gating via OpenClaw's `before_tool_call` hook (from Phase 0.3).

- New `confirm` risk gate tier: quick inline yes/no (between auto-approve and full proposal)
- Async approval flow (re-dispatch pattern):
  - Tool call blocked → returns "pending approval" error to agent
  - Intent persisted: tool name, params, task context, agent ID
  - Approval request sent via channel router → Telegram/Slack/dashboard
  - On approval: action added to pre-approved allowlist, task re-dispatched through queue
  - Re-dispatched agent sees approval in context, re-attempts the tool call, which now passes
  - On rejection: task updated with rejection reason, agent notified next session
- Approval routed via channel router (1A.1) → delivered via Telegram/Slack/dashboard
- Tool gate mapping in project config:
  ```yaml
  tool_gates:
    "mcp:gmail:send": { category: "email:send", tier: high }
    "mcp:gcal:create_event": { category: "calendar:create_event", tier: medium }
    "mcp:github:merge_pr": { category: "code:merge_pr", tier: critical }
  ```

### Research: Google Workspace CLI ✅

**Findings (March 2026):** Google released `gws` (`@googleworkspace/cli`) on March 2, 2026. Key findings:

- **Built-in MCP server**: `gws mcp -s gmail,calendar,drive --tool-mode compact --sanitize`
- **Dynamic API coverage**: Reads Google's Discovery Service — auto-discovers new endpoints
- **Auth**: OAuth (interactive), service account + domain-wide delegation (agents), exported creds (CI)
- **Undo support**: Email send is **irreversible** (no API unsend). Calendar delete, Drive unshare — **fully reversible**.
- **Security**: `--sanitize` flag integrates with Google Cloud Model Armor for prompt injection protection
- **Status**: Pre-v1.0, "not officially supported", but backed by Google. Community alternative: `taylorwilsdon/google_workspace_mcp` (more mature)
- **Recommendation**: Use `gws mcp` for agent integration. Gate email:send with approval (irreversible). Calendar/Drive ops can be lower tier (reversible).

These findings informed the tool gate mapping and undo registry TTLs in Phases 3.3 and 4B.3.

### Track B: Automation + Throttle

#### 1B.1 Single throttle point

Route ALL work through the dispatch queue. No bypass paths.

- Convert `dispatch_worker` ops action to enqueue with priority 0 (immediate, but still gated)
- Route verification dispatches through queue instead of direct spawn
- Priority-based claiming: 0=critical, 1=high, 2=normal, 3=low
- Configurable concurrency limits per project and per agent
- Rate limiting: max dispatches per hour

#### 1B.2 Auto-dispatch on assignment

Close the gap where ASSIGNED tasks sit idle waiting for manual enqueue.

- Emit `task_assigned` event in `transitionTask()` when `toState === "ASSIGNED"`
- New event router handler: auto-enqueues the task in dispatch queue
- Uses assigned agent's profile/model settings from config
- Dedup prevents double-enqueue (already exists in queue)

#### 1B.3 Auto-assignment engine

Framework with configurable strategies and sensible defaults.

- New function `autoAssign(projectId, taskId)`
- Built-in strategies:
  - `workload_balanced` **(default)**: match by dept/team, pick agent with fewest active tasks
  - `round_robin`: rotate through available agents in department
  - `skill_matched`: match task tags to agent skills/tags
- Checks: agent not disabled, not budget-exhausted, not at max concurrent tasks
- Trigger: event router on task entering OPEN state, sweep backstop for orphaned OPEN tasks
- Config: `assignment_strategy: workload_balanced` in project YAML
- Manager can always override via `clawforce_ops reassign`

---

## Phase 2: Communication + Goals

### 2.1 Unified messaging system

All communication flows through one system: agent DMs, escalations, notifications, meeting messages.

- New `messages` table: id, from_agent, to_agent, project_id, channel_id, type, priority, content, status, created_at, read_at
- Message types:
  - `direct` — agent DMs another agent
  - `request` — structured protocol: expects response (with timeout)
  - `delegation` — structured protocol: assigns sub-work
  - `escalation` — system-generated: enforcement failure, retry exhaustion
  - `notification` — system-generated: status update, event alert
  - `meeting` — channel message during a meeting
- Messages queued, delivered at next session start via context injection (or mid-session via `injectAgentMessage()`)
- Read receipts / delivery confirmation
- New tool: `clawforce_message` with actions: send, list, read, reply
- **Replaces existing escalation mechanism** — enforcement system becomes a message sender (`type: escalation, priority: urgent`) instead of using a separate `injectAgentMessage()` path
- All message types mirrored to Telegram via channel router (one integration point)
- Full communication history (DMs, escalations, notifications, meetings) searchable in one dashboard log

### 2.2 Structured protocols

Typed interaction patterns for formal agent-to-agent coordination.

- Request/response: agent asks a question, other agent responds (with timeout)
- Delegation/report-back: assign sub-work, receive results
- Feedback/review: request review of work product
- Each protocol has typed message schemas and defined lifecycle
- Timeout → escalation on no response
- All protocol interactions audited

### ~~2.3 Goal decomposition model~~ ✅

Full goal hierarchy with completion cascade.

- New `goals` table: id, project_id, description, acceptance_criteria, status (active/achieved/abandoned), parent_goal_id, owner_agent_id, created_at, achieved_at
- Hierarchy: CEO goal → department sub-goals → team sub-goals → workflows → tasks
- When agent creates sub-goals, assigns them to department head agents
- Each agent decomposes their sub-goal into workflows/tasks autonomously
- Completion cascade: all child goals achieved → parent goal marked achieved
- Manager cron detects active goals with no plan → nudges decomposition
- New tool: `clawforce_goal` with actions: create, decompose, status, achieve, abandon
- Goal status visible in dashboard

### 2.4 Generic event-action router ✅

User-configurable event-to-action mapping. No hardcoded domain events — users define their own event types and handlers.

- Generic event-action router: "when event X fires, execute actions Y"
- Event types are user-defined strings — clawforce provides the machinery, not domain knowledge
- Each event maps to an **array of actions** — one event can trigger multiple responses:
  ```yaml
  event_handlers:
    ci_failed:  # user-defined event name
      - action: create_task
        priority: P1
        assign_to: auto
        template: "Fix CI: {{payload.test_name}}"
      - action: notify
        channel: telegram
        message: "CI failed: {{payload.test_name}}"
      - action: escalate
        to: manager

    deploy_finished:  # user-defined event name
      - action: create_task
        template: "Smoke test {{payload.environment}}"
  ```
- Built-in action types: `create_task`, `notify`, `escalate`, `enqueue_work`, `emit_event`
- Template interpolation: `{{payload.field}}` resolves from the event payload
- Webhook ingestion endpoint via dashboard HTTP or gateway method for external triggers
- Validation: warn on unknown action types, validate template syntax at config load

### 2.5 Review gate improvements

Fix the verification bottleneck.

- Make verifier agent configurable in project YAML (not just name pattern matching `/verifier|reviewer/i`)
- Auto-review timeout: if no verifier available, escalate after N hours (configurable)
- Allow self-review for low-risk tasks (configurable per project)
- Config:
  ```yaml
  review:
    verifier_agent: "reviewer"
    auto_escalate_after_hours: 4
    self_review_allowed: false
    self_review_max_priority: P3
  ```

---

## Phase 3: Meetings + Assistant

### 3.1 Agent channels & meetings

Topic-based channels with meeting mode. Mirrored to Telegram.

- New `channels` table: id, project_id, name, type (topic/meeting), members, created_at
- **No separate `channel_messages` table** — channel messages are rows in the unified `messages` table (from 2.1) with `channel_id` set. One message store, one query surface, one dashboard.
- Agents join channels based on role/department/team (configurable)
- All agents in a channel see all messages (injected into their context at session start)
- **Meeting mode** (simplified round-robin standup first):
  - Manager initiates meeting, specifies participants
  - Each agent turn = one dispatch through the queue (consistent with single-throttle-point principle)
  - Agent context includes full channel transcript so far + "report status, raise blockers" prompt
  - Agent responds → response added to channel → next agent dispatched
  - Manager dispatched last: summarizes and creates action items as tasks
  - Meeting transcript saved as audit entry
  - Full transcript mirrored to Telegram group
  - A 5-agent standup = 5 sequential dispatches — fine for async standups, not designed for real-time chat
- Human participation: messages from Telegram injected into meeting channel
- New tool: `clawforce_channel` with actions: create, join, leave, send, list, start_meeting

### 3.2 Assistant role

New `role: assistant` — works in BOTH contexts:

- **Personal assistant** (standalone): human is the authority, no manager above. User interfaces via Telegram DM.
- **Clerical/EA agent** (in team): reports to a manager, handles admin work for the org. Same approval gates, same tool gating — but authority flows from the manager, not the human directly.

The role is the same either way. The only difference is who's at the top of the chain:
- Standalone: human → assistant
- In org: human → CEO → executive assistant (assistant role)

Capabilities:
- No fixed expectations (user/manager-driven, not compliance-driven)
- Briefing sources: user preferences, pending approvals, recent activity, schedule
- Performance tracked via approval/rejection/undo rates (not compliance metrics)
- Approval gates on all external-facing actions (email, calendar, purchases, etc.)
- Addressable via Telegram DM or any configured channel
- Uses same policy engine, audit trail, memory, dispatch as all other roles

### 3.3 Approval gates on OpenClaw tools ✅

Gate external tools for assistant role and any agent where configured.

- `before_tool_call` hook (from Phase 0.3) classifies tool calls against `tool_gates` config
- Built-in gateable action categories (`src/risk/categories.ts`):
  - Communication: `email:send`, `email:forward`, `message:send`, `social:post`
  - Calendar: `calendar:create_event`, `calendar:cancel_event`, `calendar:reschedule`
  - Financial: `financial:purchase`, `financial:transfer`, `financial:subscribe`, `financial:pay_bill`
  - Code: `code:merge_pr`, `code:deploy`, `code:push`, `code:release`
  - Data: `data:delete`, `data:share`, `data:permission_change`
  - Booking: `booking:create`, `booking:cancel`, `booking:modify`
  - Bulk: sliding-window detector (`src/risk/bulk-detector.ts`) — counts recent calls per category per agent, escalates tier when threshold exceeded
- Risk tier → gate action mapping: `none` (allow), `delay`, `confirm` (quick yes/no), `approval` (full proposal), `human_approval` (block)
- Per-tool `gate` override allows decoupling gate action from tier
- Config validation for tool gates and bulk thresholds
- Approval routed through channel router → Telegram/Slack/dashboard
- Informed by Google Workspace CLI research (email irreversible, calendar/drive reversible)

---

## Phase 4: Intelligence

Two parallel tracks: project-level intelligence and assistant-level intelligence.

### Track A: Project Intelligence

#### 4A.1 Task dependency DAG

Fine-grained task dependencies beyond sequential workflow phases.

- New `task_dependencies` table: task_id, depends_on_task_id, type (blocks/soft)
- On task completion → query dependents → auto-unblock (BLOCKED → OPEN)
- Coexists with workflow phases: phases = coarse ordering, deps = fine-grained
- Visualized in dashboard as dependency graph

#### 4A.2 Structured planning protocol (OODA)

OODA loop for manager sessions. **Prerequisite for 4A.3 (adaptive re-planning).**

- Prompt template guides manager through: **Observe** (current state) → **Orient** (compare to goals) → **Decide** (highest-impact action) → **Act** (execute via tools) → **Record** (save rationale)
- Delta-aware progress reports: what changed since last wake, not just snapshot
- Planning rationale saved as audit entries for accountability
- Cross-session planning memory: manager retains strategic context across cron wakes

#### 4A.3 Adaptive re-planning

Intelligent failure recovery instead of just retrying. Uses the OODA protocol (4A.2) for structured analysis.

- When `retry_exhausted`: gather all evidence from failed attempts, emit `replan_needed` event
- Manager cron receives as high-priority item with failure analysis
- Manager uses OODA loop to analyze failure evidence and decide next action
- Option for dedicated planning agent to analyze and create alternative tasks
- Re-plan history tracked to prevent infinite loops
- Configurable: `replan_strategy: manager | planning_agent | escalate_human`

#### 4A.4 Completion detection + project lifecycle

Know when the project is done. (Goal cascade logic already shipped in 2.3.)

- When workflow completes → check associated goal's acceptance criteria
- Create verification task if criteria exist
- Stop or reduce manager cron frequency when all project goals achieved
- Notify via Telegram when top-level goal is achieved
- Project-level "done" state: all top-level goals achieved → project marked complete

#### 4A.5 Velocity tracking

Data-driven planning decisions.

- Tasks completed per hour/day with trend direction
- Phase completion ETA based on current velocity
- Blocker impact analysis: which blocked tasks hold up the most downstream work
- Cost trajectory vs budget projection
- Included in manager cron nudge payload for data-driven decisions
- Visible in dashboard as real-time progress charts

### Track B: Assistant Intelligence

#### 4B.1 Trust evolution

Earned autonomy for assistant mode.

- Track approval/rejection/undo rates per action category
- Suggest tier adjustments: "47 approvals, 0 rejections → auto-approve routine replies?"
- Never auto-evolve financial/security categories without explicit user opt-in
- Trust decay: if no activity in category for N days, reset to default tier
- Trust scores visible in dashboard

#### 4B.2 Preference store

Structured user preferences for assistant mode.

- Categories: scheduling, communication tone, financial rules, notification preferences
- Sources: explicit ("never before 10am"), learned (pattern detection), inferred (confidence-scored)
- Injected into context via new `preferences` briefing source
- Preferences editable via Telegram commands or dashboard
- Note: learned/inferred sources require history to learn from — early on this is mostly explicit preferences, ML-like aspects come online gradually

#### 4B.3 Undo registry

Reversibility for assistant mode actions.

- Every executed action registers an undo handler with TTL
- User says "undo the last email" → system looks up most recent `email:send` and executes undo
- Undo status: available, expired, executed, not_available
- Dashboard shows recent actions with undo buttons
- Undo window configurable per action category
- Depends on underlying tools supporting undo (Gmail unsend, calendar delete, etc.) — informed by Google Workspace CLI research (Phase 1)

---

## Phase 5: Polish + Configuration

Phase 5 is the configuration, documentation, and UI polish pass. Core safety checks and gateway methods ship with the phases that need them — Phase 5 makes them user-configurable and visible.

### 5.1 Dashboard enhancements

Catch-all for dashboard features not already shipped alongside their backend:

- Approval queue: pending proposals with approve/reject buttons
- Action history: recent executed actions with undo buttons (assistant mode)
- Trust scores: visualization per action category (assistant mode)
- Progress dashboard: velocity charts, ETA, blocker analysis
- Goal tracking: hierarchy view with completion percentages
- Meeting transcripts: searchable archive
- Communication log: unified message history (DMs, escalations, notifications, meetings)
- Org chart: reporting chains with agent status overlay

Note: many of these ship incrementally with their backend (e.g., velocity charts with 4A.5, trust scores with 4B.1). This item covers remaining gaps and visual polish.

### 5.2 OpenClaw gateway consolidation

Essential gateway methods ship with their feature phases:
- Proposal delivery + approval ingestion → Phase 1 (1A.1, 1A.2)
- Event webhook ingestion → Phase 2 (2.4)

Phase 5 covers:
- Dashboard SSE/WebSocket for real-time updates
- Consolidate and document the full gateway API surface
- Any remaining gateway methods not already registered

### 5.3 Safety configuration surface ✅

Core safety checks ship with the phases that need them:
- `max_concurrent_dispatches` → already exists in `dispatch` config
- `max_tasks_per_hour` → already exists in `dispatch.agent_limits`

Phase 5 adds a unified `safety` section for remaining guardrails:

```yaml
safety:
  max_spawn_depth: 3            # levels of agent-spawning-agent (default: 3)
  cost_circuit_breaker: 1.5     # multiplier of budget before pause (default: 1.5)
  loop_detection_threshold: 3   # same task title failed N times → block (default: 3)
  max_concurrent_meetings: 2    # per project (default: 2)
  max_message_rate: 60          # messages per minute per channel (default: 60)
```

Implementation (`src/safety.ts`):
- `checkSpawnDepth()` — walks goal/task hierarchy, enforced at dispatch
- `checkCostCircuitBreaker()` — percentage-based budget pause, enforced at dispatch
- `checkLoopDetection()` — detects repeated task title failures, enforced at dispatch
- `checkMeetingConcurrency()` — enforced in `startMeeting()`
- `checkMessageRate()` — in-memory sliding window, enforced in `createMessage()`
- Config validation in `config-validator.ts` with type and range checks
- Conservative defaults applied when no config specified

### 5.4 Configuration reference documentation

Comprehensive documentation of all user-configurable surfaces. Covers everything built across all phases.

- **Workforce config** (`workforce.yaml`): agents, roles, departments, teams, tool lists, models, approval policies
- **Enforcement config** (`enforcement.yaml`): compliance rules, failure actions, SLO targets, alert rules
- **Action scopes**: per-role tool permissions, custom overrides, wildcard vs restricted access
- **Event handlers**: user-defined event types, action arrays, template interpolation syntax
- **Tool gates**: external tool risk classification, approval tiers, category mapping
- **Job definitions**: scoped sessions, cron schedules, department/team filtering
- **Safety limits**: all configurable knobs with defaults and rationale
- **Goal hierarchy**: goal lifecycle, cascade rules, decomposition patterns
- **Messaging**: message types, protocol lifecycles, notification routing
- **Context sources**: all available briefing sources, per-role defaults, custom content injection
- **Assignment strategies**: built-in strategies, configuration, override mechanisms
- **Review config**: verifier agent, auto-escalate timeout, self-review rules
- Format: single reference doc (or structured set) shipped with the package, not just code comments

---

## Phase Summary

### Phase 0: OpenClaw Consolidation
- [x] 0.1: Migrate cron → OpenClaw CronJob API
- [-] 0.2: ~~Migrate approvals~~ — descoped (wrong primitive)
- [x] 0.3: Add `before_tool_call` hook for universal tool gating
- [x] 0.4: Migrate dispatcher spawning → OpenClaw `sessions_spawn`

### Phase 1: Foundation (parallel tracks)

**Track A: Approval + Telegram**
- [x] 1A.1: Approval channel router
- [x] 1A.2: Telegram integration
- [x] 1A.3: Pre-tool-use gate (confirm tier, async re-dispatch approval)

**Research**
- [x] Google Workspace CLI investigation

**Track B: Automation + Throttle**
- [x] 1B.1: Single throttle point (remove all bypasses)
- [x] 1B.2: Auto-dispatch on assignment
- [x] 1B.3: Auto-assignment engine

### Phase 2: Communication + Goals
- [x] 2.1: Async message passing (agent DMs)
- [x] 2.2: Structured protocols (request/response, delegation)
- [x] 2.3: Goal decomposition model (full hierarchy)
- [x] 2.4: Generic event-action router (user-defined events + actions)
- [x] 2.5: Review gate improvements

### Phase 3: Meetings + Assistant
- [x] 3.1: Agent channels & meetings (Telegram mirror, human participation)
- [x] 3.2: Assistant role (standalone personal assistant)
- [x] 3.3: Approval gates on OpenClaw tools (tool gate mapping)

### Phase 4: Intelligence (parallel tracks)

**Track A: Project Intelligence**
- [x] 4A.1: Task dependency DAG
- [x] 4A.2: Structured planning protocol (OODA)
- [x] 4A.3: Adaptive re-planning (depends on 4A.2)
- [x] 4A.4: Completion detection + goal cascade
- [x] 4A.5: Velocity tracking

**Track B: Assistant Intelligence**
- [x] 4B.1: Trust evolution
- [x] 4B.2: Preference store
- [x] 4B.3: Undo registry

### Phase 5: Polish + Configuration
- [ ] 5.1: Dashboard enhancements (incremental — gaps + visual polish)
- [ ] 5.2: OpenClaw gateway consolidation (SSE/WebSocket, API docs)
- [x] 5.3: Safety configuration surface (YAML config with enforcement)
- [ ] 5.4: Configuration reference documentation (all user-configurable surfaces)

---

## Status Key

- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete
- `[-]` Descoped or deferred
