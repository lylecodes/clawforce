# Clawforce Roadmap v2 — Autonomous Operations

> Last updated: 2026-03-08
> Builds on: ROADMAP.md (v1, mostly complete)

## Mantra

> **Define the mission and the budget. Your AI team handles the rest.**

## Vision

Clawforce evolves from a human-configured accountability layer into an autonomous operations platform. The human sets budget, priorities, and constraints. The manager agent handles everything else: scheduling, resource allocation, hiring/splitting agents, and optimizing throughput.

---

## Key Architectural Shifts

### 1. Collapse scheduled role
Cron is a trigger mechanism, not a role. Two roles only: **manager** and **employee**.
- Cron-triggered employee work auto-creates a task and flows through the normal employee lifecycle (evidence, verification, compliance)
- Cron-triggered manager work is a coordination cycle ("wake up and check on things")
- The `scheduled` role config becomes syntactic sugar for "employee with a cron trigger"

### 2. Initiatives as first-class concept
Named strategic priorities with allocation weights. Replaces arbitrary cron frequency configuration.
- Human defines: "UI improvements 40%, customer outreach 30%, maintenance 30%"
- Manager decides execution plan based on budget + priorities + historical cost

### 3. Budget-aware autonomous scheduling
Manager agents plan their own execution cycles. Human sets constraints, not schedules.
- Budget cascades down the org tree (human → top manager → sub-managers → employees)
- Each manager allocates its budget across initiatives and direct reports
- Rate limit awareness prevents throughput bottlenecks
- Historical cost data enables forecasting and optimization

### 4. Memory → skill promotion lifecycle
Memory is unstructured potential future skill. Valuable patterns get promoted.
- Frequently-retrieved memories → auto-promoted to SOUL.md or skill topics
- Wrong/outdated prompt knowledge → demoted to memory, prompt updated
- Periodic review (manager or cron) surfaces promotion candidates

### 5. Skill cap and organic org growth
Agents have a soft skill cap (~8). Exceeding it triggers a split.
- Manager notices performance degradation or skill count warning
- Creates a new specialist agent and redistributes skills
- Org grows organically based on actual workload, not upfront design

### 6. Strategic reflection (default manager behavior)
Managers get dedicated thinking time — not reacting to events, but proactively evaluating and optimizing.
- Default job on every manager (configurable frequency, default weekly)
- Reviews: team performance, budget efficiency, velocity trends, skill gaps, trust scores
- Outputs structural changes: rebalance budgets, hire/split agents, update skills, reprioritize initiatives
- This is where org evolution decisions happen — not in the heat of task execution
- User can configure frequency, briefing sources, and nudge text, or disable entirely

---

## Phase 6: Role Simplification

### 6.1 Collapse scheduled → employee + cron trigger

Remove `scheduled` as a distinct role. Cron becomes a property of any agent.

- Cron-triggered employee sessions auto-create a task before dispatch
  - Task title derived from job config (e.g. "Lead generation run — Mar 8")
  - Full employee lifecycle: evidence, verification, compliance check
- Cron-triggered manager sessions remain coordination cycles (no task creation)
- Migrate existing `role: scheduled` configs to `role: employee` with `jobs:` section
- Update profiles.ts: remove scheduled defaults, employee defaults apply
- Update context assembly: no special-casing for scheduled role
- Update skill topics: remove scheduled-specific documentation

### 6.2 Simplify role profiles

Two roles, two profiles. Clean separation.

- **Manager**: coordinates, delegates, reviews, allocates budget
  - Full operational context (task board, escalations, goals, budget, team status, etc.)
  - Expectations: log decisions, update planning docs
- **Employee**: executes tasks, reports results
  - Focused context (assigned task, memory, skills, pending messages)
  - Expectations: transition task, attach evidence, log outcome
- Assistant becomes a flavor of employee or manager via config, not a separate role
  - Standalone assistant = employee with no `reports_to` and human-facing briefing
  - EA/clerical = employee reporting to a manager with admin-focused skills

### 6.3 Default manager reflection job

Every manager gets a built-in `reflect` job — dedicated strategic thinking time.

- Ships as part of the manager role profile (not something the user has to configure)
- Default: weekly (configurable via `reflection_schedule` or overriding the job)
- Default briefing: team_performance, cost_summary, velocity, trust_scores, initiative progress
- Default nudge: "Review your team's performance. Consider: budget rebalancing, agent hiring/splitting, skill gaps, initiative reprioritization."
- Outputs: structural changes (budget adjustments, new agents, updated SOUL.md files, initiative weights)
- User can customize frequency, briefing, nudge, or disable with `reflection: false`
- This is NOT a coordination cycle — no task dispatch. Pure strategic thinking.

---

## Phase 7: Initiatives & Resource Allocation

### 7.1 Initiative model

Initiatives are goals with an `allocation` field — percentage of project daily budget. No separate entity.

```yaml
goals:
  ui-improvements:
    allocation: 40
    description: "Improve dashboard UX based on user feedback"
    department: engineering
  customer-outreach:
    allocation: 30
    description: "Daily lead generation and follow-ups"
    department: sales
```

- A top-level goal with `allocation` is an initiative — hard budget enforcement at dispatch
- Unallocated remainder = implicit reserve for ad-hoc work
- Dispatch gate walks task's goal hierarchy (parent-walking) to find root initiative
- Cost tracking per initiative (aggregate of all tasks under the goal tree)
- `initiative_status` briefing source shows allocation, spend, remaining per initiative

### 7.2 Resource config

Expose rate limits and model costs as context for manager planning.

```yaml
resources:
  daily_budget_cents: 2000
  reserve_percent: 20  # held back for reactive/unplanned work
  models:
    claude-opus-4-6:
      rpm: 60
      tpm: 200000
      cost_per_1k_input: 15    # in tenths of cents
      cost_per_1k_output: 75
    claude-sonnet-4-6:
      rpm: 120
      tpm: 400000
      cost_per_1k_input: 3
      cost_per_1k_output: 15
```

- Injected into manager briefing as a new `resources` context source
- Combined with historical cost data: "improvement sessions average $1.50, outreach averages $0.40"
- Manager can reason about: "I can afford N sessions of type X today"

### 7.3 Cascading budget allocation

Budget flows down the org tree. Each manager allocates to its reports.

- Human sets top-level project budget
- Top manager receives full budget, allocates across sub-managers and employees
- Sub-managers do the same recursively
- Allocation recorded in DB — auditable trail of budget decisions
- Budget enforcement already exists (spend limits) — this adds the planning layer on top
- Manager briefing shows: allocated vs. spent per direct report, remaining budget
- Over/under-spend across initiatives triggers rebalancing on next coordination cycle

### 7.4 Autonomous scheduling

Coordination agents plan their own dispatch cadence. No new scheduler infrastructure — context + enforcement.

- **Priority on goals** — P1-P4 field on goals (matching tasks), tells agents what to work on first
- **Historical cost averages** — new briefing data: "improvement sessions average 150c" so agents can plan session counts
- **Cost forecasting** — "at current burn rate, UI initiative exhausts budget by 3pm"
- **Pre-dispatch cost estimation** — estimate cost before creating a task based on historical initiative × agent × model data
- **Dispatch plans** — coordination agent creates a named plan for the cycle ("3 UI sessions, 2 outreach runs"), stored and tracked, reviewed at end of cycle (actual vs. planned)
- **Adaptive wake frequency** — coordination agents adjust their own cron schedule within configurable bounds. Busy = more frequent, idle = less. Default bounds on manager preset.
- **Rate-aware slot planning** — "you can run 2 Opus + 4 Sonnet sessions concurrently given current rate limits"
- All features ship as defaults on manager preset, configurable via:
  ```yaml
  agents:
    eng-lead:
      extends: manager
      scheduling:
        adaptive_wake: true
        planning: true
        wake_bounds: ["*/15 * * * *", "*/120 * * * *"]
  ```

---

## Phase 8: Memory & Knowledge Lifecycle

### 8.1 Memory promotion pipeline

Automatically surface frequently-used memories for promotion to structured knowledge.

- Track retrieval frequency per memory entry
- Periodic review (cron job or manager task): "these 5 memories retrieved 20+ times across 50 sessions"
- Promotion targets:
  - SOUL.md — if it's about the agent's identity/approach
  - Skill topic — if it's domain knowledge applicable to the role
  - Project docs — if it's project-level knowledge
- Manager (or dedicated knowledge agent) reviews and approves promotions
- Promoted knowledge removed from memory store (now lives in structured form)

### 8.2 Knowledge demotion

Reverse flow: structured knowledge that turns out wrong gets demoted.

- Agent discovers prompt/skill knowledge is incorrect during task execution
- Logs correction as memory entry ("tried X from SOUL.md, didn't work because Y")
- Flags the source knowledge for review
- Manager or knowledge agent reviews, updates or removes from prompt/skill
- Correction persists in memory as learned lesson

### 8.3 Skill cap enforcement

Soft cap on skills per agent. Triggers org growth when exceeded.

- Default cap: 8 skills per agent (configurable per project)
- When agent approaches cap, warning surfaced in manager briefing
- Manager decides: split the agent into two specialists, or defer
- Split workflow:
  1. Manager creates new agent config (new SOUL.md, subset of skills)
  2. Relevant memories migrated to new agent
  3. Tasks reassigned based on new skill boundaries
  4. Original agent's skills pruned
- Org grows organically — no upfront planning required

---

## Phase 9: Polish & Optimization

### 9.1 Context assembly optimization

Cache stable sources, only refresh dynamic ones per turn.

- Static (cache per session): SOUL.md, project_md, skills, policy_status, tools_reference
- Dynamic (refresh per turn): task_board, pending_messages, cost_summary, escalations
- Reduces per-turn DB query overhead without sacrificing freshness

### 9.2 Session length optimization

Shorter sessions = less context waste. Tune session boundaries.

- Employee: 1 session = 1 task (already the case)
- Manager: configurable max turns per coordination cycle
- Auto-end session after N turns, start fresh (compaction saves state between)
- Prevents context window bloat from ultra-long manager sessions

### 9.3 Cost forecasting accuracy

Improve manager's ability to predict session costs.

- Track actual cost per session type (initiative × agent × model)
- Moving average with confidence interval
- Manager briefing shows: "improvement sessions cost $1.50 ± $0.30"
- Enables tighter budget planning and less waste from over-reserving

---

## Phase Summary

### Phase 6: Role Simplification ✅
- [x] 6.1: Collapse scheduled → employee + cron trigger (scheduled is now a deprecated preset alias for employee)
- [x] 6.2: Simplify role profiles → config inheritance with `extends:` presets, merge operators (+/-), user-defined presets
- [x] 6.3: Default manager reflection job → builtin `reflect` job preset (weekly strategic thinking)

### Phase 7: Initiatives & Resource Allocation
- [x] 7.1: Initiative model (goals with allocation, hard dispatch gate)
- [x] 7.2: Resource config (rate limits, model costs as context) — budget system complete
- [x] 7.3: Cascading budget allocation (uniform agent tree budget flow)
- [ ] 7.4: Autonomous scheduling (manager plans own dispatch cadence)

### Phase 8: Memory & Knowledge Lifecycle ✅
- [x] 8.1: Memory promotion pipeline (frequently-retrieved → structured knowledge)
- [x] 8.2: Knowledge demotion (wrong prompt/skill → memory correction)
- [x] 8.3: Skill cap enforcement (soft cap, triggers org split)

### Phase 9: UX Overhaul

### 9.1 Minimal viable config

Config is overwhelming. A new user shouldn't need to know 28 context sources and 4 policy types to get started.

- Infer roles from structure: has `reports_to` children → manager, reports to someone → employee
- Default briefing, expectations, performance_policy from role profile (already exists — but make it so users almost never override)
- Default model per role: Opus for managers, Sonnet for employees
- Default cron schedule based on budget and workload (not user-specified)
- Minimal config:
  ```yaml
  name: my-project
  budget: $20/day
  mission: "Build and maintain a SaaS dashboard"
  agents:
    manager:
      title: Engineering Lead
    frontend:
      title: Frontend Developer
      reports_to: manager
    backend:
      title: Backend Developer
      reports_to: manager
  ```
- Everything else inferred. Power users can override anything.

### 9.2 Interactive setup

No guided onboarding exists. First experience is reading docs or a raw `explain` dump.

- `clawforce init` — interactive CLI flow: "What's your project? How many agents? Budget?"
- Generates `project.yaml` from answers
- Shows budget guidance: "Based on your team size, $20/day gives ~8-12 employee sessions"
- Optional: `clawforce init --from-description "I need a sales team with a manager and 3 reps"`

### 9.3 Config quality feedback

Validator checks schema, not strategy. Doesn't warn about missing best practices.

- Lint-style warnings beyond schema validation:
  - "Manager has no team_performance source — won't see employee metrics"
  - "Employee has no memory source — won't learn across sessions"
  - "No budget set — spending is uncapped"
  - "Agent X has 9 skills — consider splitting (cap: 8)"
- Run on `activate` and as a standalone `clawforce lint`
- Severity levels: error (blocks activation), warning (proceed with notice), info (suggestion)

### 9.4 Budget guidance

User sets `dailyLimitCents: 2000` with no idea if that's enough.

- Cost estimation based on: team size, model choices, expected session count, historical data
- On setup: "Recommended budget for this workload: $25/day"
- On activate: "At current rates, your budget supports ~10 employee sessions/day"
- In manager briefing: "Budget utilization: 72%. At current velocity, you'll exhaust budget by 3pm."

### 9.5 Config hot-reload

Config changes require re-activation. No diff preview.

- Watch `project.yaml` for changes (or explicit `clawforce reload`)
- Show diff: "Adding agent 'designer', changing manager cron from 30m to 15m"
- Apply without restart — re-register agents, update cron jobs, sync policies
- Rollback on failure: "Config invalid, keeping previous config"

### 9.6 Live actionable dashboard

Dashboard is basic HTTP routes. No real-time, no actions.

- Real-time updates via SSE/WebSocket
- Actionable: approve proposals, reassign tasks, adjust budgets, message agents, disable agents
- Views: org chart, task board, initiative progress, cost breakdown, timeline, agent performance
- Mobile-friendly (Telegram remains primary for quick approvals, dashboard for oversight)

### 9.7 Cron schedule automation

User manually decides cron frequency with no guidance.

- System determines manager wake frequency based on: budget, team size, workload volume, task velocity
- Employee dispatch cadence driven by manager decisions (not user-configured crons)
- User can override but shouldn't have to
- Adaptive: frequency increases during busy periods, decreases when idle

### 9.8 Data streams

Briefing sources are data streams — make them discoverable, parameterized, and composable.

- **Stream catalog** — `clawforce streams` shows all available sources with descriptions and sample output
- **Parameterized streams** — sources accept config: `{ source: "cost_forecast", horizon: "8h", granularity: "per_initiative" }`
- **Custom computed streams** — users define sources backed by SQL queries or aggregations over existing data
- **Stream routing** — same data streams power briefing, dashboard, webhooks, and alerts. One concept, multiple outputs.

### 9.9 Human onboarding

System onboards agents but not the user. No guided first experience.

- Post-activation welcome: "Your team is live. Here's what happens next..."
- Quick status via Telegram: "Your manager just woke up and created 3 tasks"
- First-week digest: "Week 1 summary: 12 tasks completed, $14.30 spent, 2 escalations"
- Guided intervention: "Your frontend agent failed 3 times on accessibility tasks. Options: add a skill, hire a specialist, adjust expectations"

---

### Budget System v2
- [x] BudgetConfigV2 types and normalization adapter (legacy -> v2)
- [x] V28 migration: token/request counters, window boundaries, reservations
- [x] Lazy self-healing window resets (hourly/daily/monthly)
- [x] O(1) counter-based budget check across all dimensions and windows
- [x] recordCost increments all 9 counters (3 windows x 3 dimensions)
- [x] Soft budget reservations for dispatch plans
- [x] Pre-flight plan validation with reservation lifecycle
- [x] Multi-day forecasting (daily snapshot, weekly trend, monthly projection)
- [x] Cascading budgets extended to all dimensions and windows
- [x] Dispatcher unified to single checkBudgetV2 call
- [x] Circuit breaker extended to tokens and requests
- [x] setBudget supports BudgetConfigV2 with all limit columns
- [x] Full budget v2 exports from index.ts

### Phase 10: Polish & Optimization
### Phase 9: UX Overhaul
- [x] 9.1: Minimal viable config (role inference, smart defaults)
- [x] 9.2: Interactive setup (`clawforce init` flow)
- [ ] 9.3: Config quality feedback (lint-style best practice warnings)
- [x] 9.4: Budget guidance (cost estimation, recommendations)
- [ ] 9.5: Config hot-reload (watch, diff, apply without restart)
- [ ] 9.6: Live actionable dashboard (real-time, approve/reassign/message from UI)
- [ ] 9.7: Cron schedule automation (system determines frequency)
- [x] 9.8: Data streams (catalog, parameterized sources, custom queries, multi-output routing)
- [x] 9.9: Human onboarding (welcome flow, first-week digest, guided intervention)

### Phase 10: Polish & Optimization
- [ ] 10.1: Context assembly optimization (cache static, refresh dynamic)
- [ ] 10.2: Session length optimization (max turns per cycle)
- [ ] 10.3: Cost forecasting accuracy (moving average with confidence)

### OpenClaw Thinning (Architectural)
- [x] Strip runtime config (model/provider) from Clawforce types
- [x] OpenClaw config reader for runtime data lookups
- [x] Config validation rejects runtime fields with migration message
- [x] Delegate memory flush timing to OpenClaw native memoryFlush
- [x] Import cron types from OpenClaw (delete redefinitions)
- [x] Unified channel delivery adapter (replace 3 setter patterns)
- [ ] Cost data: OpenClaw API primary, llm_output fallback (skipped — loadSessionCostSummary not exported from plugin-sdk)
