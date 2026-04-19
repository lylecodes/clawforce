---
name: rentright-org-builder
description: Use when creating, expanding, or retiring RentRight jurisdiction-owner agents and related routing scaffolding. Sets up owner docs, lifecycle state, schedules, and escalation paths. Triggers on "add jurisdiction owner", "expand data org", "bootstrap new owner", "retire jurisdiction owner", "create regime owner".
---

# RentRight Org Builder

Use this skill to expand or reshape the RentRight data org without turning it into unmanaged agent sprawl.

Read these first:
- `../../MATURITY_ROADMAP.md`
- `../../docs/guides/dogfood-rollout.md`
- `../rentright-data-orchestrator/SKILL.md`

Then inspect the target repo/org context in RentRight:
- `../../rentright/docs/ROADMAP.md`
- `../../rentright/docs/architecture/DATA_SOURCE_ONBOARDING.md`
- `../../rentright/docs/architecture/DATA_VALIDATION_FLOW.md`

## Goal

Create or retire jurisdiction ownership cleanly, with explicit lifecycle state and no missing scaffolding.

## Jurisdiction Lifecycle

Use these states:
- `proposed`
- `bootstrapping`
- `shadow`
- `active`
- `degraded`
- `retired`

## Process

1. Classify the request.
   Determine whether this is:
   - a new jurisdiction
   - a split of an overloaded owner
   - a pooled-to-dedicated promotion
   - a retirement or consolidation

2. Check if a dedicated owner is warranted.
   Do not create a new owner if the jurisdiction should still live in a pooled expansion queue.

3. Create the owner scaffold.
   Define:
   - agent id
   - title
   - department/team
   - reports_to
   - briefing defaults
   - cron jobs
   - routing tags

4. Scaffold the jurisdiction dossier.
   Create:
   - `docs/jurisdictions/<slug>/sources.md`
   - `docs/jurisdictions/<slug>/known-quirks.md`
   - `docs/jurisdictions/<slug>/scenario-pack.md`
   - `docs/jurisdictions/<slug>/release-log.md`

5. Seed the initial backlog.
   At minimum:
   - source inventory
   - completeness baseline
   - parent-regime dependency mapping
   - first bundle verification task

6. Register lifecycle state.
   New owners start in `bootstrapping`, never `active`.

7. Retire cleanly if requested.
   On retirement:
   - move state to `retired`
   - reassign or close open tasks
   - preserve dossier/history
   - remove active schedules only after handoff is complete

## Output

Produce:
- owner definition
- lifecycle state
- dossier scaffold status
- routing and schedule plan
- first backlog

## Rules

- Do not create owners casually.
- New owners start in `bootstrapping`.
- Parent/child authority must be explicit before activation.
- Org growth should reduce ambiguity, not multiply managers.
