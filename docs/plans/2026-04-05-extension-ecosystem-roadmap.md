# Extension Ecosystem Roadmap

> Last updated: 2026-04-05

## Goal

Turn ClawForce extensions from a technically possible pattern into a real
product ecosystem with:

- a stable contribution model
- a clear install/enable/disable/update story
- explicit trust and compatibility boundaries
- discoverability in the dashboard
- a documented builder path that does not require forking core

This roadmap assumes the architectural boundary in
`docs/DASHBOARD_EXTENSION_ARCHITECTURE.md` is canonical.

## Core Principle

Do not build a second plugin manager inside ClawForce.

The durable boundary is:

- **OpenClaw:** plugin discovery, loading, lifecycle, install/update, manifests
- **ClawForce:** dashboard contribution semantics, compatibility, audit
  expectations, operator rendering

Short version:

OpenClaw loads extensions.  
ClawForce interprets extensions.

## Definition Of Done

The extension ecosystem should be considered mature when all of these are true:

- a non-core feature can ship as an OpenClaw plugin without patching ClawForce core
- operators can see installed extensions, availability, config surfaces, and
  capability mismatches from the dashboard
- builders have a documented contribution contract for pages, panels, actions,
  workflows, and config sections
- extension compatibility expectations are versioned and explicit
- extension actions have clear auth/audit semantics
- extension install/enable/disable/update behavior is understandable
- at least one real proving extension validates the platform

## Current State

Already real:

- framework-side registry in `src/dashboard/extensions.ts`
- public registration path via `clawforce/dashboard/extensions`
- `GET /clawforce/api/extensions`
- SPA consumption for:
  - extension nav items
  - dynamic extension routes
  - extension registry screen
  - generic extension page host
  - capability-aware filtering
  - extension slots in overview/monitor
  - extension-owned config section discovery

Still immature:

- registry is mostly metadata-driven
- extension action execution semantics are thin
- core slot coverage is incomplete
- there is no published compatibility/version policy
- operator-facing extension management is still closer to “registry inspector”
  than “ecosystem UX”
- there is no proving extension that demonstrates the full intended model end to end

## Workstreams

### 1. Contribution Contract Stabilization

Objective:
Define exactly what an extension can contribute and how ClawForce interprets it.

Remaining work:

- finalize contribution schema for:
  - pages
  - panels/cards
  - actions
  - workflows
  - config sections
- define required vs optional metadata
- define contribution validation rules
- define how routes, nav labels, slots, domain scoping, and capability
  requirements are represented
- decide what belongs in the core contract vs extension-private metadata

Deliverables:

- versioned contribution schema
- validation rules
- compatibility notes for builders

Acceptance criteria:

- extensions do not depend on undocumented registry behavior

### 2. Slot Model Completion

Objective:
Make extension rendering intentional instead of opportunistic.

Remaining work:

- define named extension slots across all intended core surfaces
- audit which surfaces still lack stable insertion points
- expose slots for:
  - businesses / operator home
  - workspace
  - overview
  - ops
  - org
  - tasks
  - approvals
  - comms
  - config
- decide which slots are global vs domain-scoped
- define ordering and collision behavior

Deliverables:

- slot map
- slot rendering rules
- slot inventory in core views

Acceptance criteria:

- builders know where contributions can land without reverse-engineering the SPA

### 3. Extension Action Semantics

Objective:
Make extension actions first-class operator actions instead of decorative metadata.

Remaining work:

- define action types:
  - navigate-only
  - call-core-action
  - call-extension-route
  - invoke workflow
- define domain requirements and capability checks
- define audit expectations for operator-triggered extension actions
- define error/degraded state handling
- define whether extension actions may be async/queued/streaming

Deliverables:

- extension action contract
- audit model
- UI handling rules for action success/failure/degraded states

Acceptance criteria:

- operators can trust extension actions the same way they trust core actions

### 4. Compatibility And Version Policy

Objective:
Prevent extension breakage from becoming implicit or silent.

Remaining work:

- define extension compatibility declaration model
- define what versions/extensions may require:
  - ClawForce version
  - OpenClaw version
  - core endpoints
  - feature flags
- define compatibility checks at registration time vs render time
- define unsupported/outdated messaging in the dashboard
- define deprecation policy for contribution contract changes

Deliverables:

- compatibility schema
- version policy
- dashboard mismatch UX

Acceptance criteria:

- version drift is visible and intentional, not mysterious

### 5. Operator-Facing Extension Management

Objective:
Make extensions visible and manageable to operators.

Remaining work:

- evolve the current `/extensions` surface from registry browser into real
  extension management UX
- show:
  - installed extension identity
  - source/plugin origin
  - version
  - compatibility status
  - domain availability
  - config sections
  - routes/pages
  - permissions/trust notes
- decide whether install/enable/disable lives in OpenClaw UI, ClawForce UI, or both
- if OpenClaw is canonical for lifecycle, make ClawForce explicit about that

Deliverables:

- operator extension center
- lifecycle-boundary UX copy
- status and compatibility badges

Acceptance criteria:

- operators understand what is installed and what each extension is doing

### 6. Builder Experience

Objective:
Make it easy to build a good extension without reading the whole codebase.

Remaining work:

- publish builder guide
- provide extension examples
- define local dev workflow
- define testing strategy for extension contributions
- define how extension config validation should work
- define how builders declare capability requirements

Deliverables:

- builder guide
- example extension
- local development instructions

Acceptance criteria:

- a serious builder can ship a non-core feature without forking core

### 7. Proving Extension

Objective:
Validate the platform with a real non-core extension.

Recommended proving candidates:

- experiments
- another clearly non-core operational surface

Requirements:

- must use OpenClaw loading, not a ClawForce-internal loader
- must register real dashboard pages/panels/actions/config sections
- should exercise capability mismatch and degraded-state UX
- should prove the config story and operator story, not just the route story

Deliverables:

- one production-grade proving extension
- gaps found during implementation folded back into core extension contract

Acceptance criteria:

- the proving extension can ship without bespoke core hacks

## Marketplace And Distribution

This is the next layer after the core extension platform is proven.

Questions to settle:

- is there a ClawForce-branded marketplace, or is OpenClaw’s plugin catalog the
  only install surface?
- how are extension docs/examples discovered?
- how are “recommended” or “verified” extensions designated?
- what trust model is shown to operators before enabling a third-party extension?

Current recommendation:

- keep install/distribution lifecycle in OpenClaw
- keep contribution discovery and operator rendering in ClawForce
- do not build a duplicate package marketplace inside ClawForce unless OpenClaw
  proves insufficient

## Recommended Sequencing

### Phase 1. Stabilize Contribution Contract

- finalize schema
- finalize slot model
- finalize action semantics

### Phase 2. Prove The Platform

- build one proving extension
- add any missing slots/contracts discovered by real use

### Phase 3. Compatibility And Management

- version policy
- compatibility declarations
- operator-facing extension management UX

### Phase 4. Builder Experience

- builder guide
- example repos
- testing/dev workflow

### Phase 5. Marketplace Layer

- distribution/discovery strategy
- trust/review model
- recommended/verified extension policy

## Release Gates

Do not call the extension ecosystem mature until:

- the contribution contract is versioned
- extension slots are intentional across core surfaces
- extension actions have explicit audit semantics
- compatibility mismatches are visible in the dashboard
- one real proving extension is shipping
- OpenClaw ownership boundaries remain intact
- builders have docs good enough to succeed without core patching
