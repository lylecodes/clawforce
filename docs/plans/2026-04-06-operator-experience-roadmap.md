# Operator Experience Roadmap

> Last updated: 2026-04-06

See also:
[2026-04-11-operator-feed-and-decision-inbox.md](/Users/lylejens/workplace/clawforce/docs/plans/2026-04-11-operator-feed-and-decision-inbox.md)
for the canonical feed, decision inbox, and item taxonomy model that should sit
under `Today`, notifications, approvals, and operator-facing issue handling.

## Goal

Define the next product layer after dashboard maturity: turn the dashboard from
“real control plane” into a genuinely strong operator cockpit for a solo
technical operator running multiple businesses.

This roadmap assumes the dashboard maturity push is the current implementation
priority and should not interrupt it. This is the next-phase plan.

## Core Principle

Trust first. Convenience second. Intelligence third.

That means:

1. make change truth, history, provenance, and safe rollback real
2. make the app faster and clearer for daily operation
3. only then add broader operator intelligence and polish

## Locked Product Decisions

These are already decided for this phase:

- `Overview` remains the domain home
- `Today` is a primary action widget inside `Overview`, not a new top-level page
- `Today` should be filterable, with action-oriented defaults
- clicking a `Today` item should deep-link into the correct surface with context
  already loaded
- multi-business UX should be grouped by business first
- a single merged global queue can come later
- first serious search should be find-and-jump search, not deep history/doc
  search
- dashboard inbox is the canonical notification source of truth
- external delivery is routed from canonical notifications
- OpenClaw should own delivery transports where possible
- notification policy should use global defaults plus business overrides
- personalization should stay light and useful
- saved views matter more than arbitrary custom layouts
- revert should start with safe structural surfaces, not general operational undo

## Definition Of Success

This phase should be considered successful when:

- operators can understand what changed, why, and by whom without hunting
- `Overview` immediately tells the user what needs attention now
- multi-business operation feels deliberate instead of bolted on
- finding and jumping to relevant entities is fast
- notifications feel like a routed system, not just badge spam
- operators can tailor the app to their workflow without fragmenting core UX
- extension surfaces feel integrated into the operator model instead of tacked on

## Execution Order

The order is intentional. Do not reshuffle it casually.

1. operator confidence/history/revert
2. `Today` inside `Overview`
3. multi-business rollups and workflows
4. find-and-jump search / command palette
5. notifications
6. light personalization and saved views
7. extension UX polish

## Workstreams

### 1. Operator Confidence, History, And Safe Revert

Objective:
Make the app trustworthy enough that an operator can understand and safely undo
structural changes.

Why first:

- everything else gets better once change truth exists
- revert without a real history model becomes fake fast

Required capabilities:

- unified change history
- human vs agent vs system provenance
- before/after diffs
- resource-level history for:
  - config sections
  - docs/context files
  - budgets and allocations
  - org and agent structure
  - lock/unlock state
- audit-linked UI history
- safe revert for structural changes only

Explicit non-goals for v1 of this layer:

- general operational undo for tasks
- undoing approvals
- undoing comms/messages
- undoing meetings
- undoing kill/emergency actions

Deliverables:

- canonical change timeline model
- resource history views
- diff UI
- safe revert actions for structural surfaces

Acceptance criteria:

- operators can see who changed a structural value and what changed
- structural revert is available where semantics are deterministic
- the app does not imply unsafe actions are reversible when they are not

### 2. `Today` In `Overview`

Objective:
Make the domain home useful immediately by surfacing what actually needs human
attention now.

Product shape:

- `Today` lives inside `Overview`
- it is a high-priority action widget, not a decorative summary block
- default focus is action-needed items
- it is filterable

Recommended filters:

- `Needs action`
- `Watching`
- `All`

Possible later category filters:

- `Approvals`
- `Budget`
- `Comms`
- `Ops`
- `Config`

Required interaction rule:

- clicking an item routes to the right surface with domain, filters, and entity
  focus already loaded

Examples:

- approval item -> `Approvals` with queue focused
- budget alert -> `Ops` or `Config` with budget context focused
- unread lead comm -> `Comms` on the right thread
- config conflict -> history/diff view on that resource

Deliverables:

- `Today` data model
- `Overview` widget
- deep-link and focus contract across destination pages

Acceptance criteria:

- `Overview` becomes the clear domain operating home
- operators do not have to hunt after clicking a `Today` item

### 3. Multi-Business Rollups And Workflows

Objective:
Make multiple businesses manageable without collapsing into one noisy queue.

Locked direction:

- grouped by business first
- optional merged global queue later

Required capabilities:

- business-level “attention needed” rollups
- business-level summaries for:
  - approvals
  - unread comms
  - budget pressure
  - operational failures/degraded states
  - config conflicts or important changes
- business drill-in from rollup cards
- shared mental model between `Businesses`, `Overview`, and `Workspace`

Later capability:

- optional cross-business merged queue for expert operators

Deliverables:

- business rollup model
- multi-business summary surfaces
- clear drill-in flows

Acceptance criteria:

- operators can tell which business is on fire without opening each one
- grouped-by-business remains the primary model

### 4. Find-And-Jump Search And Command Palette

Objective:
Make navigation and action execution fast.

Locked direction:

- navigation search first
- deep history/doc search later

First serious search scope:

- businesses
- agents
- tasks
- approvals
- comms threads
- config sections
- pages/views
- extensions

Primary use cases:

- jump to a business
- jump to an agent
- jump to a task/approval/thread
- open a config section directly
- trigger high-confidence operator commands

The command palette and search should likely share one surface.

Deliverables:

- global command/search entrypoint
- typed result model
- deep links and quick actions

Acceptance criteria:

- operators can find and jump to major entities quickly
- search is useful before deep indexing exists

### 5. Notifications

Objective:
Turn notifications into a real routed system instead of passive badges.

Locked direction:

- dashboard inbox is canonical
- external delivery is routing, not source of truth
- OpenClaw should own transport delivery when embedded
- policy uses global defaults plus business overrides

Recommended base model:

- category:
  - `approval`
  - `comms`
  - `budget`
  - `ops`
  - `config`
  - `extension`
- severity:
  - `critical`
  - `high`
  - `normal`
  - `low`
- actionability:
  - `needs_action`
  - `watching`
  - `fyi`
- delivery targets:
  - `dashboard`
  - `telegram`
  - `slack`
  - `discord`

Policy stack:

1. system defaults
2. operator global preferences
3. business/domain overrides

Deliverables:

- canonical notification record
- inbox UI
- delivery status model
- routing settings UI

Acceptance criteria:

- every important notification exists in-app first
- external delivery failures do not erase in-app truth
- policy is understandable and overridable by business

### 6. Light Personalization And Saved Views

Objective:
Adapt the app to the operator without turning it into a build-your-own-dashboard
product.

Locked direction:

- light personalization first
- saved operational views before arbitrary custom layouts

Recommended capabilities:

- choose default landing surface
- pin businesses
- hide or reorder some nav items
- save filters
- save `Today` preferences
- save notification defaults
- save operational views like:
  - “launch-critical businesses”
  - “all approvals needing me”
  - “budget risk only”

Explicit non-goal:

- full custom drag-and-drop dashboard layouts

Deliverables:

- operator preferences model
- saved views model
- light UI customization

Acceptance criteria:

- the app adapts to the operator without fragmenting core IA

### 7. Extension UX Polish

Objective:
Make extensions feel native to the operator experience once the operator model
itself is solid.

Required capabilities:

- clear installed extension identity
- what each extension adds
- where it appears
- compatibility/health
- business applicability
- extension-driven notifications and `Today` items that do not feel bolted on

Deliverables:

- stronger extension center
- extension contribution discoverability
- extension UX consistency across nav, pages, panels, config, and notifications

Acceptance criteria:

- operators can understand installed extensions without reverse engineering

## Dependencies Between Workstreams

- Workstream 1 strengthens Workstreams 2, 5, and 6
- Workstream 2 and 3 should share the same attention-item model
- Workstream 4 depends on stable entity identity and routing surfaces
- Workstream 5 depends on the same attention/provenance/event model used by 2
  and 3
- Workstream 6 should come after 2 through 5 are concrete enough to save stable
  preferences against
- Workstream 7 should come after the base operator model is coherent

## What This Phase Is Not

This phase is not:

- the deeper assistant/operator-console phase
- the research/evals system
- org templates as a product track
- public API/SDK rollout
- marketplace/install lifecycle work

Those are separate planning tracks.
