---
name: improve
description: >
  Use when the user says "improve", "find issues", "fix everything", "QA",
  "what's broken", "audit", "harden", or wants a comprehensive technical audit
  of the Clawforce system. Covers bugs, data integrity, error handling, edge cases,
  docs, and production readiness.
---

# Clawforce Improve

You are a senior engineer doing a thorough audit of a live system. Find what's wrong across the entire stack — bugs, data integrity issues, error handling gaps, missing docs, production readiness problems — and fix it all in one continuous flow.

## Rules

1. **Discover → Triage → Fix → Verify is one continuous flow.** Do not stop to ask. Do not present findings and wait. Just fix them.
2. **Dispatch parallel agents aggressively.** Both discovery and fixes should maximize concurrency.
3. **Structural changes only.** Skip cosmetic fixes, trivial cleanup, unused imports. Each change must be individually worth describing.
4. **Fix root causes.** No bandaids, no workarounds, no defensive hacks. Fix the actual problem.
5. **Never create test data in live domains.** The user has agents handling sensitive data. Discovery must be read-only against live data. If write testing is needed, use a throwaway domain.

## Environment

- **Codebase**: `~/workplace/openclaw-agentops/` (backend: `src/`, frontend: `dashboard/`)
- **Dashboard API**: `http://localhost:3117/api/{domain}/{resource}`
- **Vite Dev Server**: `http://localhost:5173`
- **Database**: `~/.clawforce/{domain}/clawforce.db` (SQLite)
- **Default domain**: `content-agency`
- **Test**: `npx tsc --noEmit && npx vitest run` (from codebase root)
- **Build dashboard**: `cd ~/workplace/openclaw-agentops/dashboard && npm run build`
- **Restart gateway**: `openclaw gateway restart`

## Execution Flow

### Phase 1: Preflight

Check that the gateway, Vite dev server, and database are up. If anything is down, report and stop.

### Phase 2: Discover

Launch parallel discovery agents covering the full surface area. The exact number and split is up to you based on what makes sense, but ensure coverage of:

- **API surface** — hit GET endpoints, check response shapes, data consistency, cross-endpoint mismatches
- **Data integrity** — DB vs API consistency, counter drift, orphaned records, queue health, event flooding
- **Source code structure** — type mismatches between frontend/backend, missing event emissions, dead code paths, broken data flows, non-transactional mutations
- **Dashboard UI** — visit every view (use `browser_wait_for` before snapshotting), check for crashes, wrong empty states, broken interactive elements, data that doesn't match APIs
- **Production readiness** — error handling on bad inputs, graceful degradation with missing data, first-run experience, documentation gaps, data hygiene (bloated tables, stale records, test artifacts)

Each agent should focus on FINDINGS, not fixes. Report what's wrong with specifics.

### Phase 3: Triage

Collect all findings. Classify and prioritize:

- **Critical** — crashes, data corruption, broken core flows
- **Structural** — incorrect logic, missing data flows, architectural gaps, poor error handling
- **Cosmetic** — skip these, list in final report

Group independent fixes by file ownership to avoid merge conflicts between parallel fix agents.

### Phase 4: Fix Everything

Dispatch parallel worktree agents (`isolation: "worktree"`) for each independent group of fixes. Each agent should:

1. Read the relevant source files
2. Implement the optimal fix
3. Run `npx tsc --noEmit && npx vitest run` (and `cd dashboard && npm run build` for frontend changes)
4. Fix any test failures caused by the changes

After all agents complete, verify changes are in the working tree.

### Phase 5: Verify & Report

1. Run full test suite and dashboard build
2. Restart gateway (wait 3-5s before API checks)
3. Re-check previously broken endpoints and UI views
4. Present a report with: summary, changes table (issue / root cause / fix / files), skipped items, verification results

## Common Patterns

When fixing, prefer the right approach:

| Pattern | Wrong Fix | Right Fix |
|---------|-----------|-----------|
| Backend/frontend shape mismatch | Defensive casting in components | Transform in the query/API layer |
| Budget counter drift | Reconciliation cron | Fix the write path that skips the counter update |
| Missing events on action | Add event emission after-the-fact | Wire event into the action's transaction |
| UI shows $0 despite data | Hardcode a fallback | Fix the data flow from API to component props |
| Dispatch retry storm | Add sleep/backoff | Skip non-dispatchable states at enqueue time |
| SLO passes with noData | Change default to fail | Emit the metric the SLO expects |
| Health endpoint wrong | Patch the display | Fix the query that feeds it (check field names, data sources) |
