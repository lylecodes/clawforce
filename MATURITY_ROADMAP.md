# ClawForce Maturity Roadmap

> Last updated: 2026-04-21
> Purpose: show the actual milestone path from current state to "complete enough to trust" and then to broad product maturity.

This roadmap is not a feature wishlist.
It is the milestone map for finishing the core product.

Use this with:

- [docs/plans/2026-04-18-foundation-execution-board.md](/Users/lylejens/workplace/clawforce/docs/plans/2026-04-18-foundation-execution-board.md)
- [docs/plans/2026-04-19-dashboard-v2-implementation-brief.md](/Users/lylejens/workplace/clawforce/docs/plans/2026-04-19-dashboard-v2-implementation-brief.md)
- [ARCHITECTURE.md](/Users/lylejens/workplace/clawforce/ARCHITECTURE.md)

## Completion Bar

ClawForce is "complete enough to trust" when all of these are true:

1. An operator can live out of the dashboard/feed/comms surfaces without repeatedly checking internals.
2. Config changes have honest, legible runtime consequences.
3. Setup can predict what ClawForce will do before `live`.
4. Approvals, verification, budgets, and audit are real governance boundaries.
5. One real app runs through ClawForce end to end without special-casing core.

That is the bar for trust.
Not "every idea shipped."
Not "every workflow modeled."

## Status Snapshot

### Completed enough to lock

- Product direction is locked around ClawForce as the governance/control plane.
- Runtime honesty and setup-truth work has materially improved.
- The dashboard shell direction is locked around the workspace-v2 model.
- Workspace Phase A is done:
  - core read-side contracts exist
  - dashboard Phase A shell exists
  - project -> workflow -> stage scope now works through one coherent shell
- Workspace Phase B is done:
  - real draft sessions exist in core
  - draft overlays are framework-owned
  - the dashboard can toggle draft visibility without inventing local state
- Workspace Phase C is done:
  - confirmed drafts move into real workflow reviews
  - approve / reject uses framework-backed review objects and canonical feed items
  - the workspace can inspect and resolve pending reviews without a second review system
- Workspace Phase D is done:
  - helper sessions are real framework objects
  - helper-led workflow creation lands in the workspace shell
  - accepted helper proposals materialize into real workflow and draft state
- Predictive setup is done:
  - setup exposes modeled preflight scenarios before `live`
  - predicted operator-visible artifacts are explicit
  - explainability is first-class for why a path exists, why blocked, why this agent, and what config causes it

### Not complete yet

- full config/apply consolidation
- authoritative real-app dogfood
- public productization for outside builders

## Milestone Map

This is the complete milestone sequence.
Work these in order.

### Milestone 0: Foundation Truth Locked

Status: done

Meaning:

- framework-first product boundary is locked
- dashboard is a UI over framework truth
- no fake controls
- no second source of truth

This milestone matters because it prevents churn disguised as feature work.

### Milestone 1: Workspace Phase A

Status: done

Meaning:

- core read-side workspace contracts exist
- dashboard renders the new workspace shell against real core data
- project scope works
- workflow scope works
- stage scope works
- right rail behaves as one adaptive surface

Exit proof:

- `/workspaces/:domain`
- `/workspaces/:domain/workflows/:id`
- `/workspaces/:domain/workflows/:id/stages/:stageKey`

This is the first milestone where the dashboard feels like the product we intend to build.

### Milestone 2: Workspace Phase B

Status: done

Objective:
Make workflow mutation real instead of implied.

Build:

- real `WorkflowDraftSession` framework object
- draft session inventory query
- draft overlay query data for workflows/stages
- toggle draft visibility
- dashboard left-rail draft inventory
- canvas overlay rendering for draft state

Complete when:

- a workflow can have one or more real draft sessions
- the dashboard can toggle draft visibility without inventing local state
- live vs draft is explicit on the canvas
- no part of draft handling depends on fake UI-only semantics

### Milestone 3: Workspace Phase C

Status: done

Objective:
Turn draft mutation into governed review.

Build:

- grouped workflow review object
- review detail query
- approve / reject actions
- review items in the canonical feed
- right-rail review state over real contracts

Complete when:

- confirmed drafts move into a real review state
- review happens through the canonical operator loop
- workflow mutation approval is legible and auditable

### Milestone 4: Workspace Phase D

Status: done

Objective:
Make helper-led workflow creation real.

Build:

- helper session contract
- helper conversation actions
- helper-proposed draft workflow structure
- left-rail create-workflow entry into helper scope
- right-rail helper state

Complete when:

- an operator can start a new workflow from the workspace
- the helper asks one question at a time
- proposed workflow structure appears directly on the canvas
- the result becomes a real draft session, not decorative chat

### Milestone 5: Predictive Setup

Status: done

Objective:
Make setup predictive instead of reactive.

Build:

- preflight / simulation surface
- explainability for:
  - why item exists
  - why blocked
  - why this agent
  - what config caused it

Complete when:

- a new domain can be evaluated before `live`
- an operator can explain expected task/feed/decision behavior from setup output alone
- setup no longer depends on folklore

### Milestone 6: Config And Mutation Consolidation

Status: pending

Objective:
Finish the canonical contract layer before authoritative dogfood.

Build:

- one preview path
- one save path
- one apply story
- one audit trail
- transport-owned mutation cleanup
- stable / advanced / internal boundary cleanup

Complete when:

- meaningful mutations do not depend on transport-specific logic
- config meaning is consistent across file edits, dashboard edits, and API edits
- public product boundaries are explicit enough for serious dogfood

### Milestone 7: Operator-Led UI Dogfood

Status: partially done, must continue

Objective:
Use the product directly until the shell is boring and trustworthy.

Use:

- dashboard
- setup
- feed
- decisions
- config
- comms

Complete when:

- normal operator journeys do not require DB peeking
- empty states explain themselves
- setup, feed, and workspace do not contradict each other
- failures classify cleanly as `clawforce`, `onboarding`, or `app`

### Milestone 8: Setup-Surface Proof Lane

Status: pending

Objective:
Keep one narrow `dry_run` lane proving setup, runtime honesty, and surfaced decisions end to end.

Current stance:

- RentRight source onboarding may still be useful here
- it is not automatically the authoritative long-term dogfood app

Complete when:

- the proof lane exercises real setup, feed, and governance behavior
- ClawForce does not absorb app-specific semantics just to make that lane work

### Milestone 9: First Authoritative Real-App Dogfood

Status: pending

Objective:
Run one real app through ClawForce governance end to end.

Complete when the app genuinely uses ClawForce for:

- task creation and transitions
- dispatch path
- budget enforcement
- approvals where relevant
- audit history
- operator review through the actual product surfaces

Failure rule:

If the team can routinely bypass ClawForce and still succeed, the dogfood is invalid.

### Milestone 10: Hardening From Dogfood

Status: pending

Objective:
Convert real pain into product hardening.

Focus:

- approval friction
- config confusion
- retry/recovery visibility
- operator ergonomics
- reload/apply surprises
- bypass incentives

Complete when:

- operators use ClawForce by default, not reluctantly
- incidents are diagnosable from ClawForce state and logs
- config changes feel understandable and recoverable

### Milestone 11: Productization For Others

Status: later

Objective:
Make ClawForce legible and safe for outside builders.

Build:

- clean setup guidance
- stable / advanced / internal API docs
- example integrations
- tightened packaging and release flow
- public-facing product surface documentation

Complete when:

- a builder can install and understand the product without reading the entire repo
- supported integration stories are explicit
- release docs are more trustworthy than tribal knowledge

## What "Done" Looks Like At Each Layer

### Dashboard workspace done

- project / workflow / stage scopes are real
- draft / review / helper scopes are real
- no second truth exists in the UI

### Core governance done

- approvals, verification, budgets, and audit are unavoidable where they matter
- config/apply behavior is legible and consistent

### Dogfood done

- one real app runs through ClawForce without routine bypasses
- the product learns from reality instead of from internal speculation

### Productization done

- another builder can use ClawForce intentionally, not accidentally

## Immediate Next Milestones

The next practical sequence is:

1. Finish Workspace Phase B in `clawforce`.
2. Wire Workspace Phase B in `clawforce-dashboard`.
3. Finish Workspace Phase C.
4. Finish Workspace Phase D.
5. Build predictive setup.
6. Finish config/mutation consolidation.
7. Run continued operator-led UI dogfood.
8. Run the setup-surface proof lane.
9. Choose and execute the first authoritative real-app dogfood.

## Explicit Deferrals

Do not let these steal the milestone sequence:

- generalized workflow studio UX
- repo cartography onboarding
- broad workflow discovery
- extension ecosystem expansion
- speculative local-model swarms
- visual sprawl for its own sake

Those are later only if the trust milestones are already boring.

## Decision Rule

If forced to choose between:
- adding more ambitious autonomy features
- making one real app run cleanly through ClawForce

choose the second.

That is the faster path to a mature product.

## Dogfood Guardrail

The first real-app dogfood target must validate ClawForce without forcing
app-specific semantics into ClawForce core.

If a rollout starts succeeding only because ClawForce learned one app's custom
behavior in core:

- stop
- reclassify the work
- move app-shaped behavior into the app contract, workflow layer, skill, or
  extension unless it clearly generalizes to the product thesis

Before the first authoritative real-app rollout, run an operator-led UI dogfood
pass where Codex uses the actual dashboard and operator surfaces as the
operator. If that phase still requires habitual internal inspection, the real
app rollout is premature.
