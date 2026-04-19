---
name: dogfood
description: >
  Use when the user says "dogfood", "use the product", "what's missing",
  "feature gaps", "walk through it", "user perspective", or wants to identify
  and fix incomplete features, broken workflows, and UX gaps by using the
  product as a real user would.
---

# Clawforce Dogfood

You are a new user of Clawforce trying to get real work done. Walk through every major workflow, find what's incomplete or confusing, and wire it up. The goal is feature completeness and usability — not bug-fixing (that's `/improve`).

## Rules

1. **Discover → Triage → Fix → Verify is one continuous flow.** Do not stop to ask. Do not present findings and wait. Just fix them.
2. **Agents have GOALS, not checklists.** Each discovery agent tries to accomplish something real and reports what blocked them, felt empty, or didn't make sense.
3. **Triage by user impact.** The thing a user hits first on the main page matters more than a broken internal endpoint. Prioritize what's visible and what blocks workflows.
4. **Build missing features, don't just fix bugs.** If a data flow was never wired up, wire it up. If a feature exists in the UI but has no backend, build the backend. This is about completeness.
5. **Never create test data in live domains.** The user has agents handling sensitive data. Use read-only exploration or a throwaway domain.

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

Launch parallel discovery agents, each trying to accomplish a real user goal. Look at the product and decide what the core user journeys are — don't follow a hardcoded list. Common journeys for this type of product include things like:

- **"How is my team doing?"** — Dashboard overview, agent status, performance metrics, initiative progress. Is the data meaningful? Can I make decisions from what I see?
- **"I need to manage work"** — Create tasks, assign them, track progress, see completion. Does the full lifecycle work end-to-end?
- **"Set up and configure my workforce"** — Agent config, budgets, initiatives, policies, schedules. Can I configure everything from the UI? Does saving work? Do changes take effect?
- **"Monitor operations"** — Health, SLOs, alerts, events, costs. Do the numbers make sense? Can I tell when something's wrong?
- **"Communication and coordination"** — Meetings, messages, escalations. Can agents actually communicate? Do messages display properly?

Each agent should use the real UI (Playwright MCP) AND the API. Compare what the UI shows vs what the API returns. Use `browser_wait_for` before snapshotting pages.

The key question for each agent: **"If I were a user trying to do this, would I succeed? What blocked me?"**

### Phase 3: Triage

Collect all findings. Prioritize by user impact:

- **High** — core workflow blocked, main page showing empty/wrong data, feature completely non-functional
- **Medium** — feature partially works but missing key data, confusing UX, secondary workflows broken
- **Low** — cosmetic issues, nice-to-haves, edge cases — skip these, list in report

Group fixes by file ownership for parallel dispatch.

### Phase 4: Fix Everything

Dispatch parallel worktree agents (`isolation: "worktree"`) for each independent group. Each agent should:

1. Read the relevant source files to understand the current state
2. Wire up the missing data flow / build the missing feature / fix the broken workflow
3. Run `npx tsc --noEmit && npx vitest run` (and `cd dashboard && npm run build` for frontend changes)
4. Fix any test failures caused by the changes

This phase often involves building new things, not just fixing existing code. That's expected — the point is to make features actually work end-to-end.

### Phase 5: Verify & Report

1. Run full test suite and dashboard build
2. Restart gateway (wait 3-5s before API checks)
3. Re-walk the workflows that were broken — verify them in the UI
4. Present a report with: summary, changes table (gap / what was missing / what was built / files), skipped items, before/after verification
