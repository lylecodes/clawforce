# Dashboard Parallel Execution Plan

> Last updated: 2026-04-05

## Purpose

This plan translates the dashboard maturity roadmap into a parallel execution
model that can be handed to multiple subagents without causing avoidable merge
conflicts.

It is optimized for:

- parallel implementation
- clear ownership boundaries
- minimal write-set overlap
- preserving the OpenClaw boundary instead of reimplementing platform concerns

This plan assumes the product stance in `docs/DASHBOARD_PRODUCT_STANCE.md` and
the broader maturity scope in `docs/plans/2026-04-05-dashboard-maturity-roadmap.md`.

Operational handoff docs:

- `CLAUDE_HANDOFF.md`
- `docs/plans/2026-04-05-dashboard-subagent-prompts.md`
- `docs/plans/2026-04-05-dashboard-acceptance-matrix.md`
- `docs/plans/2026-04-05-lock-override-spec.md`
- `docs/plans/2026-04-05-dashboard-action-status-spec.md`
- `docs/plans/2026-04-05-openclaw-boundary-matrix.md`
- `docs/plans/2026-04-05-extension-proving-spec.md`
- `docs/plans/2026-04-05-dashboard-release-gate.md`
- `docs/plans/2026-04-05-dashboard-shell-ia-spec.md`

## Current Baseline

Already materially landed:

- core dashboard contracts are much more complete
- domain create/enable/disable/kill paths exist
- config reads and saves are broader and more canonical
- extension registry, extension routes, extension config discovery, and
  capability-aware filtering exist
- runtime/auth mode is exposed and OpenClaw-vs-standalone is visible to the UI
- shell and onboarding coverage in the SPA is now meaningful

Still not mature:

- deepest config fidelity is not fully lossless
- lock/override semantics are not implemented
- async action state and recovery semantics are still shallow
- deployment/runtime hardening is not at release bar
- true end-to-end operator-flow coverage is still missing
- extension platform still needs proving-extension and broader slot/action semantics
- assistant depth is intentionally not on the current critical path

## Non-Negotiable Boundaries

### OpenClaw owns

- plugin discovery, manifests, lifecycle, enable/disable, install/update
- embedded auth/session ownership for OpenClaw-hosted dashboard routes
- route/tool loading infrastructure already handled by the plugin runtime

### ClawForce owns

- dashboard contract semantics
- standalone dashboard server behavior
- runtime metadata and capability contract
- dashboard extension contribution schema and registry
- operator workflows, config fidelity, locks/overrides, action status, audit semantics

### Do not duplicate

- plugin management inside ClawForce
- embedded auth that OpenClaw already owns
- a second source of truth for config/state in the dashboard

## Critical Path

The maturity critical path is:

1. finish config fidelity
2. implement locks/overrides and action-state truthfulness
3. harden runtime/deployment/auth behavior
4. finish shell/operator-flow coherence
5. add end-to-end operator verification
6. prove the extension path with a real extension

Assistant depth is out of critical path unless reprioritized.

## Parallel Work Graph

### Wave 1: Safe To Start Immediately

These tracks can start in parallel today with minimal overlap.

#### Track A. Config Contract And Typing

Goal:
Eliminate simplified config typing and tighten the framework-to-SPA contract.

Primary repos:

- `clawforce`
- `clawforce-dashboard`

Primary write scope:

- `src/api/contract.ts`
- `src/dashboard/queries.ts`
- `src/dashboard/actions.ts`
- `src/api/types.ts`
- `src/hooks/useConfig.ts`
- `test/dashboard/queries*.test.ts`
- `test/dashboard/actions.test.ts`

Key tasks:

- audit every config section returned by `queryConfig()`
- identify remaining simplified fields in the contract
- tighten shared section semantics for richer agent/job/runtime structures
- normalize save/validate responses so the SPA can trust the contract
- remove frontend guessing where backend semantics are already known

Parallelization note:

- this track should avoid editing `ConfigEditor.tsx` except when a contract
  change requires a tiny compatibility shim

Deliverables:

- config fidelity matrix
- tightened config section types
- explicit save/validate contract shapes
- backend tests covering the remaining rich structures

#### Track B. Config Editor Deep-Fidelity

Goal:
Make the deepest remaining config surfaces truly lossless in the SPA.

Primary repo:

- `clawforce-dashboard`

Primary write scope:

- `src/views/ConfigEditor.tsx`
- `src/api/types.ts`
- `src/hooks/useConfig.ts`
- `src/views/ConfigEditor.test.tsx`
- any small supporting editor components created under `src/components/`

Key tasks:

- remove lossy stringification where meaning is discarded
- preserve rich agent briefing sources, expectations, performance policies,
  jobs, runtime knobs, and deeper nested config
- add purpose-built editors where raw JSON is still doing too much work
- align structured editor state with raw JSON and backend validation exactly
- add fidelity-focused tests for rich save/load round-trips

Parallelization note:

- this track should not edit framework contract files unless blocked
- coordinate with Track A on type changes, but keep file ownership SPA-heavy

Deliverables:

- richer editor coverage in `ConfigEditor`
- no silent loss of meaning on structured save
- regression tests for rich structures

#### Track C. Runtime, Auth, Deployment Hardening

Goal:
Raise standalone/embedded deployment behavior to release-grade without
duplicating OpenClaw ownership.

Primary repo:

- `clawforce`

Primary write scope:

- `adapters/openclaw.ts`
- `src/dashboard/auth.ts`
- `src/dashboard/server.ts`
- `src/dashboard/gateway-routes.ts`
- `test/dashboard/auth.test.ts`
- `test/dashboard/server.test.ts`
- `test/dashboard/gateway-routes.test.ts`
- deployment/runtime docs

Key tasks:

- tighten embedded-vs-standalone contract and docs
- harden auth/CORS/header behavior where still ambiguous
- verify asset serving, compatibility mode, and runtime notes
- ensure standalone is explicitly compatibility-oriented, not mistaken for the
  embedded canonical path
- document configuration knobs and upgrade/rollback expectations

OpenClaw boundary:

- embedded auth remains OpenClaw-owned
- ClawForce should only report embedded auth truthfully, not recreate it

Deliverables:

- runtime/auth deployment guide
- hardened tests around embedded/standalone mode
- reduced ambiguity in runtime metadata and server behavior

#### Track D. Shell And IA Cleanup

Goal:
Finish the dashboard shell so it feels like one operator product.

Primary repo:

- `clawforce-dashboard`

Primary write scope:

- `src/App.tsx`
- `src/components/Layout.tsx`
- `src/components/NavBar.tsx`
- `src/components/DomainLayout.tsx`
- `src/components/DomainSwitcher.tsx`
- `src/views/Monitor.tsx`
- `src/views/Workspace.tsx`
- `src/views/Overview.tsx`
- `src/views/OperationsCenter.tsx`
- shell/router tests

Key tasks:

- make one final shell decision and remove dormant competing patterns
- define the operator home story clearly
- ensure navigation order and page roles are intentional
- remove or rewrite stale shell artifacts like the old `DomainLayout` model if
  it will not be used
- make multi-business switching and “where am I operating?” crystal clear

Parallelization note:

- this track should avoid config editor and runtime server files

Deliverables:

- final route map
- final shell model
- removal of unused competing layout patterns

#### Track E. Verification Harness And E2E Operator Flows

Goal:
Move from broad component coverage to real operator-flow confidence.

Primary repo:

- `clawforce-dashboard`

Primary write scope:

- test harness config
- new e2e or route-integration test files
- minimal test helpers under `src/test/`

Key tasks:

- choose the e2e strategy and tool
- cover real flows:
  - create business -> land in config
  - switch business -> operate from shell
  - config edit -> validate -> save -> applied state visible
  - budget edit/allocation
  - approvals path
  - task intervention path
  - direct comms path
  - emergency controls
  - context file editing
- add config-fidelity fixtures

Parallelization note:

- this track should consume existing UI, not redesign it
- prefer adding tests and test helpers over changing product code unless a real
  testability issue is uncovered

Deliverables:

- chosen e2e framework and scripts
- operator-flow suite
- fidelity/regression fixtures

### Wave 2: Can Start Once Wave 1 Surfaces Stabilize

These depend partially on earlier contract or shell work.

#### Track F. Locking, Overrides, And Human Authority

Goal:
Implement the product stance that humans can intervene at any level and can
 lock certain surfaces persistently.

Primary repos:

- `clawforce`
- `clawforce-dashboard`

Primary write scope:

- framework runtime/config for lock storage and enforcement
- dashboard actions/queries exposing lock state
- config/org/budget/rules jobs UI surfaces for lock controls

Key tasks:

- define lock storage and semantics
- define override precedence settings
- implement lock state for:
  - budgets and allocations
  - agent enabled/disabled state
  - org structure
  - rules, jobs, tool gates
  - direction/context surfaces
- add audit entries and UI indicators

Dependencies:

- needs stable config and action contracts first

Deliverables:

- lock model
- UI lock indicators/controls
- runtime honoring of lock semantics

#### Track G. Action Status And Recovery Semantics

Goal:
Make async/accepted actions visible and trustworthy.

Primary repos:

- `clawforce`
- `clawforce-dashboard`

Primary write scope:

- `src/dashboard/actions.ts`
- `src/dashboard/gateway-routes.ts`
- `src/dashboard/sse.ts`
- SPA action hooks/components that initiate kills, disables, budgets, saves
- related tests

Key tasks:

- define accepted/queued/completed/failed model for risky actions
- expose action status via events or queryable status
- show action outcome in the UI instead of relying on immediate optimism
- make retries/idempotency safer
- cover emergency, disable/enable, kill/resume, and config-save failure flows

Dependencies:

- benefits from Track C runtime hardening
- may require some shell/UI work from Track D

Deliverables:

- action-status contract
- UI feedback for async operations
- tests around retries and race conditions

#### Track H. Capability-Driven UX Completion

Goal:
Make every surface distinguish unsupported vs disabled vs empty vs degraded.

Primary repo:

- `clawforce-dashboard`

Primary write scope:

- `src/hooks/useCoreCapabilities.ts`
- `src/api/client.ts`
- remaining views/components with ambiguous empty states
- tests

Key tasks:

- audit remaining views that still blur capability boundaries
- standardize unavailable/degraded/empty messaging
- use capabilities to drive extension and config affordances consistently

Dependencies:

- easier after shell cleanup

Deliverables:

- uniform state treatment across core surfaces
- less frontend guesswork around optional features

### Wave 3: Proving And Release Work

#### Track I. Extension Proving Path

Goal:
Prove the extension platform with a real extension instead of only metadata.

Primary repos:

- `clawforce`
- likely an external OpenClaw plugin repo or plugin package
- `clawforce-dashboard` only if new slots/rendering are needed

Primary write scope:

- `src/dashboard/extensions.ts`
- `src/dashboard/gateway-routes.ts`
- SPA extension slot consumers
- plugin-side contribution registration code
- docs

Key tasks:

- choose the proving extension, likely experiments or another non-core surface
- register real extension pages/panels/actions/config sections
- ensure capability mismatches are visible in the dashboard
- define extension action execution semantics
- add explicit slots on any missing core surfaces the proving extension needs

OpenClaw boundary:

- plugin loading remains OpenClaw-owned
- ClawForce only owns contribution interpretation

Dependencies:

- shell and capability surfaces should be reasonably stable first

Deliverables:

- one real proving extension
- any missing core extension slots
- updated extension docs

#### Track J. Docs, Operator Guide, And Release Gate

Goal:
Turn the current implementation into a shippable, understandable product.

Primary repo:

- `clawforce`

Primary write scope:

- `README.md`
- product stance docs
- roadmap docs
- deployment docs
- operator guide
- extension guide

Key tasks:

- align docs to actual behavior
- document runtime modes and deployment
- document config/editing model
- document lock/override model once implemented
- define release checklist and maturity gates

Dependencies:

- should run continuously, but final pass depends on all earlier tracks

Deliverables:

- operator guide
- builder/extension guide
- deployment/troubleshooting docs
- release checklist

## Suggested Subagent Packing

These are the best independent chunks to hand to Claude subagents.

### Pack 1. Framework Config Contract

Scope:

- `clawforce/src/api/contract.ts`
- `clawforce/src/dashboard/queries.ts`
- `clawforce/src/dashboard/actions.ts`
- framework dashboard tests

Good for:

- backend-heavy worker

### Pack 2. SPA Config Fidelity

Scope:

- `clawforce-dashboard/src/views/ConfigEditor.tsx`
- `clawforce-dashboard/src/hooks/useConfig.ts`
- `clawforce-dashboard/src/api/types.ts`
- `clawforce-dashboard/src/views/ConfigEditor.test.tsx`

Good for:

- frontend-heavy worker

### Pack 3. Runtime/Auth/Deployment

Scope:

- `clawforce/adapters/openclaw.ts`
- `clawforce/src/dashboard/auth.ts`
- `clawforce/src/dashboard/server.ts`
- `clawforce/src/dashboard/gateway-routes.ts`
- docs/tests for runtime behavior

Good for:

- framework/platform worker

### Pack 4. Shell And IA

Scope:

- `clawforce-dashboard/src/App.tsx`
- `clawforce-dashboard/src/components/Layout.tsx`
- `clawforce-dashboard/src/components/NavBar.tsx`
- `clawforce-dashboard/src/components/DomainLayout.tsx`
- relevant shell tests

Good for:

- product-shell/frontend worker

### Pack 5. E2E And Operator-Flow Tests

Scope:

- `clawforce-dashboard/src/test/`
- new route/e2e test files
- package/test tooling if needed

Good for:

- verification-focused worker

### Pack 6. Locks And Overrides

Scope:

- framework lock storage/enforcement
- dashboard surfaces showing lock state

Good for:

- full-stack worker after config contract stabilizes

### Pack 7. Action Status And Recovery

Scope:

- framework action-status contract and events
- dashboard action feedback components

Good for:

- full-stack reliability worker after runtime contracts stabilize

### Pack 8. Extension Proving Path

Scope:

- extension slots/contracts in core
- proving extension implementation outside core
- docs

Good for:

- extension/platform worker

## File-Overlap Warnings

Avoid assigning these to multiple workers at once unless one worker is read-only:

- `clawforce-dashboard/src/views/ConfigEditor.tsx`
- `clawforce-dashboard/src/api/types.ts`
- `clawforce-dashboard/src/App.tsx`
- `clawforce-dashboard/src/components/NavBar.tsx`
- `clawforce/src/dashboard/gateway-routes.ts`
- `clawforce/src/dashboard/actions.ts`
- `clawforce/src/dashboard/queries.ts`
- `clawforce/adapters/openclaw.ts`

## Recommended Execution Order

If you want maximum parallelism without chaos:

1. start Packs 1, 2, 3, 4, and 5 together
2. merge Pack 1 before finishing Pack 2 if type contracts changed materially
3. start Pack 6 after Pack 1 stabilizes
4. start Pack 7 after Pack 3 stabilizes
5. start Pack 8 after Pack 4 and capability surfaces stabilize
6. keep Pack 9 docs/release work running in the background continuously

## Definition Of Done

Do not call the dashboard mature until all of these are true:

- no known lossy config sections remain
- locks and override semantics are real and audited
- standalone vs embedded runtime behavior is documented and tested
- the shell has one intentional operator-home model
- critical operator flows are covered end-to-end
- extension path is proven with a real non-core extension
- OpenClaw boundaries are preserved instead of duplicated
- release/deployment/operator docs match the actual product
