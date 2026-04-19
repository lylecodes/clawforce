# Dashboard V2 Implementation Brief

> Last updated: 2026-04-19
> Purpose: turn the locked `docs/mockups/dashboard-v2.html` workspace into a build-facing implementation brief without reopening shell design.

## Status

The mockup set under `docs/mockups/` is now the visual north star:

- `dashboard-v2.html`
- `preview-project.png`
- `preview-focus.png`
- `preview-inspector.png`
- `preview-review.png`
- `preview-setup.png`

This brief does **not** redesign that shell.
It translates the chosen direction into:

- framework contracts
- dashboard primitives
- scope/state behavior
- phased implementation order
- acceptance criteria

## Hard Lock

These decisions are closed unless implementation proves a real product flaw:

- one workspace shell, not a tabbed admin dashboard
- minimal top bar
- left scope rail
- center canvas as the primary product surface
- right context rail as one adaptive surface
- project overview as a grid of mini workflow previews
- workflow focus as one left-to-right workflow
- workflow stages as the primary boxes
- drafts owned structurally by the left rail
- feed, inspector, helper, and review all expressed through the right rail
- grouped draft sessions and feed-driven review instead of casual live mutation

Do not reopen shell layout or top-level IA during implementation.

## Product Goal

The mature dashboard should let an operator do all normal ClawForce work from
one coherent workspace:

- understand what workflows exist
- focus one workflow
- inspect stages and state
- read scoped operator events
- create and adapt workflows through the helper
- manage draft sessions
- review and approve governed workflow mutations

The dashboard remains a UI over framework-owned truth.
It must not become a parallel state system.

## Cross-Repo Boundary

This implementation spans both repos:

- `clawforce`
- sibling `clawforce-dashboard`

Use this split:

### `clawforce` owns

- canonical workflow/workspace entities and contracts
- draft session semantics
- review / approval semantics for workflow mutations
- helper-backed workflow creation and mutation contracts
- scoped feed data
- truthful runtime, setup, review, and workflow state

### `clawforce-dashboard` owns

- shell layout and visual system
- canvas rendering
- scope rail and context rail behavior
- client-side view state
- interaction flows over framework-backed contracts

## Workspace Model

The workspace is scope-aware.
The entire shell changes meaning based on current scope.

### Scope levels

1. `project`
2. `workflow`
3. `stage`
4. `draft-session`
5. `setup-helper`

### Scope rules

- project view: project-scoped left rail, project canvas, project-scoped feed
- workflow focus: workflow-scoped left rail, focused workflow canvas,
  workflow-scoped feed
- stage selected: canvas stays focused, right rail becomes stage inspector
- draft session selected: left rail marks the draft, canvas shows draft
  overlays, right rail becomes review context
- setup active: left rail shows new-workflow/setup context, canvas shows
  proposed workflow draft, right rail becomes helper conversation

The shell must never leave the user guessing about current scope.

## Visual Shell To Build

### Top bar

Keep it minimal.

Owns:

- project switcher
- global search / jump affordance
- very light global runtime identity

Does **not** own:

- dense metrics
- dashboards of cards
- draft management
- feed controls

### Left scope rail

Changes by scope.

#### In project scope

Owns:

- lightweight operator summary
- workflow list/tree
- project-only search/filter
- create workflow entrypoint
- draft sessions list

#### In workflow scope

Owns:

- selected workflow summary
- stage list / stage jump
- workflow-level context
- draft sessions affecting that workflow

The left rail is the structural inventory rail.
It is not a second feed.

### Center canvas

This is the main product surface.

#### In project scope

- grid of workflow previews
- each preview is a mini left-to-right topology
- explicit `Start` and `End`
- very light live-state hints only

#### In workflow scope

- one left-to-right workflow
- explicit branching when real
- no nested subflows in v1
- automatic layout
- pan / zoom / fit / recenter

#### Stage box baseline

- stage name
- small state badge
- subdued agent label
- small always-visible type tags

No inline action clutter.
Primary actions happen through the context rail.

### Right context rail

One adaptive rail.
Do not model this as several mini-products.

Modes are contextual, not separate shell products:

- scoped feed
- stage inspector
- helper conversation
- review / approval context

The right rail is where the user reads, understands, confirms, and edits.

## Canonical Core Objects

Do not implement the workspace as ad hoc dashboard-only view models.
These framework objects need to exist cleanly.

### `ProjectWorkspace`

Represents:

- project identity
- workflow inventory
- lightweight project-level operator summary
- draft session inventory

### `WorkflowTopology`

Represents:

- workflow identity
- stages
- edges
- branch labels where needed
- live status
- draft overlays

### `WorkflowStage`

Represents:

- stage identity
- display label
- stage type tags
- agent assignment
- state badge
- optional metadata for inspector display

### `WorkflowDraftSession`

Represents:

- draft session identity
- scope
- owner / proposer
- affected workflow
- grouped changes
- visible overlay state
- review status

### `WorkflowReview`

Represents:

- reviewable grouped mutation
- linked draft session
- change summary
- approval state
- notes / rationale

### `WorkspaceFeedItem`

Represents:

- scoped operator event
- category
- target entity
- why it exists
- what action is available

This must stay aligned with the canonical attention/feed model already being
built.

### `HelperSession`

Represents:

- current setup / workflow-authoring conversation
- gathered answers
- proposed draft topology
- whether the helper is asking, proposing, or waiting

## Required Framework Contracts

The dashboard cannot ship this shell truthfully without explicit framework
contracts.

### Read contracts

Add or formalize queries for:

- project workspace summary
- project workflow grid data
- workflow topology detail
- stage inspector detail
- scoped workspace feed
- draft session inventory
- draft session detail
- review detail
- helper session detail

Minimum shape requirements:

- stable ids for project, workflow, stage, draft session, review item
- explicit scope in every response
- explicit `live` vs `draft` vs `review` state
- enough metadata to explain why a thing exists

### Write contracts

Add or formalize actions for:

- create workflow session
- send helper message
- accept helper-proposed workflow draft
- edit workflow structure through draft mutations
- toggle draft session visibility
- confirm grouped draft session
- approve / reject workflow review
- discard draft session

These must be audited, framework-backed mutations.
No UI-only local truth.

### Feed contracts

The feed must already support canonical operator semantics.
Extend it so workflow and draft/review items flow through the same operator
universe instead of spawning a second event system.

Feed item categories needed for this shell:

- workflow event
- stage event
- draft review event
- approval / decision event
- alert / issue
- helper / setup milestone when relevant

Do not add feed kinds just for visual decoration.

## Setup Helper Model

The helper is a first-class workflow-authoring behavior, but it is still a UI
over framework truth.

### Desired flow

1. User chooses `new workflow` from the left rail.
2. Workspace enters setup scope.
3. Right rail opens helper conversation.
4. Helper asks one question at a time, starting with the workflow goal.
5. Helper gathers context and proposes workflow stages directly onto the canvas.
6. Proposed stages appear as draft state in the real layout.
7. User reviews and adapts.
8. Draft becomes a governed draft session and later enters review.

### Constraints

- helper is not a hidden config system
- helper proposals must materialize on the canvas
- helper does not bypass draft / review semantics
- helper may delegate internally, but that is not a required product surface

## Draft And Review Model

This is the most important new behavioral loop in the workspace.

### Draft rules

- structural edits do not become live immediately
- edits accumulate into grouped draft sessions
- draft sessions are visible in the left rail
- toggling a draft session changes what appears on the canvas
- draft overlays are visually distinct from live workflow elements

### Review rules

- confirming a draft session moves it into review
- review is primarily surfaced through the feed and the right rail
- grouped changes stay grouped
- approval is explicit
- rejection is explicit

### Non-goals

- no hidden private scratchpads
- no direct live mutation without governance
- no silent auto-mutation of workflows

## Implementation Order

Build this in phases.
Do not attempt the whole shell in one jump.

### Phase A: Shell primitives and read-only workspace

Objective:
Get the shell and scope model real with framework-backed read paths.

Build:

- minimal top bar
- left scope rail
- center canvas
- right context rail
- project workspace query
- workflow topology query
- stage inspector query
- scoped feed query

Exit criteria:

- project view works with real data
- workflow focus works with real data
- stage selection updates the context rail
- feed scope changes truthfully with current workspace scope

### Phase B: Draft session model and workflow overlays

Objective:
Make workflow mutation legible before helper-driven authoring lands.

Build:

- framework draft session entity
- draft session inventory query
- toggle draft visibility
- draft overlay rendering on canvas
- draft-aware workflow focus state

Exit criteria:

- draft sessions exist as real framework objects
- left rail can list and toggle them
- canvas can render live plus draft overlays truthfully

### Phase C: Review loop

Objective:
Finish governed workflow mutation instead of stopping at draft visualization.

Build:

- grouped draft confirmation
- review object
- review detail query
- approve / reject actions
- feed items for workflow review

Exit criteria:

- a grouped draft can move into review
- review appears in the feed
- right rail can drive approval/rejection
- review state is reflected on the canvas honestly

### Phase D: Helper-led workflow creation

Objective:
Make the setup/helper state real.

Build:

- helper session object
- helper conversation contract
- helper draft proposal mutation
- new workflow flow from left rail into helper scope
- helper-authored stages materialized on the canvas

Exit criteria:

- operator can start a new workflow from the workspace
- helper can ask one-at-a-time intake questions
- helper can propose a starter workflow onto the canvas
- proposed result becomes a real draft session, not decorative chat

### Phase E: Make the workspace the primary dashboard home

Objective:
Promote the new shell without forcing dangerous cutovers.

Build:

- route/default-home decision
- migration of old dashboard entrypoints into the workspace or legacy surfaces
- compatibility path for still-needed old screens while the new workspace wins

Exit criteria:

- there is one obvious dashboard home
- the old tab/page sprawl is no longer the default operator path
- remaining old pages are explicitly legacy or secondary

## What Not To Build Yet

Do not widen scope during this implementation.

### Explicitly defer

- nested subflows
- freeform manual stage layout
- general node-editor behavior
- massive project analytics panels
- dashboard-only workflow builder schemas
- extension-driven shell changes
- cross-project global search beyond simple shell jump/search
- speculative auto-wiring of arbitrary stage integrations

## Acceptance Criteria

Treat the workspace as ready when all of these are true:

1. An operator can enter one project workspace and understand what workflows
   exist without opening multiple pages.
2. Focusing a workflow, selecting a stage, opening a draft session, and opening
   a review item all preserve one coherent shell.
3. The right rail reads as one adaptive context surface, not several mini-apps.
4. Drafts, feed, and review do not duplicate ownership.
5. Every meaningful action in the workspace maps to a real framework contract.
6. The helper can create a real proposed workflow draft, not just chat about
   one.
7. No part of the workspace depends on fake runtime or dashboard-only state.

## Verification Plan

Use this brief to verify implementation honestly.

### Framework verification

- query tests for workspace, workflow, stage, draft, review, and helper shapes
- mutation tests for draft creation, toggle, confirm, review approve/reject,
  and helper proposal flows
- feed contract tests for draft/review/operator event coverage

### Dashboard verification

- UI tests for scope transitions:
  - project -> workflow
  - workflow -> stage inspector
  - workflow -> draft
  - draft -> review
  - project/workflow -> helper
- canvas rendering tests for live vs draft overlays
- smoke tests for rail collapse and scoped feed behavior

### Dogfood verification

Run the same operator-led UI dogfood stance already locked in the execution
board:

- create a workflow from the workspace
- inspect an existing workflow
- toggle a draft
- send a grouped draft to review
- approve or reject it
- verify that no DB peeking is required to understand what the UI is doing

## Final Rule

If implementation pressure tries to split truth between:

- left rail vs right rail
- canvas vs feed
- dashboard vs framework
- helper chat vs draft session

the framework-owned object wins, and the UI must collapse back onto that truth.
