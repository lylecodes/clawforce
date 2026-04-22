# Operator-Led Dogfood Plan

This is the concrete plan for starting dogfood now that the pre-dogfood
workspace, draft/review, helper-authoring, setup-truth, and config/mutation
consolidation work is in place.

This plan is intentionally staged.
Do not jump straight to a real-app rollout.
Run the operator-led UI pass first, then the setup-surface proof lane, then the
first authoritative real-app dogfood.

Use this with:
- [MATURITY_ROADMAP.md](/Users/lylejens/workplace/clawforce/MATURITY_ROADMAP.md)
- [dogfood-rollout.md](/Users/lylejens/workplace/clawforce/docs/guides/dogfood-rollout.md)
- [dogfood-contract.md](/Users/lylejens/workplace/clawforce/templates/dogfood-contract.md)
- [dogfood-scorecard.md](/Users/lylejens/workplace/clawforce/templates/dogfood-scorecard.md)
- [dogfood-experiment.md](/Users/lylejens/workplace/clawforce/templates/dogfood-experiment.md)
- [2026-04-18-foundation-execution-board.md](/Users/lylejens/workplace/clawforce/docs/plans/2026-04-18-foundation-execution-board.md)

## Why This Plan Exists

The next milestone is not "more feature work."
It is proving that normal operator journeys are coherent enough that a human can
use ClawForce as the default control plane instead of falling back to DB poking,
raw internal state, or ad hoc CLI recovery.

The dogfood plan must answer three questions in order:

1. Is the operator surface itself coherent?
2. Can one narrow dry-run setup lane prove setup, runtime honesty, and surfaced decisions end to end?
3. Can one real app make ClawForce authoritative without forcing core to absorb app-specific semantics?

## Current Readiness

These are considered ready enough to start dogfood:

- workspace shell with project, workflow, stage, review, and helper scopes
- draft sessions plus review lifecycle
- helper-led workflow creation
- setup-surface runtime explainability
- config preview/save/history semantics consolidated across special sections

These are not considered proven yet:

- that operators can stay inside the product during normal diagnosis
- that feed, decisions, setup, workflow state, and config history stay mutually trustworthy under real use
- that a bounded dry-run lane can prove governance without hidden operator heroics

## Sequence

Run the next three phases in order:

1. Operator-led UI dogfood
2. Setup-surface proof lane
3. First authoritative real-app dogfood

Do not skip Phase 1.
If Phase 1 is failing, do not advance.

## Phase 1: Operator-Led UI Dogfood

### Goal

Use the actual product as the operator until the shell is boring and
trustworthy.

### Domain

Use a fresh controlled domain, not an older broken one.

Recommended pattern:
- `ui-dogfood-2026-04-21-v1`
- if the run needs a reset, increment the suffix instead of mutating history into confusion

### Surfaces That Must Be Used

- workspace shell (`/workspaces/:domain`)
- setup surface
- feed
- decisions / approvals
- config editor
- monitor / running / errors visibility
- operator comms

### Operator Journeys

Run these as bounded experiments, not freeform poking.

#### Journey 1: Understand the domain without internals

The operator should be able to answer:
- what workflows exist
- which ones are live vs draft/review
- what needs attention
- whether the domain is healthy enough to proceed

Use:
- workspace
- feed
- decisions
- setup status

Failure if:
- the operator needs DB access or raw queries before the normal surfaces become legible

#### Journey 2: Create a workflow through the helper

The operator should:
- start from `new workflow`
- use the helper in the right rail
- answer one-question-at-a-time intake
- get a proposed workflow on the canvas
- accept it into a real draft session

Failure if:
- helper state is decorative rather than authoritative
- proposal acceptance does not materialize into real workflow/draft truth

#### Journey 3: Edit config through the product

The operator should:
- edit one config section
- preview impact
- save/apply
- read recent config history
- understand what actually changed

Use at least these sections:
- `budget`
- `agents`
- `jobs`
- one simpler raw-json section

Failure if:
- preview and save disagree
- config history cannot explain the change
- aliased/special sections leak raw persisted shape back to the operator

#### Journey 4: Move a workflow draft through review

The operator should:
- toggle draft visibility from the left rail
- inspect overlays on the canvas
- confirm the draft into review
- open review detail in the right rail
- approve or reject from the real review surface

Failure if:
- review state requires local dashboard invention
- the right rail stops feeling like one adaptive context surface

#### Journey 5: Work the feed and decision path

The operator should:
- inspect canonical feed items
- distinguish FYI vs action-needed
- open pending workflow reviews from feed
- use the decisions surface for actual approvals

Failure if:
- approvals drift into general chat
- feed and decisions duplicate or contradict each other

#### Journey 6: Diagnose a blocked or stale run

The operator should:
- use monitor/running/errors/setup/feed
- determine whether the problem is `clawforce`, `onboarding`, or `app`
- only then use internal/admin recovery if needed

Failure if:
- diagnosis requires internals before the normal product surfaces have been exhausted
- failure cannot be classified cleanly

#### Journey 7: Use operator comms as intervention, not shadow control

The operator should:
- use comms for operator intervention and context
- not treat it as a parallel approval queue

Failure if:
- the normal chat surface becomes the de facto place where governance happens

### Evidence Commands

Prefer the real operator path first:

```bash
./bin/cf setup status --domain=<domain> --json
./bin/cf setup explain --domain=<domain> --json
./bin/cf feed --json
./bin/cf decisions --json
./bin/cf running
./bin/cf errors --hours=24
```

Use admin or reset tooling only after the discrepancy has already been classified.
If an experiment only passes after admin intervention, record that as a failure
or planned replay step, not a clean success.

### Deliverables

Produce these committed artifacts:

- one dogfood contract
- one scorecard per review window
- one experiment record per journey or rerun
- one running issue list
- one end-of-phase summary

Recommended paths:
- `docs/plans/2026-04-21-ui-dogfood-contract.md`
- `docs/plans/2026-04-21-ui-dogfood-scorecard-week-1.md`
- `docs/plans/2026-04-21-ui-dogfood-experiment-01.md`
- `docs/plans/2026-04-21-ui-dogfood-issue-list.md`
- `docs/plans/2026-04-21-ui-dogfood-summary.md`

### Exit Criteria

Phase 1 is done when:

- normal operator journeys do not require DB peeking
- empty states explain themselves
- setup, feed, decisions, workspace, and config history do not contradict each other
- failures can be classified cleanly as `clawforce`, `onboarding`, or `app`

## Phase 2: Setup-Surface Proof Lane

### Goal

Keep one narrow `dry_run` lane active to prove setup, runtime honesty, and
decision surfacing end to end.

### Current Recommended Lane

Use RentRight source onboarding as the proof lane unless a better narrow lane
appears that is equally bounded and equally real.

### Constraints

- keep it narrow
- keep it in `dry_run`
- do not let core absorb RentRight-specific semantics to make it pass

### Required Proof

The lane must prove:

- setup truth is operator-legible
- runtime enforcement matches what setup promised
- feed and decisions surface the meaningful governance events
- the operator can predict what the system will do before switching anything live

### Exit Criteria

Phase 2 is done when:

- the proof lane exercises real setup, feed, and governance behavior
- ClawForce does not learn app-specific behavior just to make the lane pass
- the operator can explain the lane from product state alone

## Phase 3: First Authoritative Real-App Dogfood

### Selection Rules

Choose one app that has:

- recurring work
- more than one meaningful role
- real cost or risk
- moderate business importance
- manageable blast radius

Reject an app if:

- it can mostly bypass ClawForce and still operate
- it is attractive only because it is familiar
- making it work would require core to absorb app-specific semantics

### Start Narrow

Do not turn on every workflow.
Start with one bounded workflow such as:

- backlog grooming and assignment
- a review/verification handoff
- one recurring operational routine
- one dispatch-heavy maintenance cycle

### Authoritative Rule

The real app must validate ClawForce.
ClawForce must not be warped to validate the app.

## Two-Week Cadence

### Day 0

- create the Phase 1 contract
- choose the controlled domain
- verify environment and dashboard are up
- define the first three experiments before running them

### Days 1-3

- run the seven operator journeys
- record one experiment document per journey
- classify every discrepancy immediately

### Day 4

- fix or tune only the highest-leverage blocker
- rerun the failed journeys

### Days 5-7

- keep using the same domain
- look for repeated bypass patterns
- record the week-1 scorecard

### Week 2

- continue only if ClawForce remains on the critical operator path
- begin the narrow setup-surface proof lane in `dry_run`
- do not advance to a real app if Phase 1 remains noisy

## Triage Rules

Treat these as highest-priority dogfood failures:

- operator needs internals before product surfaces
- feed/decisions/setup/workspace contradict each other
- config edits are not understandable or recoverable
- review/draft/apply state is ambiguous
- recurring blocked runs are not diagnosable from product state
- the same bypass pattern happens more than once

Treat these as lower priority until after the phase passes:

- purely cosmetic polish
- low-value visual cleanup
- broad extension/system ambitions not required for the current operator journey

## Stop Rules

Stop and fix the product surface before advancing if:

- repeated DB peeking becomes normal
- approvals move into chat instead of staying governed
- operators routinely bypass ClawForce to get work done
- the same manual recovery pattern keeps recurring
- the system only succeeds after hidden admin intervention

## Immediate Next Step

Start Phase 1 now:

1. create the controlled domain
2. write the contract
3. define Experiment 01 for Journey 1 and Experiment 02 for Journey 2
4. run the UI dogfood pass through the real workspace and setup surfaces

Do not pick the first authoritative real-app dogfood target until Phase 1 and
Phase 2 are both materially credible.
