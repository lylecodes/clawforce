# Dashboard Shell And IA Spec

> Last updated: 2026-04-05

## Goal

Define one canonical shell and information architecture for the base dashboard
so Pack 4 can finish cleanup without debating page roles or nav order.

## Design Center

The shell is optimized for a solo technical operator running multiple
businesses.

That means the shell must support two distinct modes cleanly:

- global/business-selection mode
- domain-operating mode

The base shell should make it obvious which mode the operator is in.

## Final Shell Decision

Use a hybrid model with explicit roles:

- `Businesses` is the global home
- `Overview` is the domain home
- `Workspace` is the cross-business spatial/operational surface

This is not a generic “everything page.” Each top-level view should have a
clear job.

## Top-Level Nav Model

Recommended top-level order:

1. `Businesses`
2. `Overview`
3. `Tasks`
4. `Approvals`
5. `Ops`
6. `Org`
7. `Workspace`
8. `Comms`
9. `Config`
10. `Extensions`

This order follows the operator’s mental model:

- choose business
- operate
- inspect
- communicate
- configure
- extend

## Page Roles

### Businesses

Route:

- `/`

Role:

- global landing page
- create/select business
- show business-level status and extension/global cards when appropriate

This is the shell’s neutral state when no active business is selected.

### Overview

Route:

- `/overview`

Role:

- default domain home
- the first domain-scoped page an operator should reasonably land on
- summary of the active business

Use for:

- status summary
- pending approvals
- key alerts
- extension summary panels

### Tasks

Route:

- `/tasks`

Role:

- direct work intervention and task-state operation for the active business

### Approvals

Route:

- `/approvals`

Role:

- proposal and approval queue for the active business

### Ops

Route:

- `/ops`

Role:

- operational health and intervention surface
- queue, violations, intervention suggestions, review history, similar

This is not the same thing as `Overview`. `Overview` is business summary.
`Ops` is operational depth.

### Org

Route:

- `/org`

Role:

- org topology, agent roster, and reporting structure for the active business

### Workspace

Route:

- `/workspace`

Role:

- cross-business spatial/activity surface
- visually inspect activity, org state, and drill into entities

This page is allowed to feel different from the rest of the section-first shell
because it serves a different purpose.

It should not become the default home page.

### Comms

Route:

- `/comms`

Role:

- direct human-to-agent and meeting-oriented communication surface

### Config

Route:

- `/config`

Role:

- full configuration and doc/context editing surface for the active business

### Extensions

Route:

- `/extensions`

Role:

- show installed extension contributions, compatibility, availability, and
  operator-facing extension context

## Domain-Scoped vs Global Pages

### Global pages

- `Businesses`
- `Workspace`
- `Extensions`

Notes:

- `Workspace` may still show a business-required state when it needs an active
  selection, but it remains conceptually global/cross-business
- `Extensions` is global, though individual extension pages may be domain-scoped

### Domain-scoped pages

- `Overview`
- `Tasks`
- `Approvals`
- `Ops`
- `Org`
- `Comms`
- `Config`

## Business Selection Rules

### When there is no business

The dashboard should land on `Businesses` and invite create/select behavior.

### When there is exactly one business

The shell may auto-select it for domain-scoped pages.

### When there are multiple businesses and none is active

Domain-scoped pages should render a clear business-required state, not fake
empty content.

### Operator visibility requirement

The shell must always make the active business obvious in the top chrome.

## Navigation Rules

### Core pages first

Core pages should always occupy the primary nav before extension pages.

### Extensions after core

Extension nav items should appear after core nav items and only when their
scoping/capability requirements are satisfied.

### Capability-disabled core surfaces

Keep them visible by default, but mark them honestly as unavailable or `off`.

Do not silently remove core surfaces from the nav just because the current
domain lacks a capability.

## Shell Components

### Layout

Owns:

- top chrome
- shared nav
- route outlet
- global notices/banners

### Domain switcher

Owns:

- active business identity
- searchable switching
- create-business entrypoint nearby

### Domain-required state

Owns:

- honest gating for domain-scoped pages when no active business exists

This should be the standard fallback for domain-scoped views, not custom empty
states scattered everywhere.

## What To Remove Or Neutralize

Pack 4 should remove or neutralize:

- dormant competing shell patterns
- stale references to non-core surfaces like experiments in base shell code
- dead or contradictory layout abstractions that are not part of the final
  shell

If an old shell artifact remains in the repo for historical reasons, it should
be clearly inactive and non-confusing.

## Extension Placement Rules

Extensions may contribute:

- page routes
- panels on core pages
- actions on core pages
- config sections

They should not:

- reorder core navigation
- redefine page roles of core surfaces
- hijack the business-selection model

## Release-Bar Acceptance

Pack 4 should not be considered done until:

- the final nav order is implemented intentionally
- `Businesses` is clearly the global home
- `Overview` is clearly the domain home
- `Workspace` has a clear cross-business role and is not treated as a second
  default home
- domain-scoped pages consistently use business-required states
- dormant shell drift is removed or clearly neutralized

