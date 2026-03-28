# ClawForce Milestones

> "Set the direction. Set the budget. Your AI team handles the rest."

ClawForce is a framework for autonomous agent teams. The goal is a product
people download and use because it works out of the box — with defaults
backed by real data, not guesses.

## Where We Are

ClawForce is dogfooding itself. Five agents across two teams (core SDK +
dashboard) develop ClawForce autonomously within a single domain. The
governance loop works: auto-lifecycle, verification gates, git isolation,
telemetry, experiments.

3,186 tests passing. TypeScript compiles clean. Two codebases under
autonomous development.

## Phase 1: Production-Ready (current)

ClawForce builds itself to the point where it's a stable, complete product.
Exit criteria are strict because Phase 2 requires a stable infrastructure —
changing the measurement system during experiments invalidates results.

### Exit Criteria (ALL required)

**Stability**
- 20 consecutive clean cycles across both teams
- Sustained autonomous operation with zero human intervention needed to unblock agents
- Zero unhandled errors in gateway logs during autonomous operation
- No regressions introduced by agent-merged code
- Cost stays within budget envelope throughout

**Completeness**
- Every feature in VISION.md implemented and working
- Every ClawForce data table surfaced in the dashboard
- Onboarding works end-to-end for a new project
- All specs in docs/superpowers/specs/ implemented

**Lockdown Readiness**
- Database schema finalized — no migrations needed for Phase 2
- Telemetry pipeline stable — consistent data from session archives,
  tool captures, config versioning
- Experiment framework validated — at least one controlled experiment
  run with valid statistical output
- API surface stable and documented
- Config schema frozen — all fields that experiments could touch exist

**Code Quality**
- Zero TODOs/FIXMEs
- Full test coverage for all modules
- TypeScript compiles clean
- No dead code, no unused exports

### Gate
Phase 2 begins ONLY when all exit criteria are met. If Phase 2 work
requires an infrastructure change, Phase 1 isn't done — go back.

## Phase 2: Optimal Defaults

ClawForce is stable. Now we use its own experiment framework to figure out
what configurations actually produce the best agent team outcomes.

### What we experiment on
- SOUL.md patterns — what agent identity/guidance produces the best work
- Manager behaviors — review strictness, task granularity, delegation patterns
- Team structures — specialist vs generalist, team size, hierarchy depth
- Verification strategies — gate combinations, failure thresholds
- Scheduling — continuous vs cron, coordination frequency
- Context — which briefing sources matter most, context budget sizing

### What we measure
- Task completion rate and quality
- Cost efficiency (output quality per dollar)
- Failure recovery speed
- Trust score trajectories
- Time-to-first-useful-output for new projects

### Output
- Data-backed default configurations that ship with ClawForce
- Social media content showing real experiment results
- "Here's what we tested, here's what won, here's why"

The content isn't marketing fluff — it's the actual data from real
experiments. People download ClawForce because the defaults are proven,
not vibes.

## Phase 3: Distribution

ClawForce ships with battle-tested defaults discovered in Phase 2.

- Public release (npm package)
- Documentation site
- Onboarding that works in minutes
- Community benchmark contributions (ClawPrint)
- Continuous experimentation feeds back into better defaults

## The Flywheel

```
Experiment → Discover what works → Ship as defaults
    ↑                                      ↓
Content ← Post results on social ← Better product
    ↑                                      ↓
Awareness ← People try it ← It works out of the box
```
