# Dogfood Rollout Guide

Use this guide when you are ready to put a real app under ClawForce governance.

This is not a passive observation exercise.
The point is to make ClawForce the authoritative control path for a real workload and then measure where that breaks down.

Use this with:
- [MATURITY_ROADMAP.md](/Users/lylejens/workplace/clawforce/MATURITY_ROADMAP.md)
- [dogfood-contract.md](/Users/lylejens/workplace/clawforce/templates/dogfood-contract.md)
- [dogfood-scorecard.md](/Users/lylejens/workplace/clawforce/templates/dogfood-scorecard.md)
- [dogfood-experiment.md](/Users/lylejens/workplace/clawforce/templates/dogfood-experiment.md)
- [workflow-mutation-proposal.md](/Users/lylejens/workplace/clawforce/templates/workflow-mutation-proposal.md)
- [rentright-source-onboarding-dogfood-contract.md](/Users/lylejens/workplace/clawforce/docs/guides/rentright-source-onboarding-dogfood-contract.md)
- [2026-04-11-domain-execution-mode-and-dry-run.md](/Users/lylejens/workplace/clawforce/docs/plans/2026-04-11-domain-execution-mode-and-dry-run.md)

The canonical setup-surface dogfood lane is now RentRight source onboarding in
`dry_run`. Use that contract when you want the shortest path to proving setup,
runtime honesty, and decision surfacing end to end.

Before any authoritative real-app rollout, run an operator-led UI dogfood pass
first. In that phase, Codex should act as the operator through the actual
dashboard, setup, feed, decisions, and operator-comms surfaces on a throwaway
or controlled domain. If the product still requires habitual internal
inspection during that pass, the real-app rollout is not ready.

## 1. Pick the App

Choose one app that has:
- recurring work
- more than one meaningful role or agent
- real cost or risk, so budgets and approvals matter
- moderate business importance
- manageable blast radius if the rollout is rough for a week

Do not choose:
- the most fragile app
- a toy app
- an app that can bypass ClawForce and still mostly operate

Do not choose an app if making it work would require ClawForce core to absorb
that app's special-case semantics.

If the needed behavior does not generalize, keep it in:

- the app contract
- workflow definitions
- skills
- extensions
- or rollout-specific integration code

## 2. Write the Contract

Create a dogfood contract from the template and fill in:
- app name and owner
- rollout scope
- what must go through ClawForce
- rollout start and rollback conditions
- success metrics

If you cannot write this clearly, the rollout is not ready.

## 3. Make ClawForce Authoritative

The dogfood app must route these through ClawForce:
- task creation and transition
- dispatch
- budget checks
- approvals for relevant risk
- audit and event history
- operator review through the dashboard or equivalent control path

If operators or agents can routinely bypass those flows, the dogfood run is invalid.

## 4. Verify Setup First

Do not jump directly from "configured" to "live."

The mature flow is:

1. onboard the domain
2. run it in `dry_run`
3. verify routing, checks, intended mutations, and decision surfaces
4. only then switch to `live`

`shadow` and `dry_run` are not the same:

- `dry_run` = side effects simulated or blocked
- `shadow` = real workflow, not yet authoritative

If the product does not yet support native dry-run for a workflow, treat that
as a rollout gap and document it explicitly.

## 5. Start Narrow

Start with one bounded workflow, not every workflow at once.

Good first workflows:
- backlog grooming and assignment
- review and verification handoff
- one recurring operational routine
- one dispatch-heavy build or maintenance cycle

Avoid broad “turn everything on” launches.

## 5A. Run It As Experiments

Do not treat the first dogfood runs as fuzzy observation.

Run them as explicit experiments:
- write the hypothesis first
- record expected feed/task/decision behavior
- execute the run
- record actual behavior
- classify each discrepancy as:
  - `clawforce`
  - `onboarding`
  - `app`

Use [dogfood-experiment.md](/Users/lylejens/workplace/clawforce/templates/dogfood-experiment.md) for each run.

This matters because the same rollout can reveal:
- a missing ClawForce primitive
- a bad onboarding/config choice
- or an app workflow that is not actually automation-ready

If you do not separate those, you will fix the wrong thing.

For mature dogfood runs, add a high-level workflow steward agent.
That role should:
- review repeated experiment failures and resets
- identify whether the missing fix belongs to ClawForce, onboarding, or the app
- send approval-backed workflow mutation proposals when the operator cannot proceed with normal levers

That role should not silently change live governance rules.
It should use proposals and approvals for workflow mutations the same way other risky system changes are governed.

When running the experiment, prefer the actual operator path first:
- `cf feed --domain=<domain> --json`
- `cf decisions --domain=<domain> --json`
- `cf entities snapshot --domain=<domain> --entity-id=<id> --json`
- `cf entities check --domain=<domain> --entity-id=<id> --json`
- `cf entities check-runs --domain=<domain> --entity-id=<id> --limit=<n> --json`

Use admin tooling only for controlled reruns and recovery:
- `cf entities reopen-issue ...`
- `cf entities reset-remediation ...`
- `cf entities clear-check-runs ...`
- `cf entities events --requeue --process ...`

If an experiment only succeeds after admin intervention, that is not a clean pass. It is either:
- a legitimate rerun/reset step you planned in advance, or
- a discrepancy to classify and record

## 6. Run for Long Enough

The minimum useful trial is 1-2 weeks of real work.

You need enough time to hit:
- blocked approvals
- budget gates
- retries or recovery
- operator intervention
- at least one config or routing change

## 7. Record Pain Immediately

Create one running issue list for the rollout and log:
- where operators bypassed ClawForce
- where config semantics were confusing
- where reload behavior was surprising
- where audit history failed to explain reality
- where approvals were noisy, weak, or both

Do not wait until the end to reconstruct this from memory.

## 8. Review Weekly

At least once per week, score the rollout using the scorecard template.

Treat these as red flags:
- operators checking internals instead of the dashboard
- repeated manual poking after config edits
- task state drifting away from actual work
- approvals that everyone starts working around
- budget gates that are disabled rather than tuned

## 9. Exit Rules

Continue the rollout if:
- ClawForce remains on the critical path
- operators can diagnose incidents from ClawForce state
- fixes are mostly operational hardening, not architectural rescue

Stop and reassess if:
- the team repeatedly bypasses ClawForce
- the same manual recovery pattern keeps happening
- config and reload semantics are not trustworthy enough for real use
- the rollout only works because ClawForce core now contains app-shaped special
  cases

## Suggested Deliverables

For the first dogfood app, produce:
- one completed contract
- one or more experiment records
- one weekly scorecard
- one issue list for pain found during the rollout
- one short end-of-trial summary:
  - what held up
  - what failed
  - what must be fixed before wider rollout
