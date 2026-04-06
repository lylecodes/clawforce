# Dashboard Maturity Roadmap

> Last updated: 2026-04-05

## Goal

Reach a state where the base ClawForce dashboard is the default operator surface
for all ClawForce core capabilities, with:

- no fake controls
- no hidden file-first workflows
- no lossy config edits
- no core behavior that is dashboard-inaccessible
- no framework/dashboard contract drift
- a first-run experience that supports a serious operator running multiple businesses
- real extension points for everything outside core

This roadmap assumes the product stance in
`docs/DASHBOARD_PRODUCT_STANCE.md` is canonical.

For parallel execution planning and subagent packing, see
`docs/plans/2026-04-05-dashboard-parallel-execution-plan.md`.

For post-dashboard platform planning, see:

- `docs/plans/2026-04-05-extension-ecosystem-roadmap.md`
- `docs/plans/2026-04-05-public-api-sdk-roadmap.md`

## Definition Of Mature

The dashboard should be considered mature when all of the following are true:

- a user can create, configure, run, and intervene in a domain entirely from the dashboard
- every ClawForce core read surface has a dashboard view
- every ClawForce core mutation has a real audited dashboard workflow
- every visible control maps to a real core contract
- structured editors and raw editors round-trip the same data without loss
- assistant/operator flows are first-class, not fallback hacks
- domain switching and multi-business workflows feel intentional
- extensions can add pages, panels, and actions without patching core
- auth, packaging, and deployment are production-ready
- frontend and backend verification cover the critical operator loop end to end

## Current State

Framework-side dashboard maturity has materially improved:

- core domain controls are now real
- budget allocation is wired
- health exposes runtime truth
- config reads are broader and more truthful
- config saves are more canonical
- assistant routing is honest and configurable
- context files and config history are served through the real gateway

But the system is not mature yet because the remaining gaps are structural, not
cosmetic:

- assistant runtime is still shallow
- config fidelity is incomplete for richer structures
- frontend shell is much more coherent now, but still needs final IA cleanup and
  broader route-to-route operator-flow hardening
- capability-aware UX is underused
- extension architecture is now real across framework and SPA, but still needs a proving extension plus broader surface coverage
- frontend verification is behind backend verification
- packaging and deployment are not yet product-grade, even though runtime/auth boundaries are now more explicit

## Workstreams

### 1. Canonical Contract Completion

Objective:
Make the dashboard/backend contract exhaustive, explicit, and version-safe.

Remaining work:

- inventory every core read and mutation and map it to a dashboard route
- define which actions are sync vs accepted/async vs streaming
- normalize response envelopes and error semantics
- remove any remaining hidden fallback behavior from sync action paths
- expose missing core surfaces where the framework supports them but the dashboard does not
- tighten contract typing across framework and SPA so the frontend is not guessing

Deliverables:

- complete endpoint matrix for core reads and writes
- capability metadata per surface/action
- stable response and error shapes in `src/api/contract.ts`
- matching dashboard client types in `clawforce-dashboard/src/api/types.ts`

Acceptance criteria:

- no core action requires CLI or file edits
- no UI flow depends on undocumented backend behavior
- the frontend no longer has to coerce unknown config payloads into shape

### 2. Assistant And Operator Console

Objective:
Turn the assistant from a polite router into a real operator backend.

Remaining work:

- define assistant modes explicitly: operator console, setup helper, direct-to-lead comms
- support real live session targeting, not only stored fallbacks
- support clear distinction between:
  - send a direct human message to an agent
  - ask the assistant to operate the system
  - ask the assistant to route a request into the org
- add assistant session history and thread continuity
- define assistant-visible capabilities and constrained actions
- support command execution against core contracts with auditability
- improve streaming protocol and partial/failure states in the widget
- surface configured assistant target and disabled/degraded states in UI
- add richer human-to-lead and human-to-org communication workflows

Deliverables:

- operator-console backend service model
- assistant command/action grammar over core contracts
- better assistant widget state model in `src/hooks/useAssistant.ts`
- explicit assistant configuration UI in the config editor
- audit entries for operator-issued assistant actions

Acceptance criteria:

- the assistant can perform real dashboard-supported operations
- the user can intentionally choose assistant vs direct lead messaging
- degraded assistant states are visible and understandable

### 3. Lossless Config Round-Tripping

Objective:
Guarantee that the dashboard can edit all core config safely and without loss.

Remaining work:

- audit every config surface against canonical core config
- eliminate flattened/simplified UI-only models where they lose meaning
- support richer shapes for:
  - agent briefing sources
  - expectations
  - performance policy
  - jobs and job-level briefing/expectations
  - scheduling
  - coordination
  - memory governance
  - observe/streams
  - domain defaults
  - role defaults
  - team templates
  - tool gates
  - event handlers
  - workflows
  - knowledge config
  - safety and enforcement knobs
  - dashboard assistant config
- decide which sections get:
  - structured editor only
  - raw editor only
  - dual structured/raw editing
- unify validation and preview behavior with actual persisted semantics
- support exact diff previews for config saves
- make file-backed docs and config-backed fields feel like one product, not two systems

Frontend-specific debt:

- `clawforce-dashboard/src/views/ConfigEditor.tsx` still normalizes rich values to simple strings
- `clawforce-dashboard/src/api/types.ts` still models config in a simplified shape
- `clawforce-dashboard/src/hooks/useConfig.ts` still relies on defensive unwrapping rather than a tight contract

Current foundation:

- the main core config sections now have purpose-built structured editors instead
  of raw-only tabs, including:
  - defaults
  - role defaults
  - team templates
  - profile
  - workflows
  - knowledge
  - rules
  - event handlers
  - safety
  - dashboard assistant
- the remaining config-fidelity gap is now less about missing UI affordances and
  more about richer round-tripping semantics for the deepest agent/job/runtime
  shapes

Deliverables:

- section-by-section fidelity matrix
- typed config schema shared or generated across framework and SPA
- richer editors for agent and defaults surfaces
- raw editor escape hatch for complex sections
- change preview based on canonical diff, not best-effort field comparison

Acceptance criteria:

- editing through the dashboard cannot silently discard meaningful config
- a raw save and a structured save produce the same persisted semantics

### 4. Locking, Overrides, And Human Authority

Objective:
Encode the product stance on autonomy and manual control in runtime and UI.

Remaining work:

- define lock storage and runtime semantics
- implement lockable core surfaces:
  - budgets and allocations
  - agent enabled/disabled state
  - org structure
  - rules, jobs, tool gates
  - docs and standards surfaces
- implement configurable override precedence
- show when a value is:
  - autonomous
  - manually changed but not locked
  - explicitly locked by a human
- ensure agents honor those locks at runtime
- add audit history for lock/unlock and override actions

Deliverables:

- lock model in framework config/runtime
- UI indicators and controls for lock state
- policy controls for override precedence

Acceptance criteria:

- user involvement can range from light oversight to full manual control
- the autonomy model is explicit rather than implicit

### 5. Shell Consolidation And Information Architecture

Objective:
Make the base dashboard feel like one coherent product.

Remaining work:

- choose the primary shell model:
  - workspace-first
  - section-first
  - hybrid with clear roles
- remove or revive dormant patterns intentionally
- restore real domain switching
- expose the full core surface in navigation by default
- make multi-business operation first-class
- unify embedded vs standalone views for tasks/comms/config/monitoring
- design clear primary workflows:
  - operate today
  - configure org
  - inspect health
  - intervene in work
  - communicate with leads

Concrete current gaps:

- `clawforce-dashboard/src/App.tsx` now exposes more of core (`workspace`, `overview`, `ops`, `org`, `tasks`, `approvals`, `comms`, `config`, `extensions`), but the product still needs a final shell decision instead of incremental surface growth
- `clawforce-dashboard/src/components/DomainLayout.tsx` contains a richer but unused shell
- `clawforce-dashboard/src/components/NavBar.tsx` now supports active switching, capability annotations, and a searchable multi-business picker, but the final information architecture is still not locked
- core views, including `workspace`, now share a real select-or-create-business empty state instead of dead-end per-page copy, but the shell still needs one final “operator home” story

Deliverables:

- final shell architecture
- final route map
- real domain switcher and multi-domain context model
- consistent page layout and operator navigation

Acceptance criteria:

- the base dashboard clearly exposes the whole core product
- a user running multiple businesses can navigate and operate cleanly

### 6. Capability-Driven UX

Objective:
Make the UI truthful about what exists, what is enabled, and what is unavailable.

Remaining work:

- continue consuming backend capabilities in the SPA beyond the current extension registry and top-nav annotations
- distinguish between:
  - unsupported
  - disabled
  - unconfigured
  - empty
  - degraded
  - healthy
- configure surface visibility without hardcoding false assumptions
- use capability metadata to drive assistant affordances and config sections

Deliverables:

- capability hooks/selectors in the dashboard SPA
- UI states for unavailable vs empty vs disabled
- visibility model for optional surfaces

Acceptance criteria:

- the UI never implies a feature exists when it does not
- capability changes do not require frontend guesswork

### 7. First-Run, Onboarding, And Multi-Business Setup

Objective:
Make the product usable by the design-center user on day one.

Remaining work:

- define first-run flow for a new operator:
  - create/select business
  - create domain
  - define org
  - assign leads
  - configure budget and allocations
  - configure direction/policies/standards
  - validate health and start operations
- add templates/scaffolding for common org shapes
- support demo mode without confusing it for production setup
- support empty-state guidance in every core surface
- support cross-domain navigation for users running multiple businesses

Deliverables:

- real onboarding wizard or guided setup mode
- domain creation and initial config flows in dashboard
- first-run empty states across workspace/config/comms/monitoring

Acceptance criteria:

- a new user can reach a functioning deployment without touching files

### 8. Extensibility Platform

Objective:
Make “base dashboard + extensions” real rather than conceptual.

Remaining work:

- keep OpenClaw as the loader/lifecycle owner; do not reimplement plugin management in ClawForce
- define extension API for:
  - custom pages
  - extra panels/cards
  - custom actions
  - custom workflows
  - capability registration
  - navigation registration
- define extension loading and isolation model
- define how extensions interact with audit, auth, and capabilities
- define extension-safe state and API access patterns
- document how non-core features stay out of base but integrate cleanly

Current foundation:

- framework-side contribution registry exists in `src/dashboard/extensions.ts`
- OpenClaw plugins can target it via `clawforce/dashboard/extensions`
- gateway exposes loaded extension metadata at `GET /clawforce/api/extensions`
- dashboard SPA consumes the registry for:
  - extension nav items
  - dynamic extension page routes
  - a generic extension page host
  - capability-aware filtering through `/capabilities`
  - extension slots in `overview` and `monitor`
  - extension-owned config section discovery in `config`
  - a dedicated extension registry screen at `/extensions`
- architecture doc: `docs/DASHBOARD_EXTENSION_ARCHITECTURE.md`

Deliverables:

- extension contribution manifest and registry
- extension UI injection points across all intended core surfaces
- extension contract docs
- one example extension proving the model

Acceptance criteria:

- non-core features do not leak into base dashboard
- domain-specific surfaces can ship without forking core
- operators can discover loaded extensions, their routes/config surfaces, and any domain capability mismatch directly from the dashboard

### 9. Packaging, Runtime Wiring, Auth, And Deployment

Objective:
Make the dashboard product shippable, operable, and secure.

Remaining work:

- define standalone vs embedded deployment story clearly
- tighten auth/session behavior around dashboard routes without duplicating OpenClaw plugin auth
- validate CORS and gateway integration paths
- define runtime configuration for dashboard deployment
- improve asset serving and version compatibility behavior
- document upgrade and rollback expectations
- ensure package-level entrypoints reflect the intended product story

Current foundation:

- the dashboard now exposes `GET /clawforce/api/runtime` so the SPA can explain whether it is running:
  - embedded in OpenClaw
  - standalone with bearer-token auth
  - standalone in localhost-only mode
- the embedded OpenClaw route now reports OpenClaw-owned auth explicitly instead of pretending ClawForce owns that session model
- the OpenClaw adapter now treats the standalone dashboard server as a compatibility layer, not the canonical embedded runtime
- the standalone compatibility server can be disabled via plugin config/env instead of being unconditionally started
- shared security headers are applied by both the embedded gateway handler and the standalone server
- the dashboard `Extensions` screen now shows runtime/auth mode and notes so operators can see which boundary they are actually using
- framework and dashboard verification now cover the runtime contract and shared security-header behavior

Deliverables:

- production deployment guide
- auth and gateway integration guide
- runtime configuration reference
- compatibility notes between framework and dashboard versions

Acceptance criteria:

- a serious user can deploy and upgrade the dashboard intentionally

### 10. Reliability, State, And Recovery

Objective:
Make the operator surface trustworthy under failure and change.

Remaining work:

- harden SSE reconnect and stale-state recovery
- add idempotency or safe retry behavior for risky actions
- make async action status visible in the UI
- surface degraded runtime states clearly
- tighten error handling around config saves and live session routing
- verify emergency stop, disable, enable, kill, and resume flows end to end
- ensure action outcomes stay consistent during race conditions

Deliverables:

- action status model for queued/accepted/completed/failed
- reconnect-safe live update model
- clearer degraded-state banners and recovery paths

Current foundation:

- the dashboard SPA now keeps one SSE connection per known business instead of
  binding live updates only to the currently active business
- realtime workspace events are tagged with their source business so
  cross-business activity views do not collapse into the active-domain context
- the connection banner now scopes itself to the active business instead of
  showing misleading global-disconnect noise when no business is selected
- degraded workspace fan-out queries now return safe empties for unavailable or
  slow `events`, `costs`, and `org` endpoints, so one weak business no longer
  poisons the full workspace
- focused SPA coverage now exercises multi-business SSE behavior, connection
  banner scoping, degraded client fallbacks, and workspace activity-feed
  merging

Acceptance criteria:

- the dashboard behaves predictably when runtime connectivity is partial or unstable

### 11. Verification And Quality

Objective:
Raise frontend and end-to-end confidence to match backend rigor.

Remaining work:

- add dashboard SPA test runner and scripts
- add component tests for core operator surfaces
- add contract tests between SPA client and framework responses
- add end-to-end flows for:
  - onboarding
  - domain switching
  - agent config save/apply
  - budget edits and allocations
  - approvals
  - task intervention
  - direct messaging
  - assistant/operator flows
  - emergency controls
  - context file editing
- add regression fixtures for rich config round-tripping
- add compatibility tests around capability gating

Current concrete gap:

- `clawforce-dashboard` now has a real `npm test` harness with focused
  component and client coverage, but it still lacks a broader end-to-end
  operator test story comparable to the framework dashboard suite
- the top shell, workspace, ops, config, and not-found recovery surfaces now
  have direct component coverage, but route-level and multi-step operator flows
  still need true end-to-end coverage
- the remaining core operator views now also have direct coverage for:
  - `Overview` business-required state and summary/approval behavior
  - `OrgChart` business-required state and single-business auto-recovery
- the Businesses screen now has direct route-level coverage for:
  - no-business onboarding
  - single-business auto-redirect
  - create-business entry from the monitor shell
- the first-session onboarding path now also has direct route/component coverage
  for:
  - starter-domain creation landing in `Config`
  - welcome-screen starter mode selection
  - demo creation from the empty Businesses screen landing in `Overview`
- the live router now also has direct coverage for:
  - index route mounting inside the shared shell
  - extension route mounting
  - wildcard-route fallback to a dedicated recovery surface

Deliverables:

- frontend unit/component test harness
- e2e test suite
- golden fixtures for config fidelity

Acceptance criteria:

- critical operator flows are covered automatically
- config round-trip regressions are caught before release

### 12. Documentation And Product Coherence

Objective:
Make the system understandable to operators and builders.

Remaining work:

- keep stance, architecture, API, and UX docs aligned
- document every core dashboard surface
- document assistant/operator behavior
- document onboarding and deployment
- document extension model
- document lock/override semantics once implemented

Deliverables:

- operator guide
- builder/extension guide
- deployment and troubleshooting docs
- contract reference for dashboard integrations

Acceptance criteria:

- docs describe the actual product, not the intended one

## Recommended Sequencing

### Phase 0. Contract And Scope Freeze

- freeze the core surface list for base dashboard
- freeze what is explicitly not core
- freeze the assistant role and extension boundary
- freeze the shell direction before large frontend rewrites

### Phase 1. Finish Core Control Plane

- complete canonical contracts
- close remaining action/read gaps
- finish truthful assistant routing and operator semantics
- add capability metadata where missing

### Phase 2. Make Config Safe

- finish lossless config round-tripping
- upgrade frontend config types and editors
- add fidelity fixtures and save validation

### Phase 3. Consolidate The Shell

- pick final IA and routing
- restore real domain switching
- expose the full core surface
- remove dead shell patterns and non-core confusion

### Phase 4. Build The Real Operator Console

- richer assistant backend
- clear assistant/direct-message UX
- live targeting, history, command execution, degraded states

### Phase 5. First-Run And Multi-Business Experience

- guided setup
- empty states
- multi-domain workflows
- production-oriented operator loop

### Phase 6. Extensibility

- extension runtime
- extension API
- example extension

### Phase 7. Reliability, Packaging, And Auth

- deployment hardening
- runtime recovery
- auth/session polish
- release readiness

### Phase 8. Verification And Release Gate

- frontend tests
- e2e flows
- release checklist

## Execution Priorities

If the goal is maximum maturity with the highest leverage ordering, do this:

1. finish config fidelity
2. finish the assistant/operator backend
3. consolidate the dashboard shell
4. ship first-run and multi-business workflows
5. build the extension platform
6. harden deployment/auth/reliability
7. raise frontend/e2e verification to release bar

Why this order:

- config fidelity is the biggest trust risk
- assistant quality is the biggest product gap
- shell consolidation unlocks the rest of the UI
- onboarding and multi-business flows matter directly to the design-center user
- extension work should follow a stable shell and stable contracts

## Release Gates

Do not call the dashboard mature until all of these are true:

- no known lossy config sections remain
- no core feature is dashboard-inaccessible
- assistant/operator flows are first-class and tested
- the shell exposes the full core surface coherently
- multi-domain operation is intentional
- extensions have a documented supported path
- frontend and backend critical flows are covered by automated tests
- deployment/auth/recovery docs are good enough for an external operator
