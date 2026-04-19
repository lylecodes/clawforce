---
name: clawforce-dogfood-rollout
description: Use when onboarding a real app to ClawForce dogfooding. Defines the first authoritative workflow, success criteria, rollout contract, scorecard, and stop conditions. Triggers on "dogfood clawforce", "roll out clawforce", "onboard app to clawforce", "make clawforce authoritative".
---

# ClawForce Dogfood Rollout

Use this skill when moving an app from theory into a real ClawForce-operated workflow.

Read these files first:
- `../../MATURITY_ROADMAP.md`
- `../../docs/guides/dogfood-rollout.md`
- `../../templates/dogfood-contract.md`
- `../../templates/dogfood-scorecard.md`
- `../../templates/dogfood-experiment.md`
- `../clawforce-workflow-steward/SKILL.md`

## Goal

Pick one real workflow, make ClawForce authoritative for it, and define how success or failure will be measured.

## Process

1. Identify the workflow.
   Choose one bounded workflow with real business value and clear pass/fail conditions.

2. Define authority.
   Write down exactly what must flow through ClawForce:
   - task creation and transitions
   - dispatch
   - approvals
   - budget/trust gates
   - audit trail

3. Define what is out of scope.
   Be explicit about what can still run outside ClawForce during the dogfood window.

4. Define rollout phases.
   Use three states:
   - `shadow`
   - `authoritative`
   - `steady-state`

5. Define stop conditions.
   Stop or rollback if:
   - work bypasses ClawForce repeatedly
   - approvals or dispatch fail in ways that block normal operation
   - the workflow becomes slower without better control

6. Write the contract.
   Fill in `dogfood-contract.md` with:
   - workflow owner
   - authoritative boundary
   - target metrics
   - rollback triggers

7. Write the scorecard.
   Fill in `dogfood-scorecard.md` with:
   - lead time
   - blocked promotions
   - bypasses
   - manual rescues
   - production issues caught pre-release vs post-release

8. Define the first experiment.
   Do not stop at the contract. Pick the first bounded experiment and capture it in `dogfood-experiment.md`.

9. Define the operator path and reset path.
   Before running the first experiment, write down:
   - the normal operator surfaces that should be enough (`feed`, `decisions`, `entities snapshot`, `entities check`)
   - the reset/admin surfaces allowed for reruns (`reopen-issue`, `reset-remediation`, `clear-check-runs`, event requeue)

   The rule is simple:
   - customer-path tooling proves the rollout works
   - admin tooling helps you rerun experiments without corrupting state
   - admin tooling does not count as a successful normal workflow

10. Add a workflow steward for serious rollouts.
   For any rollout with recurring experiments or multiple remediation loops,
   recommend a high-level workflow steward agent.
   Its job is not to mutate the workflow silently.
   Its job is to turn recurring rollout pain into approval-backed workflow mutation proposals.

## Output

Produce:
- a rollout contract
- an initial experiment record
- a scorecard
- a first backlog of dogfood tasks
- a recommendation for the first week of operation

## Rules

- Start with one workflow, not the entire company.
- Dogfood the control path, not just the dashboard.
- Prefer objective success criteria over “felt useful”.
- If the rollout relies on manual side channels, call that out as a failure mode.
- Make the operator path explicit before the first run.
- Treat reset/requeue/admin commands as dogfood support tooling, not the default success path.
