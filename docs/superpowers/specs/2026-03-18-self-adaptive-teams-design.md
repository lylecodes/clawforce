# Self-Adaptive Teams — Design Spec

## Overview

ClawForce becomes a self-adaptive agentic framework where users drop off an idea (DIRECTION.md) and a lean team of agents builds, ships, and evolves — hiring specialists, building infrastructure, and optimizing itself as needed. The system dogfoods itself: the first template is a team that builds ClawForce.

## 1. DIRECTION.md — The Mission File

A structured-but-flexible file that defines what the team is building. Accepts any level of detail — from a single sentence to a full spec. ClawForce fills the gaps.

**Schema (all optional except `vision`):**
```yaml
vision: "Build a SaaS for tracking rental compliance"
constraints:
  budget_daily_cents: 5000
  tech_stack: [Next.js, Postgres]
  timeline: "MVP in 2 weeks"
phases:
  - name: "Foundation"
    goals: ["Set up repo", "Auth system", "DB schema"]
  - name: "Core Features"
    goals: ["Property tracking", "Violation alerts"]
autonomy: low | medium | high  # trust tier starting point
```

When fields are omitted, the manager agent fills them in during its first reflection cycle, using the vision + template defaults.

**`autonomy` field initialization:** Maps to `applyTrustOverride()` on all agents at domain init. `low` = no overrides (default zero-trust start). `medium` = override all agents to medium tier. `high` = override all agents to high tier. Overrides decay naturally as real trust decisions accumulate and replace the synthetic starting point.

## 2. Setup Skill — `clawforce_setup_direction`

Extends the existing init flow (`src/config/init-flow.ts` — `getInitQuestions()`, `buildConfigFromAnswers()`). The current flow produces `GlobalConfig` + `DomainConfig`; this adds DIRECTION.md as a new artifact that feeds into config generation.

**Conversational flow:**
1. Ask for the vision (or accept a pasted doc)
2. Suggest a template (or let user pick)
3. Ask for constraints (budget, timeline, tech preferences) — or use template defaults
4. Generate DIRECTION.md + domain config YAML (via existing `buildConfigFromAnswers()` extended with direction fields)
5. Optionally start the runner immediately

**CLI equivalent:**
```bash
npx clawforce init                    # interactive
npx clawforce init --from idea.txt    # from file
npx clawforce init --template startup # skip questions, use defaults
```

Both paths produce the same artifacts: DIRECTION.md + config YAML. The existing `clawforce_setup` tool gains a `setup_direction` action for the conversational path.

## 3. Lean Starting Template — "startup"

The dogfood template. Ships with the minimum viable team:

```yaml
domain: clawforce-dev
template: startup
direction: ./DIRECTION.md

agents:
  lead:
    role: manager
    jobs:
      dispatch:
        cron: "*/5 * * * *"
        tools: [task_assign, task_create, budget_check, message_send]
      reflect:
        cron: "0 9 * * MON"
        tools: [org_modify, skill_create, budget_reallocate, agent_hire]
      ops:
        cron: "0 * * * *"
        tools: [health_check, message_send]
  dev-1:
    role: employee
    reports_to: lead
```

That's it. Two agents. The manager discovers what else it needs.

**New tools that need to be built** (do not exist in codebase yet):
- `agent_hire` — registers a new agent in the domain config, initializes trust/budget
- `org_modify` — change agent hierarchy (reports_to, role changes)
- `skill_create` — create a new skill definition (builds on existing memory→skill promotion in `src/memory/promotion.ts`)
- `budget_reallocate` — shift budget allocation between agents
- `budget_analyze` / `budget_forecast` — read budget trends, project future spend
- `health_check` — query monitoring/SLO status

Existing tools that map to config names: `task_assign` → `clawforce_task action:assign`, `task_create` → `clawforce_task action:create`, `budget_check` → `clawforce_ops action:budget_status`, `message_send` → `clawforce_message action:send`.

## 4. Job-Based Manager

Managers wear different hats at different times. Each job gets its own cron, tools, briefing sources, and budget allocation. This prevents cognitive overload — the manager isn't trying to do everything every tick.

**Implementation:** Already partially exists in `manager-cron.ts` and `resolveEffectiveConfig()`. Needs:

**A. `tools` field on `JobDefinition`** (new field in `src/types.ts`):
- Intersection semantics: job `tools` narrows the agent's full tool scope. If the agent has tools A, B, C, D and the job specifies [A, B], only A and B are available during that job.
- Integration point: `resolveEffectiveScopeForProject()` in `scope.ts` becomes job-aware — accepts optional `jobName` param, filters against job's tool list.
- If `tools` is omitted on a job, all agent tools are available (backward compatible).

**B. Job-specific briefing assembly:**
- Dispatch job injects: task board, pending assignments, blocked tasks
- Reflect job injects: velocity trends, trust score history, budget trajectory, skill gap analysis
- Ops job injects: health status, recent alerts, deployment state
- Uses existing `briefing` field on `JobDefinition` (already supported) to specify context sources

**C. Per-job budget tracking:**
- Add `job_name` column to cost tracking table
- `cf.budget.recordCost()` accepts optional `jobName` param
- `cf.budget.costSummary()` supports grouping by job
- `resolveEffectiveConfig()` passes job name through to the cost recording layer

## 5. Self-Adaptation — The Adaptation Toolkit

When something isn't working, the manager has multiple cards to play:

| Card | Example | Risk | Trust Required |
|------|---------|------|----------------|
| **Skill creation** | Create a "code-review" skill from repeated patterns | Low | Medium |
| **Budget reallocation** | Shift budget from idle agent to busy one | Low | Medium |
| **Process change** | Add approval gate, change tick frequency | Medium | Medium |
| **Agent hiring** | Spin up budget-ops, QA, infra-ops | Medium | High |
| **Agent splitting** | Overloaded agent → two focused agents | Medium | High |
| **Infra provisioning** | Set up monitoring, CI/CD, alerting | High | High |
| **Escalation** | Flag to human when stuck | None | Any |

**Trust-tiered autonomy** determines what requires approval. Trust score is computed as the weighted mean of per-category approval rates from `getAllCategoryStats()`, weighted by category decision count (more decisions = more weight). This produces a single 0-1 score per agent.

- **Low trust (score < 0.4):** Everything except escalation needs human approval. Manager proposes, human decides.
- **Medium trust (0.4-0.7):** Low-risk cards auto-approved. Medium/high-risk cards require approval.
- **High trust (score > 0.7):** Most cards auto-approved. Only novel/expensive decisions require approval.

Trust is per-agent, not per-team. The manager can be high-trust while a newly hired specialist starts at low.

## 6. Agent Builder — Experiment-Driven Hiring

A specialized agent that the manager delegates hiring to. It's an employee included in templates that want self-adaptation. The agent-builder is always registered but only wakes when the manager assigns it a hiring task — same as any other employee (no special activation mechanism needed).

**Phase 1 (this implementation): Manual hiring**
1. Manager dispatches hiring task: "Need an agent to monitor budget trends and flag anomalies"
2. Agent Builder designs an agent spec (role, skills, tools, briefing, expectations)
3. Agent Builder returns the spec to the manager
4. Manager hires via `agent_hire` tool (subject to trust-tiered approval)

**Phase 2 (future — separate spec): Experiment-driven hiring via `cf.evolve`**
The `cf.evolve` SDK namespace (sandbox creation, event replay, trial scoring) is a substantial subsystem that warrants its own design spec. Deferred — the Agent Builder works without it by proposing specs for human/manager approval. When `cf.evolve` ships later, the Agent Builder gains the ability to test variations before recommending.

## 7. Observe Pattern — Domain Specialists

When the manager hires a specialist, it assigns them an `observe` scope — a set of event types the agent monitors.

```yaml
budget-ops:
  role: employee
  reports_to: lead
  observe: [budget.exceeded, budget.warning, budget.reallocation]
  jobs:
    monitor:
      cron: "*/30 * * * *"
      tools: [budget_analyze, budget_forecast, message_send]
```

**Implementation:**

**A. New `observe` field on `AgentConfig`** (in `src/types.ts`):
- Array of event type patterns (supports wildcards: `budget.*`)
- Agent-level, not job-level — the agent's identity is "the one who watches budget"

**B. New briefing source: `observed_events`:**
- At each job tick, queries `cf.events.query()` for events matching the agent's `observe` patterns since last tick
- Injected into the agent's briefing alongside other context sources
- Added to `BriefingSource` union type in config schema

**C. Relationship to existing `event_handlers`:**
- `event_handlers` (project-level) triggers automated actions on events — fire-and-forget
- `observe` (agent-level) feeds events into an agent's reasoning loop — the agent decides what to do
- They are complementary: `event_handlers` for simple reactions, `observe` for intelligent monitoring

**D. Observer behavior:**
- Observers analyze and message the manager with recommendations
- Manager decides whether to act (keeps authority clear)
- Observer tools should include `message_send` for escalation, plus domain-specific analysis tools

## 8. Dashboard Concierge (Future)

An agent embedded in the dashboard UI with full ClawForce admin skills. Users configure their team conversationally through the dashboard. Uses the user's provider credentials. Deferred — not part of this implementation.

## Architecture Summary

```
User → DIRECTION.md (via setup skill or CLI)
  ↓
ClawForce Config (template + direction + constraints)
  ↓
Runner starts → Lead (manager) + Dev(s) (employees)
  ↓
Lead dispatches work, reflects weekly
  ↓
Lead identifies gaps → dispatches to Agent Builder
  ↓
Agent Builder designs agent spec → returns to Lead
  ↓
Lead hires specialist (approval if low trust)
  ↓
Specialist observes domain → messages Lead with insights
  ↓
Team evolves: more agents, better skills, tighter processes
```

## Dogfood Template: ClawForce Dev Team

The first real template. A team that builds ClawForce itself.

```yaml
domain: clawforce-dev
template: startup
direction: ./DIRECTION.md  # "Ship ClawForce v1"

agents:
  lead:
    role: manager
    jobs:
      dispatch: { cron: "*/5 * * * *" }
      reflect: { cron: "0 9 * * MON" }
  dev-1:
    role: employee
    reports_to: lead
  agent-builder:
    role: employee
    reports_to: lead
```

The lead will discover it needs budget-ops, QA, infra-ops through actual experience running the team. Each hiring decision tests the self-adaptation system.
