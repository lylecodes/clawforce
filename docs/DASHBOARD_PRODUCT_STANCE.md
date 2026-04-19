# Dashboard Product Stance

> Last updated: 2026-04-05

## Summary

The base dashboard is the default control plane and observability surface for
all ClawForce core capabilities.

The framework remains the source of truth. The dashboard is the complete UI
over framework-owned contracts. Anything outside ClawForce core belongs in
extensions or addons, not in the base dashboard.

## Design Center

The base dashboard is designed first for a solo technical operator running
multiple businesses.

That user may want very different involvement levels over time:

- light oversight while agents run autonomously
- targeted intervention in budgets, staffing, routing, or approvals
- full hands-on manual operation when needed

The base product must support all three.

## Product Boundary

### Framework owns

- canonical schemas and semantics
- runtime config and persistence
- task, approval, budget, trust, comms, health, audit, and queue behavior
- query, action, and event contracts
- versioning and compatibility

### Base dashboard owns

- the full UI over all ClawForce core contracts
- default operator workflows
- visibility into runtime state
- structured editors and raw editing surfaces
- manual controls over all core capabilities

### Extensions own

- anything not in ClawForce core
- domain-specific pages and workflows
- extra cards and custom actions beyond the shared core surface

## Core Dashboard Stance

### Base dashboard scope

The base dashboard should expose everything available from ClawForce core.

That includes:

- domains
- org and agents
- tasks
- approvals
- budgets and allocations
- config and context docs
- messaging and meetings
- health, telemetry, trust, audit, queue, and operational views

Experiments are not part of ClawForce core and should not be treated as a base
dashboard requirement.

### Source of truth

Framework-owned config and state are the source of truth.

The dashboard must not become a parallel state system. It should be a complete
UI over framework-owned behavior.

### Apply model

Dashboard changes apply immediately to runtime by default.

The product should not require users to edit YAML or markdown manually for
normal operation. Files may still exist under the hood, but the dashboard must
be sufficient for serious use.

## Human vs Agent Responsibility

### Agent-owned by default

For v1, agents should own these modeled operational behaviors by default:

- task decomposition
- task routing
- scheduling
- staffing and splitting agents
- budget reallocation

### Not yet core-autonomous

These should remain more manual or explicitly supervised until they are proven
through a research loop:

- context evolution
- policy tuning

ClawForce core should not do unmodeled “magic.” If behavior matters, it should
be explicitly modeled in the framework first.

### Human powers

Humans should be able to manually perform any ClawForce core action from the
dashboard if they want.

That includes:

- creating and configuring domains
- adding, editing, disabling, enabling, and restructuring agents
- editing org, budget, rules, jobs, safety, tool gates, and docs
- reassigning or intervening in work
- approving and rejecting proposals
- sending messages and using meetings/comms
- using emergency controls such as disable, kill, and resume
- inspecting telemetry, trust, audit history, queue status, and health

## Override and Lock Model

Override precedence must be configurable.

### Default override behavior

By default, agents retain autonomy unless the human explicitly locks a change.

### Default lock behavior

Locks persist until a human explicitly removes them.

### Lockable by default in v1

- budgets and allocations
- agent enabled/disabled state
- org structure
- rules, jobs, and tool gates
- direction, policies, standards, and context docs

### Task exception

Tasks should not become a general-purpose lock surface in v1.

Humans should still be able to intervene for stop/kill purposes, but “remove a
task” should mean cancel/archive with a full audit trail, not hard delete.

## Assistant Stance

The dashboard assistant should be primarily an operator console.

Secondary role:

- help with setup and onboarding when needed

First-class behavior:

- direct user-to-lead communication
- operator requests routed into the agent team
- shared comms state between Codex/chat surfaces and the dashboard UI
- decision inbox kept separate from normal operator chat

## UI and Editing Model

### Surface visibility

The base dashboard should show the full ClawForce core surface by default.

Visibility and customization should still be configurable so operators can
tailor the shell to their own workflow.

### Editing model

Both of these should be first-class:

- structured editors and forms
- raw config and document editing

Neither should be treated as a second-class fallback.

## First-Run Experience

The expected first-time flow is:

1. Create or select a business/domain.
2. Define the org and agents.
3. Set budgets and allocations.
4. Set direction, policies, and standards.
5. Review the roster and core config.
6. Start operations.
7. Watch tasks, approvals, comms, and health from the dashboard.

## Hard Product Lines

These are non-negotiable:

- no fake controls
- no hidden file-first behavior
- no base dashboard feature without a core contract behind it
- no implicit behavior outside explicitly modeled core behavior
- no unaudited actions
- no framework/dashboard fragmentation

## Extensibility

The minimum extension surface for v1 is:

- custom pages in navigation
- extra cards and panels on core screens
- custom actions and workflows backed by framework contracts

## Current Gap Map

The product stance above is not fully reflected in the current codebase yet.

### 1. Packaging and product entry are not finished

- `serveDashboard()` now starts the standalone dashboard server instead of
  remaining a stub.
- The broader package-level story still needs stronger runtime wiring and
  documentation, but the entry point is now real.

### 2. Core action coverage is incomplete

- some assistant/operator-console behavior still depends on fallback routing
  rather than a fully live assistant runtime
- some direct synchronous dashboard action paths still degrade to placeholder
  behavior even though the real gateway covers the equivalent async flows

### 3. Config round-tripping is incomplete

- `queryConfig()` now hydrates more sections truthfully, including safety,
  profile, initiatives, rules, memory, and jobs
- the remaining risk is fidelity, not emptiness: some structured editors still
  expose only a simplified projection of richer core config
- that means the dashboard still cannot claim fully lossless round-tripping for
  every core section yet

### 4. The shell is mid-transition

- the app router exposes only a subset of the existing view model
- there is an unused richer `DomainLayout` section shell
- there is an unused clickable `DomainSwitcher` while the active navbar only
  shows passive pills

### 5. Capability-driven UX is underused

- the backend already exposes a capabilities endpoint
- the frontend does not use it to distinguish “supported but empty” from “not
  installed / not core / not available”

### 6. Frontend verification is behind backend verification

- the dashboard frontend typechecks cleanly
- the framework dashboard tests are strong
- the SPA itself does not yet have equivalent automated test coverage

## Recommended Implementation Sequence

The maturity path should be executed in this order:

### 1. Finish core action coverage

- make every base dashboard control hit a real core contract
- no `501` placeholders for core operator actions
- make domain enable, disable, kill, and resume behavior truthful
- make health state expose the runtime facts the UI depends on

### 2. Make config round-tripping exact

- remove placeholder config sections from `queryConfig()`
- ensure structured editors and raw editors round-trip the same data
- block lossy save flows until every section can be preserved

### 3. Consolidate the shell

- stop carrying multiple half-finished navigation and layout models
- make the default shell reflect the full core surface cleanly
- restore or remove dormant section patterns intentionally

### 4. Make capability-driven UX real

- use capability discovery to distinguish unavailable vs empty vs unconfigured
- avoid showing fake affordances for contracts that are not present
- keep the default shell broad, but make visibility configurable

### 5. Raise frontend verification to the same bar

- cover onboarding, config save/apply, approvals, agent controls, and comms
- add end-to-end checks for the main “operate the org from the dashboard” loop

## Current Slice Status

The first framework-side slice has started:

- top-level domain `enable`, `disable`, and `kill` controls are now wired into dashboard API flows
- domain `enable` now also clears emergency stop so the current UI can resume a killed domain
- agent and domain kill actions now use the registered kill runtime instead of returning only placeholders at the route layer
- `budget/allocate` now uses the existing core budget allocator instead of a dashboard-only placeholder
- the assistant route now falls back to routing operator requests to a real lead when no live assistant session is wired
- the assistant route now honors domain `dashboard_assistant` config, supports
  `@agent-id` directives inside the assistant channel itself, and uses a
  single per-request config read so configured targeting is deterministic
- `health` now returns `emergencyStop` and `domainEnabled`, matching what the workspace UI already expects
- `serveDashboard()` now launches the real standalone dashboard server through the package entry
- dashboard config reads now hydrate safety, profile, initiatives, rules,
  memory, and jobs from real core config instead of empty placeholders
- dashboard config saves now alias profile and initiatives back to canonical
  core keys, and jobs now save as a section-level replacement for project
  agents rather than a lossy partial merge
- dashboard config now exposes and saves `dashboard_assistant` as a first-class
  core section, and save validation rejects assistant targets outside the domain
- dashboard agent saves now map the UI array shape onto canonical core storage:
  global agent definitions are upserted and the domain agent roster is updated
  separately instead of trying to write UI objects directly into the domain YAML
- the Budget tab contract is now aligned with core semantics on the backend:
  budget limits still persist under `budget`, but `operational_profile` and
  initiative allocations are split back into their canonical top-level sections
  and are hydrated back into the budget response for the existing editor
- the real gateway now serves `context-files`, so Direction and Context editing
  work through the shipped dashboard handler
- the real gateway now serves config version history through both
  `/config/versions` and the legacy `/config-versions` alias
- the remaining sync dashboard action paths no longer fail with explicit `501`
  placeholders for core controls: direct agent messages persist immediately,
  and kill actions are accepted and delegated to the async runtime helpers
- agent briefing entries now render more truthfully for dashboard editing,
  including file-backed sources like `file: context/ops.md`, and save flows can
  parse those labels back into structured context sources instead of degrading
  them into raw source names

That completes part of step 1. Remaining step-1 work still includes:

- a richer operator-console backend for the assistant surface beyond live-delivery and lead-routing fallback
- any other core actions still degrading to placeholder behavior in non-gateway
  paths

The current highest-risk step-2 work is:

- preserving richer job definitions beyond the simplified structured editor
- preserving richer agent/config structures beyond the current simplified
  editor projections
- making context/defaults/doc editing round-trip as faithfully as the
  underlying file/config model

## What “Mature” Means

The base dashboard should be considered mature when all of the following are
true:

- every ClawForce core read surface is visible in the base dashboard
- every ClawForce core mutation has a real dashboard workflow
- no visible control is placeholder or fake
- config can round-trip all core sections without loss
- the operator can onboard and run a serious deployment without touching files
- extension points are real and documented
- end-to-end tests cover onboarding, config, approvals, comms, agent controls,
  and emergency flows
