# ClawForce Principles

These principles govern all design decisions, feature work, and operational behavior.
When in doubt, filter through these.

## Core Insight

AI is excellent at executing work but terrible at choosing work. Left alone, AI leads
produce busywork — surfacing empty tables, re-screenshotting dashboards, re-assigning
tasks to the same workers. The system must be designed around this reality.

**Humans decide WHAT gets built. AI decides HOW to build it.**

## Work Origination

Work enters the system two ways:

1. **User-provided** — User creates a feature, bug report, or task. The lead breaks it
   down, assigns workers, reviews output. Full autonomy on execution. No approval needed
   for subtasks created during execution.

2. **Lead-suggested** — Lead observes friction, spots a bug, or identifies an improvement.
   It creates a proposal: "I noticed X, I think we should build Y." The proposal goes to
   an approval queue. User approves → becomes a task. User rejects → dropped.

The approval gate is ONLY on lead-originated work ideas, not on every task. Leads stay
aggressive on execution within approved scope. Don't dampen the agents.

Whether leads can suggest work is configurable — some users want fully human-driven,
some want the AI surfacing ideas.

## Budget Drives the Schedule

The budget is a fuel tank, not a wall. The system paces work across the day based on
remaining budget and remaining time.

- Budget pacing spreads spend evenly (configurable reserve for reactive work)
- Different teams can have different budget strategies (paced vs burn-until-empty)
- Reactive work (reviews, failure triage) bypasses pacing — always fires if budget allows
- When budget is low, only reactive work runs. When critical, only verifiers.
- The lead sees budget recommendations in its briefing — it doesn't do the math, the
  system computes it.

## Agent Roles

**Leads** execute within approved scope. They break down features into tasks, assign
workers, review completed work, and triage failures. They wake on events (task completed,
task failed, review ready) and scheduled planning sessions. They do NOT invent work
unless configured to suggest (with approval gate).

**Workers** implement tasks. They fire on assignment events, loop through their task board
in a single session, and submit evidence for review. They are cheap, fast, and autonomous
within a task's scope.

**Verifiers** review completed work. They fire on review-ready events. Single task per
session. They approve or reject with specific feedback.

## Configuration Philosophy

**CLI-first.** Every config change must be possible via `pnpm cf config set`. Users
should never edit YAML files directly. If a config field has no CLI path, that's a bug.

**Sensible defaults.** A user who sets `budget: $100/day` gets event-driven dispatch,
budget pacing, worker loops, and reactive leads without touching any other config.
Advanced users override specific behaviors.

**Per-team strategies.** Different teams can have different budget strategies, dispatch
modes, and scheduling. Dashboard team gets steady pacing. Core team burns until empty.
All expressible in config.

**Composable.** Team templates, mixins, role defaults, briefing operators, conditional
config — the config system supports many organizational patterns without code changes.

## Operational Safety

- Never kill all OpenClaw processes — only target ClawForce agents (cf-*, dash-*)
- Use `pnpm cf disable/enable/kill` for domain control — never edit YAML for runtime state
- Domain disable is DB-backed and instant — no gateway restart needed
- The dispatcher checks disabled state before every dispatch
- Running sessions finish naturally when disabled — no forced termination
- Emergency stop blocks everything, resume clears it

## Architecture Standards

- **One canonical path.** Every operation should have exactly one code path. Multiple
  overlapping systems that race (like 7 assignment paths) create bugs.
- **Events drive dispatch.** Agents wake because something happened, not because a timer
  fired. No wasted sessions polling empty boards.
- **Budget intelligence is computed, not reasoned.** The BudgetPacer computes
  recommendations. The lead reads them. Don't make the LLM do math.
- **Structural governance.** Trust scores, budget limits, verification gates, and
  disabled states are enforced by the system, not by agent prompts. Agents don't get
  tools to bypass governance.
- **Registry over switch statements.** Extensible registries (context sources, event
  handlers) instead of hardcoded switch cases.

## What ClawForce Is

Infrastructure for self-scaling autonomous AI agent teams. You define a team — roles,
structure, budget, direction — in config. ClawForce handles task lifecycle, performance
measurement, cost management, and the operational environment that lets agent teams
measure, adapt, and scale themselves.

**Not:** safety software, governance platform, compliance tool, agent orchestrator.
**Is:** the infrastructure that makes autonomous agent teams actually work.

**One-liner:** "Set the direction. Set the budget. Your AI team handles the rest."

## What's Next

Phase 2 experiments will test whether optimized prompts can make AI good at choosing
work autonomously. If yes, ClawForce becomes truly autonomous. If no, human-drives-what
is the ceiling and we optimize for that model.
