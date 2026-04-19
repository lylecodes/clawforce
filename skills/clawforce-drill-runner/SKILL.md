---
name: clawforce-drill-runner
description: Use to verify a ClawForce org or workflow through scripted drills. Runs controlled failure and success scenarios, checks routing and gates, and records pass/fail evidence. Triggers on "run drill", "verify clawforce workflow", "test the org", "exercise the governance flow".
---

# ClawForce Drill Runner

Use this skill to verify that a ClawForce setup behaves correctly before trusting it with real work.

Read these first:
- `../../MATURITY_ROADMAP.md`
- `../../docs/guides/dogfood-rollout.md`
- `../../templates/dogfood-scorecard.md`

## Drill Types

- approval block
- budget exceed
- dispatch failure
- stale or failed verification
- routing correctness
- parent-child propagation
- release gate enforcement

## Process

1. Pick one drill.
   Do not bundle multiple failure modes into a single run.

2. Define expected behavior.
   Write the exact expected outcome before execution:
   - who gets the task
   - what should be blocked
   - what evidence should be emitted
   - what state transitions should occur

3. Stage the drill.
   Use the smallest change that exercises the control path.

4. Run the workflow.
   Observe:
   - tasks
   - messages
   - approvals
   - events
   - status changes

5. Record evidence.
   Save:
   - relevant logs
   - task IDs
   - event IDs
   - screenshots or CLI output if helpful

6. Judge pass/fail.
   Fail if the system:
   - bypasses a gate
   - routes to the wrong owner
   - deadlocks
   - requires hidden manual intervention

7. Open remediation work.
   Create follow-up tasks for every failed expectation.

## Output

Produce:
- drill description
- expected outcome
- actual outcome
- pass/fail verdict
- remediation tasks if needed

## Rules

- One drill at a time.
- Test the governed path, not just component health.
- A drill is not successful if it “eventually worked” after invisible manual rescue.
