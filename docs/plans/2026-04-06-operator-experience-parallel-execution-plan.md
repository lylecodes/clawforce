# Operator Experience Parallel Execution Plan

> Last updated: 2026-04-06

## Purpose

Translate the operator-experience roadmap into parallel implementation waves
that can be handed to Claude Code subagents without immediate file collisions.

This plan is intentionally separate from the active dashboard-maturity execution
plan. Use it after, or alongside, that work only when the relevant surfaces are
stable enough.

## Assumptions

This plan assumes:

- the dashboard maturity push remains the current implementation priority
- current shell, config, lock, action-status, and runtime work may still be in
  flight
- OpenClaw boundaries remain intact

Primary roadmap:

- `docs/plans/2026-04-06-operator-experience-roadmap.md`

## Execution Strategy

Do not try to build all seven workstreams at once.

Use waves:

1. operator confidence/history/revert
2. `Today` + multi-business rollups
3. search/command palette + notifications
4. personalization/saved views + extension UX polish

That order minimizes rework because later layers depend on stable change truth,
entity identity, and routing behavior.

## Non-Negotiable Boundaries

### OpenClaw owns

- transport delivery when embedded
- plugin lifecycle and install/update
- embedded auth/session ownership

### ClawForce owns

- notification semantics and routing policy
- operator history/provenance model
- `Today`/rollup/search UX semantics
- saved views and operator preferences
- extension rendering and UX inside the dashboard

## Wave 1: Operator Confidence / History / Safe Revert

These tracks should start first.

### Track A. Framework Change History And Revert Contract

Goal:
Create the canonical history/provenance/revert contract in framework truth.

Primary repo:

- `clawforce`

Primary write scope:

- history/audit/change-tracking modules
- `src/api/contract.ts`
- relevant dashboard queries/actions
- framework tests

Key tasks:

- define canonical change record shape
- link change history to audit where possible
- model human vs agent vs system provenance
- expose resource-level history reads
- define safe structural revert actions
- reject unsafe operational revert attempts explicitly

Deliverables:

- history contract
- revert contract for structural surfaces
- framework tests

### Track B. SPA History, Diff, And Revert UX

Goal:
Render change truth and safe revert coherently in the dashboard.

Primary repo:

- `clawforce-dashboard`

Primary write scope:

- history/diff components
- resource detail/config surfaces
- tests

Key tasks:

- show provenance and before/after diff
- add resource history affordances
- add safe revert UI where supported
- distinguish reversible vs non-reversible changes clearly

Deliverables:

- shared history/diff UI
- safe revert UX
- SPA tests

### Track C. History Verification

Goal:
Prove real operator confidence flows.

Primary repo:

- `clawforce-dashboard`

Primary write scope:

- route/integration tests
- new test helpers

Key tasks:

- config change -> history -> diff
- budget change -> history -> revert
- doc change -> history -> restore
- agent/org change -> history -> revert

## Wave 2: `Today` And Multi-Business Rollups

Start after Wave 1 contracts are reasonably stable.

### Track D. Attention Item Model

Goal:
Define one shared model for `Today` and business rollups.

Primary repos:

- `clawforce`
- `clawforce-dashboard`

Primary write scope:

- summary/query contract
- `Overview`
- `Monitor` / businesses views
- related client/store code

Key tasks:

- define attention item shape
- classify action-needed vs watching vs fyi
- support destination deep links and focused context
- expose business-grouped rollups

Deliverables:

- attention-item contract
- rollup queries
- shared client types

### Track E. `Today` In `Overview`

Goal:
Make `Overview` the real domain operating home.

Primary repo:

- `clawforce-dashboard`

Primary write scope:

- `Overview`
- destination-page focus hooks
- tests

Key tasks:

- add `Today` widget
- support filters
- preserve context on deep links
- make clicked items land in the correct focused surface

Deliverables:

- `Today` widget
- focus/deep-link behavior
- tests

### Track F. Business Rollup Surfaces

Goal:
Make grouped-by-business operation first-class.

Primary repo:

- `clawforce-dashboard`

Primary write scope:

- `Monitor` / business views
- possibly `Workspace`
- tests

Key tasks:

- per-business attention cards
- grouped approvals/comms/budget/ops rollups
- drill into a business from rollups

Deliverables:

- business-first rollup UX
- tests

## Wave 3: Search / Command Palette / Notifications

Start after entity identity and routing behavior in Waves 1 and 2 are stable.

### Track G. Find-And-Jump Search

Goal:
Build fast entity navigation before deep full-text search.

Primary repo:

- `clawforce-dashboard`

Primary write scope:

- command palette/search components
- search client contract if needed
- tests

Key tasks:

- search businesses, agents, tasks, approvals, threads, config sections, pages,
  extensions
- support keyboard-driven jump behavior
- support quick actions where safe

Deliverables:

- command/search entrypoint
- find-and-jump result model
- tests

### Track H. Notification Model And Routing

Goal:
Create a real notification system with canonical inbox plus routed delivery.

Primary repos:

- `clawforce`
- `clawforce-dashboard`

Primary write scope:

- notification model/storage/query files
- adapter integration where needed
- inbox UI
- preferences UI
- tests

Key tasks:

- define canonical notification record
- define categories/severity/actionability/delivery status
- support global defaults + business overrides
- keep dashboard inbox canonical
- route external delivery through OpenClaw-backed transports when embedded
- track delivery success/failure

Deliverables:

- notification contract
- inbox UI
- routing settings
- tests

### Track I. Notification Delivery Adapters

Goal:
Broaden transport usage without duplicating OpenClaw ownership.

Primary repo:

- `clawforce`

Primary write scope:

- `adapters/openclaw.ts`
- delivery abstractions/tests

Key tasks:

- generalize beyond Telegram where the host surface supports it
- preserve graceful in-app fallback
- keep delivery optional and host-backed

Deliverables:

- clearer multi-channel delivery bridge
- adapter tests

## Wave 4: Personalization / Saved Views / Extension UX

Start after the operator model is stable enough to save against.

### Track J. Operator Preferences And Saved Views

Goal:
Support light personalization without fragmenting IA.

Primary repo:

- `clawforce-dashboard`

Primary write scope:

- preferences store/model
- saved views UI
- tests

Key tasks:

- default landing surface
- pinned businesses
- nav tailoring
- saved filters
- saved `Today` defaults
- saved operational views

Deliverables:

- operator preference model
- saved views
- tests

### Track K. Extension UX Polish

Goal:
Make extensions feel native to the operator experience.

Primary repo:

- `clawforce-dashboard`

Primary write scope:

- `ExtensionsCenter`
- nav/page/panel/context affordances
- tests

Key tasks:

- show what extensions add
- show where they appear
- show health and compatibility
- show business applicability
- make extension contributions understandable from operator surfaces

Deliverables:

- polished extension UX
- tests

## File-Overlap Warnings

Avoid assigning these to multiple workers at once unless one worker is
effectively read-only:

- `clawforce/src/api/contract.ts`
- `clawforce/src/dashboard/queries.ts`
- `clawforce/src/dashboard/actions.ts`
- `clawforce/adapters/openclaw.ts`
- `clawforce-dashboard/src/views/Overview.tsx`
- `clawforce-dashboard/src/views/Monitor.tsx`
- `clawforce-dashboard/src/App.tsx`
- `clawforce-dashboard/src/components/NavBar.tsx`
- `clawforce-dashboard/src/store.ts`

## Recommended Execution Order

1. start Tracks A, B, and C together
2. merge Track A before finishing B if the history contract changes materially
3. start D, E, and F after Wave 1 contracts stabilize
4. start G and H after Wave 2 routing/focus behavior stabilizes
5. start I only when H has a clear notification contract
6. start J and K last, once operator semantics stop moving

## Definition Of Done

Do not call this phase successful until:

- change truth is visible and trustworthy
- safe structural revert is real
- `Overview` has a meaningful `Today` layer
- multi-business rollups are grouped by business first
- search is useful as find-and-jump, not fake deep search
- dashboard inbox is canonical and external delivery is routed cleanly
- personalization remains light and coherent
- extension UX no longer feels bolted on

