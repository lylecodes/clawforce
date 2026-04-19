---
name: clawforce-dogfood-experiment
description: Use when running a dogfood experiment for ClawForce on a real app or workflow. Defines the hypothesis, expected feed/task/decision behavior, executes the run, records actual results, and classifies discrepancies as ClawForce, onboarding/config, or app-specific. Triggers on "run dogfood experiment", "hypothesis and run it", "expected vs actual", "classify discrepancy", "verify the setup works".
---

# ClawForce Dogfood Experiment

Use this skill when validating a real ClawForce rollout through a controlled experiment.

Read these first:
- `../../docs/guides/dogfood-rollout.md`
- `../../templates/dogfood-contract.md`
- `../../templates/dogfood-scorecard.md`
- `../../templates/dogfood-experiment.md`
- `../clawforce-workflow-steward/SKILL.md`

## Goal

Run one bounded experiment through the actual governed path and record whether the system behaved as expected.

The point is not just to "see what happens." The point is to produce a clean verdict:
- did ClawForce model and govern the workflow correctly?
- was the onboarding/config correct?
- is the app workflow itself ready for automation?

## Process

1. Pick one scenario.
   Keep the scope narrow:
   - one entity
   - one workflow
   - one failure mode or one success path

2. Write the hypothesis first.
   Before execution, capture:
   - what should happen
   - what should be blocked
   - what should be created
   - what should surface in the feed
   - what should require approval

3. Be explicit about the run mode.
   Record:
   - domain execution mode: `dry_run` or `live`
   - entity lifecycle state: `bootstrapping`, `shadow`, `active`, etc.

4. Run the experiment through the governed path.
   Observe:
   - entity state/health
   - issue creation/resolution
   - remediation task creation/reuse
   - feed items
   - decisions/approvals
   - reruns and closure behavior

   Prefer the actual operator path first:
   - `cf feed --domain=<domain> --json`
   - `cf decisions --domain=<domain> --json`
   - `cf entities snapshot --domain=<domain> --entity-id=<id> --json`
   - `cf entities check --domain=<domain> --entity-id=<id> --json`
   - `cf entities check-runs --domain=<domain> --entity-id=<id> --limit=<n> --json`

   Use admin/reset tooling only when the experiment explicitly calls for it or when preparing a rerun:
   - `cf entities reopen-issue --domain=<domain> --issue-id=<id> --reason="<reason>" --json`
   - `cf entities reset-remediation --domain=<domain> --entity-id=<id> --json`
   - `cf entities clear-check-runs --domain=<domain> --entity-id=<id> --json`
   - `cf entities events --domain=<domain> --status=failed --requeue --process --json`
   - `cf entities events --domain=<domain> --reclaim-stale --process --json`

5. Record actual behavior.
   Use concrete evidence:
   - commands run
   - task IDs
   - issue IDs
   - proposal IDs
   - feed output
   - relevant logs

6. Classify discrepancies.
   For each mismatch, assign exactly one primary class:
   - `clawforce`
   - `onboarding`
   - `app`

   Use these rules:
   - `clawforce`: missing primitive, wrong UX, wrong policy boundary, bad automation behavior
   - `onboarding`: representable workflow, but checks/skills/routing/config are wrong
   - `app`: underlying app pipeline, data model, or code is not actually automation-ready

7. Decide the next move.
   Every experiment should end in one of:
   - pass, move forward
   - tune onboarding/config and rerun
   - fix ClawForce product gap and rerun
   - fix app workflow and rerun

8. Escalate workflow mutations through the steward path.
   If the operator could not proceed with supported levers and the best fix is a workflow change,
   route that into `clawforce-workflow-steward` rather than treating it as an ad hoc config tweak.

## Output

Produce one completed experiment record with:
- hypothesis
- expected behavior
- actual behavior
- discrepancy list
- ClawForce verdict
- onboarding verdict
- app verdict
- fix owner
- rerun trigger

## Rules

- One experiment at a time.
- Never skip the hypothesis step.
- Do not manually rescue the workflow and then call the experiment a pass.
- Keep `shadow` and `dry_run` separate.
- If the setup requires hidden glue or manual internal poking, record that as a ClawForce or onboarding failure, not a success.
- Prefer customer-path surfaces (`feed`, `decisions`, `entities snapshot`, `entities check`) before admin surfaces.
- If you use reset/requeue tooling, record exactly why and whether it was part of the planned experiment or post-failure cleanup.
