# ClawForce Foundation Execution Board

> Last updated: 2026-04-18
> Purpose: define the strict execution order from current state to "complete enough to trust" without letting ClawForce drift into app-shaped implementations or feature churn.

## Completion Bar

ClawForce is "complete enough" when all of these are true:

1. An operator can live out of the dashboard/feed and normal comms surfaces without repeatedly checking internals.
2. Config changes have honest, legible runtime consequences.
3. Setup can simulate what ClawForce would do before `live`.
4. Approvals, verification, budgets, and audit are real governance boundaries, not decorative surfaces.
5. One real app runs through ClawForce end to end without special-casing ClawForce core to that app.

That is the completion target.
Not "every idea shipped."
Not "every workflow modeled."

## Hard Rules

These are non-negotiable:

- no app-specific behavior in ClawForce core just to make one rollout succeed
- no second source of truth in the dashboard
- no fake controls or implied runtime state
- no widening scope before the current phase exit criteria are met
- no treating a dogfood bypass as success

If a needed behavior is only meaningful for one app, it belongs in:

- the app contract
- a workflow definition
- a skill
- an extension
- or a rollout-specific adapter layer

It does not belong in ClawForce core unless it generalizes to the product thesis.

## Phase Order

Work these in order.
Do not treat later phases as parallel unless an item is explicitly marked as a proof lane.

### Phase 1: Now

Objective:
Make the operator surface canonical and truthful.

Major items:

- canonical operator feed
- decision inbox as a filtered view, not a separate truth system
- normalized mapping from issues, proposals, approvals, alerts, and operator-relevant comms into one feed model
- dashboard/operator surface uses only framework-backed contracts

Exit criteria:

- there is one obvious operator surface to open first
- the operator can tell what matters without hunting across multiple queues
- decision inbox contains only real decision boundaries
- normal operator chat does not become the approval queue

Stop rules:

- do not add new dashboard pages unless they strengthen the canonical operator loop
- do not add app-specific feed item kinds
- do not widen into broad dashboard polish while feed semantics are still unstable

### Phase 2: Next

Objective:
Make setup predictive instead of reactive.

Major items:

- preflight / simulation surface in setup
- explicit "if event X happens, ClawForce will do Y" outputs
- dry-run intended mutations, approvals, and blocked actions surfaced before `live`
- stronger setup explainability:
  - why item exists
  - why blocked
  - why this agent
  - what config caused it

Exit criteria:

- a new domain can be evaluated before `live`
- operator can explain expected task/feed/decision behavior from setup output alone
- setup no longer depends on folklore for workflow behavior

Stop rules:

- do not build repo cartography yet
- do not add broad workflow-generation features yet
- do not use simulation as a fake substitute for missing real governance state

### Phase 3: After That

Objective:
Turn repeated pain into governed workflow evolution.

Major items:

- workflow mutation proposals as first-class governed objects
- repeated unsupported operator work raises mutation proposals
- verification and approval semantics cleanup
- clear distinction between:
  - auto-handled
  - blocked for agent
  - needs human
  - needs review
  - simulated

Exit criteria:

- repeated operator recovery work becomes structured proposals instead of custom notes
- approvals are high-signal and legible
- verification and mutation pathways share the same governance model

Stop rules:

- do not quietly auto-mutate workflows
- do not add mutation magic without proposal and approval boundaries
- do not introduce app-specific mutation logic into core

### Phase 4: Consolidate Before Dogfood

Objective:
Finish the remaining canonical contract work before a real app is allowed to prove or distort the product.

Major items:

- finish remaining transport-owned mutation paths
- finish config semantic consolidation across file edits, dashboard edits, and API edits
- one preview path, one save path, one apply story, one audit trail
- formalize stable vs advanced vs internal package boundaries

Exit criteria:

- meaningful mutations do not require transport-specific logic
- config meaning stays consistent across all entry points
- public product boundaries are explicit enough to dogfood without hidden internals

Stop rules:

- do not pick the authoritative dogfood app before this phase is credible
- do not use dogfood pressure to justify leaking app logic into transport or adapter layers

## Dedicated Dogfood Phases

Dogfood is not one thing.
Run these in order.

### Dogfood Phase A: Operator-Led UI Dogfood

Objective:
Use the product directly, with Codex acting as the operator through the actual UI and operator surfaces.

Why this exists:

- before a real app rollout, ClawForce should prove that the operator experience itself is coherent
- this catches fake surfaces, empty states, missing data flows, and confusing controls before app semantics muddy the picture

Execution shape:

- use a throwaway domain or controlled test domain
- operate through the dashboard, setup surfaces, feed, decision inbox, config editing surfaces, and operator comms
- prefer UI and normal operator routes first
- only use admin/internal tooling to confirm or recover after a failure has already been classified

Core operator goals:

- understand team/domain state
- configure or edit the domain
- predict what ClawForce will do
- review feed and decision items
- intervene through operator chat / operator controls
- determine whether runtime and workflow state are current or stale

Success criteria:

- core operator journeys can be completed without reading raw internals first
- empty or partial states are explanatory rather than mysterious
- the UI matches backend truth
- failures can be classified cleanly as:
  - `clawforce`
  - `onboarding`
  - `app`

Failure signals:

- repeated need to inspect the DB or raw internal state to understand normal operator flows
- controls exist without trustworthy backend behavior
- feed and setup disagree on state
- operator chat and decision surfaces overlap confusingly

Stop rules:

- if this phase is failing, do not move to authoritative real-app dogfood
- fix the product surface first

### Dogfood Phase B: Setup-Surface Proof Lane

Objective:
Keep one narrow `dry_run` lane active to prove setup, runtime honesty, and decision surfacing end to end.

Current stance:

- RentRight source onboarding may still be useful here as a narrow setup-surface proof lane
- it is not automatically the first authoritative end-state dogfood app

Guardrail:

- if this lane starts forcing ClawForce core to learn RentRight-specific behavior, stop and reclassify the work

### Dogfood Phase C: First Authoritative Real-App Dogfood

Objective:
Put one real app under ClawForce governance end to end.

Selection rules:

- recurring work
- real cost or risk
- more than one meaningful role
- manageable blast radius
- cannot bypass ClawForce and still mostly work

Rejection rules:

- the app is only attractive because it is familiar
- the app requires ClawForce core to absorb app-specific semantics
- the rollout would be invalidated by routine bypasses

Authoritative rule:

- the app must validate ClawForce
- ClawForce must not be warped to validate the app

## What Not To Touch Yet

Track these, but do not let them steal the current sequence:

- polished repo cartography onboarding
- broad workflow discovery
- local-model mapping swarms
- ambitious extension ecosystems
- generalized workflow studio UX
- broad visual/dashboard sprawl

These stay in stretch or later productization until the completion bar is materially closer.

## Working Cadence

Use this cadence until the first authoritative dogfood app is running:

1. pick the current phase's highest-leverage blocker
2. implement it end to end
3. verify it through the actual product surface where possible
4. update the execution board only if the phase order or stop rules need to change

## Decision Rule

If forced to choose between:

- adding a new ambitious product surface
- making the current operator/governance loop boring and trustworthy

choose the second.

That is the faster path to completion.
