# Verification Gates + Git Isolation — Design Spec

## Problem
Autonomous dev loop has no quality gate. Agents can break tests, introduce bugs, and auto-transition to REVIEW. Manager reviews text evidence, not actual test results.

## Solution
Configurable verification gates + git branch isolation + auto-merge/revert.

## Flow
```
Dispatch → create git branch → agent works on branch → session ends →
verification gates run (tests, typecheck, lint) →
  pass → REVIEW (manager reviews + gate results) → approve → merge to main
  fail → FAILED (gate output as evidence) → manager retries or reassigns
```

## Config
```yaml
verification:
  enabled: true
  git:
    enabled: true
    base_branch: main
    auto_merge: true
    delete_after_merge: true
  gates:
    - name: tests
      command: "npx vitest run"
      timeout_seconds: 120
      required: true
    - name: typecheck
      command: "npx tsc --noEmit"
      timeout_seconds: 60
      required: true
```

## Key Decisions
- Gates run in-process (execSync) at agent_end, between evidence capture and transition
- Git branch per task (branch-only mode initially, worktree mode future)
- Branch name from task ID: `cf/task-<shortId>`
- Gate results stored as evidence (type: test_result)
- Failed gates → FAILED (not REVIEW). Branch kept for forensics.
- Manager approval → auto-merge + delete branch
- Continuous loop pauses when gates fail (no infinite broken loop)
