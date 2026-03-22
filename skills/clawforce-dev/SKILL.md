---
name: clawforce-dev
description: Use at the start of every ClawForce development session to drive the self-improvement loop. Triggers on "clawforce dev", "dev loop", "improve clawforce".
---

# ClawForce Self-Development Loop

Drive ClawForce development by inspecting health, identifying issues, implementing fixes, and verifying via the live system.

## Flow

1. CHECK — gather health data
2. IDENTIFY — prioritize (P0 broken, P1 missing, P2 improvements)
3. PLAN — design fix based on data
4. BUILD — implement with TDD
5. VERIFY — dispatch cf-worker to test the fix
6. ASSESS — did it work? loop or stop

## Step 1: CHECK

Run these commands:

### Tests
`cd ~/workplace/clawforce && npx vitest run 2>&1 | tail -10`

### Type errors
`cd ~/workplace/clawforce && npx tsc --noEmit 2>&1 | tail -10`

### Gateway logs (ClawForce errors)
`grep -i "clawforce.*error\|clawforce.*warn\|clawforce.*fail" /tmp/openclaw/openclaw-*.log 2>/dev/null | tail -10`

### TODO count
`grep -rn "TODO\|FIXME" ~/workplace/clawforce/src/ | wc -l`

### Unimplemented specs
`ls ~/workplace/clawforce/docs/superpowers/specs/`

## Step 2: IDENTIFY

- P0: test failures, type errors, dispatch failures
- P1: specs without implementation, config knobs that do nothing
- P2: TODOs, coverage gaps, optimizations

Pick the single highest-priority item.

## Step 3: PLAN

Read the relevant source. Write a 2-3 sentence plan. Note downstream impacts.

## Step 4: BUILD

1. Write/update test first
2. Verify test fails
3. Implement fix
4. Verify test passes
5. Run full suite
6. Type check
7. Commit

## Step 5: VERIFY

Dispatch cf-worker with a targeted task:
`openclaw agent --agent cf-worker --message "[task that exercises the fix]"`

Check results in the DB.

## Step 6: ASSESS

Success = tests pass, types clean, verification dispatch compliant.
If yes → loop to Step 1.
If no → debug and re-verify.

## Rules
- One fix per cycle. Do not batch.
- Do not skip verification.
- P0 before P1 before P2.
