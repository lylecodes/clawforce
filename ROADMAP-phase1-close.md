# Phase 1 Close-Out Roadmap

> Generated 2026-03-26 from system assessment. 7/17 exit criteria met, 5 partial, 5 not met.

## Status: What's Done

- All VISION.md core features implemented
- Telemetry pipeline: 718 sessions, 3626 tool calls, 164 config versions
- Experiment framework: 1 completed experiment (soul-verbosity)
- Code quality: 3240 tests, zero TODOs, TypeScript clean
- Trust scoring, budget enforcement, verification gates, auto-lifecycle all working
- 96 tasks completed by autonomous agents
- Verifier agents live and rejecting bad work (13% rejection rate)
- Workers on Codex ($0.06-0.50/task), leads on Sonnet (~$0.77/call)
- Compact context system with expand tool
- Isolated sessions, empty board backoff, consolidated re-dispatch

## Critical Path (blocks Phase 2)

### CP-1: Fix exercise cycle reliability
**Status:** 3 of last 6 exercises FAILED
**Problem:** New "health report" format fails intermittently. Old format worked (20+ consecutive). Likely task definition issue — vitest itself passes (3240 tests).
**Owner:** cf-lead
**Effort:** Small
**Action:** Diagnose failure pattern, fix task definition or agent handling

### CP-2: 1 week autonomous operation
**Status:** System has run ~5 days total, not 7 continuous
**Problem:** Time-gated. Can only be met by letting the system run undisturbed.
**Owner:** Nobody — just run it
**Effort:** Time (7 days)
**Dependency:** CP-1 (exercise cycles must be stable first)

### CP-3: Schema + config freeze
**Status:** Schema at V37, still changing (V37 added 2 days ago)
**Problem:** Phase 2 experiments require stable measurement infrastructure. Changing schema during experiments invalidates results.
**Owner:** Us (one-time decision)
**Effort:** Small
**Action:** Declare V37 final, add migration guard, freeze config schema

## High Priority (needed for complete Phase 1)

### HP-1: Onboard skill end-to-end
**Status:** Onboarding code exists but no proper skill wired
**Problem:** A new user can't bootstrap a ClawForce project without manual config
**Owner:** cf-worker
**Effort:** Medium
**Action:** Wire onboarding into a skill, test fresh project bootstrap

### HP-2: Fix Org Chart (landing page blank)
**Status:** ASSIGNED to dash-worker
**Problem:** The first thing users see is a blank dark screen
**Owner:** dash-worker
**Effort:** Small
**Action:** Fix tree-building when reportsTo chains don't resolve

### HP-3: Fix navigation order
**Status:** Not started
**Problem:** Sessions and Tool Calls before Command Center. Command Center should be home or index route.
**Owner:** dash-worker
**Effort:** Small
**Action:** Reorder tabs: Command Center, Org Chart, Tasks, Approvals, Comms, Analytics, Config, Sessions, Tool Calls, Experiments, Knowledge

## Medium Priority (polish for Phase 1 completeness)

### MP-1: Dashboard data table coverage
**Status:** 27 tables with no UI, 6 of those have actual data
**Problem:** Exit criteria says "every table surfaced"
**Owner:** dash-worker
**Effort:** Large (all 27) / Medium (6 with data)
**Pragmatic approach:** Surface the 6 tables with data: audit_log (3089 rows), audit_runs (781), enforcement_retries (14), onboarding_state (2), tracked_sessions (7), worker_assignments (6). Defer empty tables.

**Tables with data but no view:**
- audit_log / audit_runs → Audit History view
- enforcement_retries → Agent Detail panel addition
- onboarding_state → Wire to WelcomeScreen
- tracked_sessions → Sessions view enhancement
- worker_assignments → Tasks/Org view enhancement

**High-priority missing views (from dashboard UX audit):**
- task_dependencies → Dependency visualization in TaskBoard
- workflows → Workflow view (if workflows being used)
- risk_assessments → Risk detail in ApprovalQueue

### MP-2: API surface cleanup
**Status:** 99 modules with unused exports
**Problem:** Unclear public API vs internal. Dead export surface.
**Owner:** cf-worker
**Effort:** Medium
**Action:** Audit index.ts barrel, distinguish public from internal, trim

### MP-3: Resolve spec gaps
**Status:** 10/13 implemented, 2 deferred (Phase 3), 1 partial
**Specs not fully implemented:**
- clawprint-benchmark → Phase 3, defer
- claude-code-adapter → Partial, adapter dir exists but incomplete
- cron-removal → Hybrid approach, update spec to reflect reality
- onboard-skill → See HP-1

### MP-4: Dead code removal
**Status:** 99 modules flagged by ts-unused-exports
**Owner:** cf-worker
**Effort:** Medium
**Action:** Systematic audit. Many may be intentional public API.

## Cost Optimization (parallel track)

### CO-1: Reduce OpenClaw bootstrap for ClawForce agents
**Status:** bootstrapTotalMaxChars: 200000 (50k tokens injected per session)
**Action:** Set per-agent bootstrapMaxChars: 8000, bootstrapTotalMaxChars: 30000
**Savings:** ~45k tokens/session → $3-5/session saved on Opus, $0.50-1/session on Sonnet

### CO-2: Remove unnecessary bootstrap files from agent workspaces
**Status:** AGENTS.md, HEARTBEAT.md, IDENTITY.md, etc injected but not used
**Action:** Clean agent workspace dirs or add .bootstrapignore

### CO-3: Reduce tool schemas for workers/verifiers
**Status:** All 17+ OpenClaw tools registered for every agent
**Action:** Workers only need exec/read/edit/write/browser. Verifiers only need exec/read/browser.
**Savings:** ~1000-1500 tokens/call

## Research (Phase 2 preparation, parallel track)

### R-1: Adaptive context system
**Status:** Research doc saved at research/adaptive-context.md
**Concept:** Layered context depth — agents control how deep they go. Tool-driven expansion.
**Phase 2 experiment candidate:** Test different layer configurations

### R-2: Worker scaling policy
**Status:** Research doc saved at research/worker-scaling-policy.md
**Concept:** Leads hire/release workers based on queue depth, budget, velocity
**Implementation:** clawforce_scale tool, scaling guardrails, guidance injection

### R-3: Agent research platform
**Status:** Research doc saved in memory
**Concept:** Higher-level framework sits above ClawForce, tests prompt variants, measures outcomes
**Depends on:** Stable Phase 1 infrastructure + validated experiment framework

### R-4: First real experiment design
**Concept:** A/B test compact vs verbose task descriptions
**Measures:** Completion rate, rework rate, cost per task, time to complete
**Why:** Answers a real question that informs how leads should write tasks
**Depends on:** CP-1 (stable exercise cycles)

## Execution Plan

**Week 1 (now):**
- Fix exercise reliability (CP-1)
- Fix Org Chart (HP-2)
- Fix nav order (HP-3)
- Reduce bootstrap budget (CO-1)
- Let system run continuously

**Week 2:**
- If exercises stable → start 7-day clock (CP-2)
- Onboard skill (HP-1)
- Dashboard data coverage for 6 tables with data (MP-1)
- Schema freeze decision (CP-3)

**Week 3:**
- 7-day autonomous operation completes (CP-2)
- API cleanup (MP-2)
- Dead code removal (MP-4)
- Run first real experiment (R-4)

**Phase 1 exit:** End of week 3 if all criteria met.
**Phase 2 begins:** Immediately after, with experiment framework already validated.
