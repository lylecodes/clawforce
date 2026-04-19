# ClawForce Maturity Roadmap

> Purpose: move ClawForce from "capable and ambitious" to "boring, trusted, and product-grade."

This roadmap is not a feature wishlist.
It defines the work required to make ClawForce structurally mature, operationally reliable, and proven on real workloads.

Use this alongside [ARCHITECTURE.md](/Users/lylejens/workplace/clawforce/ARCHITECTURE.md).
When the first rollout is ready, use [dogfood-rollout.md](/Users/lylejens/workplace/clawforce/docs/guides/dogfood-rollout.md),
[dogfood-contract.md](/Users/lylejens/workplace/clawforce/templates/dogfood-contract.md), and
[dogfood-scorecard.md](/Users/lylejens/workplace/clawforce/templates/dogfood-scorecard.md).

## Success Definition

ClawForce is in a mature state when all of the following are true:

1. Architecture is stable.
   Core semantics do not live in transports or in the OpenClaw adapter.

2. Operations are predictable.
   Config changes, reloads, task flows, approvals, and failure recovery behave consistently.

3. One real app is governed through ClawForce end to end.
   Not observed. Not partially integrated. Governed.

4. Public surfaces are intentional.
   Builders know what is stable, what is advanced, and what is internal.

5. Release confidence is credible.
   Tests, docs, setup, and packaging make the system usable by someone other than the author.

## Current Assessment

ClawForce is already technically serious:
- strong test coverage
- broad SDK surface
- meaningful governance primitives
- OpenClaw-native integration
- working dashboard/operator surface

But it is not yet at mature-state quality because:
- some transport and adapter paths still own behavior they should not own
- config semantics are improved but not fully lossless or fully canonical
- public packaging tiers are only partly formalized
- OpenClaw is the primary runtime today, but that relationship is not fully clarified as product strategy
- there is not yet a real dogfood proof that ClawForce works as the authoritative control plane for a live app

## Strategy

Run two tracks in parallel:

- Track A: structural maturity
- Track B: dogfood proof

Do not let Track A continue indefinitely without Track B.
Do not start Track B so early that obvious architecture debt distorts the lessons.

## Phase 1: Finish Structural Consolidation

Objective:
Remove the remaining architecture debt that would contaminate dogfooding.

### Work

- Finish moving transport-owned behavior into app commands and queries.
- Finish shrinking `gateway-routes.ts`, `routes.ts`, and similar transport shells.
- Finish moving remaining meaningful mutable singleton state behind the runtime container.
- Tighten OpenClaw boundaries so the adapter is integration code, not a second architecture center.
- Complete the config semantic model far enough that file edits, dashboard edits, and API edits share one meaning.
- Freeze explicit package tiers:
  - `clawforce`
  - `clawforce/advanced`
  - `clawforce/internal`

### Exit Criteria

- New dashboard or HTTP work does not require adding core logic to transport files.
- New runtime state has an obvious home in runtime/container code.
- OpenClaw-specific logic is clearly adapter logic, not core logic.
- Config save, preview, validation, and reload all go through one canonical model.
- Public exports are deliberate rather than inherited from broad barrels.

### Non-Goals

- no architecture astronautics
- no microservices
- no storage rewrite for its own sake
- no large feature expansion during this phase

## Phase 2: Define the Dogfood Target

Objective:
Pick one real app and make the dogfood plan explicit.

### Selection Criteria

Choose an app that has:
- recurring work
- more than one meaningful role or agent
- enough cost/risk that budgets and approvals matter
- moderate business importance, not maximum business importance
- manageable blast radius if ClawForce is rough for a week

Avoid:
- the most fragile app
- a toy app with no real operational stakes
- an app where agents can easily bypass ClawForce and still "work"

### Required Dogfood Contract

The dogfood app must use ClawForce as the authoritative layer for:
- task creation and transition
- dispatch path
- budget enforcement
- approvals where relevant
- audit/event history
- operator review through the dashboard or equivalent control surface

If the app can bypass ClawForce during normal operation, the dogfood exercise is invalid.

### Deliverables

- selected dogfood app
- integration owner
- rollout scope
- rollback plan
- success metrics

## Phase 3: Run Authoritative Dogfood

Objective:
Use ClawForce in production-like reality long enough to expose real operational weaknesses.

### Minimum Trial

- run for at least 1-2 weeks
- process real tasks
- incur real costs
- hit at least a few abnormal cases:
  - blocked approval
  - budget gate
  - task reassignment
  - retry/recovery
  - operator intervention

### What To Observe

- Did operators trust the dashboard and audit trail?
- Did task state remain the source of truth?
- Were approvals too noisy or too weak?
- Were config edits understandable and safe?
- Did budget and trust rules help, or did they merely annoy?
- Did any workflows bypass ClawForce because it was easier?

### Failure Rule

If the dogfood team repeatedly bypasses ClawForce, assume the product is not mature enough yet.
Do not rationalize around it.

## Phase 4: Harden From Dogfood

Objective:
Convert real pain into product hardening.

### Priorities

- fix operator pain before adding more features
- simplify config before enriching config
- reduce bypass incentives
- improve failure recovery and observability
- update docs to match actual operational reality

### Typical Issues Expected

- approval friction
- config confusion
- task lifecycle edge cases
- unclear routing between OpenClaw and ClawForce responsibilities
- poor operator ergonomics
- reload behavior that is correct but too surprising

### Exit Criteria

- the dogfood app can run without habitual manual poking
- operators use ClawForce by default, not reluctantly
- incidents are diagnosable from ClawForce state and logs
- config changes feel understandable and recoverable

## Phase 5: Productize for Others

Objective:
Make the system legible and safe for external builders.

### Work

- publish clean setup and runtime guidance
- document stable vs advanced vs internal APIs
- provide migration notes for any breaking boundary changes
- add one or two canonical example integrations
- tighten packaging and release flow
- revisit the `node:sqlite` dependency decision before claiming a fully mature release

### Exit Criteria

- a builder can install and understand the product without reading the whole source tree
- the supported integration story is explicit
- release notes and docs are more trustworthy than tribal knowledge

## Recommended Sequence

1. Finish structural consolidation.
2. Run operator-led UI dogfood on a throwaway or controlled domain.
3. Pick the dogfood app.
4. Ship the authoritative dogfood integration.
5. Run it long enough to gather real pain.
6. Harden around the pain.
7. Freeze and document the public product surface.

## Immediate Next Steps

These are the next practical steps from the current codebase state:

1. Finish the remaining transport-owned mutation paths.
2. Finish the config semantic model enough to trust real dogfood edits.
3. Formalize `clawforce/advanced`.
4. Choose the first dogfood app.
5. Write a short dogfood contract for that app:
   - what must go through ClawForce
   - what success looks like
   - what rollback looks like
   Use [dogfood-contract.md](/Users/lylejens/workplace/clawforce/templates/dogfood-contract.md).

## First Dogfood Scorecard

Use this to judge the first app rollout.

### Governance

- budgets actually block work when they should
- approvals actually gate risky actions
- task state matches reality
- audit history explains what happened

### Operator Experience

- the dashboard is the default place to look
- config edits are understandable
- interventions are fast
- there is no frequent need to inspect internals directly

### Reliability

- retries and recovery are visible
- reloads do not surprise operators
- no hidden state causes inconsistent behavior

### Product Proof

- the app team prefers running with ClawForce over running without it

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
