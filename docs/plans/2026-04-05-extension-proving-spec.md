# Extension Proving Spec

> Last updated: 2026-04-05

## Goal

Define exactly what counts as a real proving extension for Pack 8 so the team
does not accidentally declare victory after shipping a decorative demo.

This spec narrows the proving problem to one honest requirement:

Can a clearly non-core feature ship as an OpenClaw plugin, integrate cleanly
with the ClawForce dashboard, and avoid bespoke hacks in core?

## Recommended Proving Extension

Primary choice:

- experiments

Reason:

- experiments are explicitly out of ClawForce core
- an extraction design already exists in
  `docs/superpowers/specs/2026-04-04-extract-experiments-plugin-design.md`
- the feature is meaningful enough to exercise real extension semantics
- it is not just a decorative page

Fallback only if experiments extraction is blocked for unrelated reasons:

- another clearly non-core operational surface with real state and actions

The fallback should be treated as a second choice, not a parallel product
decision.

## Non-Negotiable Boundary

OpenClaw owns:

- plugin discovery
- plugin manifest
- plugin lifecycle
- install/update/uninstall
- embedded host auth

ClawForce owns:

- extension contribution schema
- registry semantics
- dashboard rendering semantics
- capability and degraded-state handling
- audit semantics for extension-triggered operator actions

If the proving extension only works because ClawForce secretly acts like a
plugin manager, it does not count.

## What The Proving Extension Must Exercise

The proving extension should validate more than one metadata shape.

It must exercise:

### 1. Page contribution

The extension must contribute a real route-level page.

Requirements:

- visible in extension registry
- visible in nav when allowed
- domain-aware if the extension is domain-scoped
- reachable through the standard dashboard shell

### 2. Panel contribution

The extension must contribute at least one panel/card onto an existing core
surface.

Recommended surfaces:

- `overview`
- `monitor`
- `ops`

This proves that extensions can augment core workflows rather than only living
on an island page.

### 3. Action contribution

The extension must expose at least one real operator action.

Requirements:

- capability-aware
- error/degraded states are visible
- action is audited
- if async, it uses the core action-status model instead of inventing its own

### 4. Config contribution

The extension must contribute at least one config section or settings surface
visible from the dashboard.

Requirements:

- extension config is discoverable from the Config screen
- invalid config produces explicit feedback
- config ownership is clear to the operator

### 5. Capability mismatch / degraded state

The extension must prove the unhappy path too.

Examples:

- required endpoint missing
- unsupported ClawForce version
- unsupported OpenClaw version
- no active domain when the extension is domain-scoped

If the extension only proves the happy path, it is not enough.

## What The Proving Extension Does Not Need To Solve

This proving path does not need to solve:

- marketplace UX
- install/update UX inside ClawForce
- hot-loaded frontend bundles
- cross-plugin dependency management
- a general extension permission model beyond clear audit/capability behavior

Those are real future platform questions, but they are not required to prove the
current architecture.

## Minimum Technical Shape

The proving extension should:

1. load through OpenClaw plugin lifecycle
2. register its tools/routes through OpenClaw
3. register dashboard contribution metadata through
   `clawforce/dashboard/extensions`
4. expose one or more extension routes reachable through the base dashboard
5. render at least one panel in a core slot
6. expose at least one operator action
7. expose at least one config surface

If any of those are missing, the proof is partial.

## Recommended Experiments Mapping

If the experiments plugin is used, a good proving shape is:

### Page

- `Experiments`

### Core-panel contribution

- experiment summary on `overview`
- or active experiments card on `ops` / `monitor`

### Action contribution

At least one real operator action such as:

- pause experiment
- complete experiment
- kill experiment

### Config contribution

One honest extension-owned config/settings surface, for example:

- default experiment safety/configuration knobs
- canary thresholds
- assignment strategy defaults

The point is not to build a giant experiments UI immediately. The point is to
exercise all major extension contribution types once.

## Compatibility Rules

The proving extension must declare enough metadata that the dashboard can say:

- installed and compatible
- installed but incompatible
- installed but unavailable for this domain/runtime

At minimum, it should be able to express:

- minimum ClawForce version
- minimum OpenClaw version
- required core capabilities/endpoints
- whether the extension is domain-scoped

## Acceptance Criteria

Pack 8 should not be considered done until all of these are true:

- the extension ships outside ClawForce core
- OpenClaw remains the loader/lifecycle owner
- the extension registers with the ClawForce dashboard registry
- the dashboard renders its page
- the dashboard renders its panel on a core surface
- the dashboard exposes at least one real extension action
- the dashboard exposes at least one real extension config surface
- compatibility and degraded-state messaging are visible and truthful
- the extension can be removed without patching core behavior

## Failure Modes That Do Not Count As Success

These should be treated as failed proof, not “good enough for now”:

- the extension only adds a nav link and static page
- the extension requires ClawForce-specific install lifecycle code
- the extension bypasses ClawForce action/audit semantics
- the extension works only on a happy-path demo dataset
- the extension needs bespoke one-off core hacks that are not reusable slots or
  contribution semantics

