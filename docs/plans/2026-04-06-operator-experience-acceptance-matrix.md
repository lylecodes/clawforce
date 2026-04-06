# Operator Experience Acceptance Matrix

Use this as the finish-line checklist for the next app-layer phase after
dashboard maturity.

## Wave 1 / Track A: Framework Change History And Revert Contract

Done when:

- change records have stable shape
- provenance is explicit
- structural history reads exist
- structural revert actions exist where safe
- unsafe revert attempts fail explicitly

Required verification:

- focused framework tests for history and revert
- framework build

Avoid touching:

- broad SPA shell files unless a contract change requires a minimal follow-up

## Wave 1 / Track B: SPA History, Diff, And Revert UX

Done when:

- operators can inspect before/after diffs
- provenance is visible in UI
- reversible changes expose safe revert affordances
- irreversible changes are shown honestly

Required verification:

- SPA component/integration tests
- `npm test`
- `npm run build`

Avoid touching:

- framework history logic except for true blockers

## Wave 1 / Track C: History Verification

Done when:

- operator confidence flows are covered automatically
- route-level tests prove history and revert behavior across major structural
  surfaces

Required verification:

- the new route/integration tests themselves
- `npm test`
- `npm run build`

## Wave 2 / Track D: Attention Item Model

Done when:

- one shared attention-item model exists
- actionability is explicit
- business grouping is supported
- items carry deep-link/focus metadata

Required verification:

- framework query tests if contract changes
- SPA tests for shared model behavior

## Wave 2 / Track E: `Today` In `Overview`

Done when:

- `Overview` contains the primary `Today` widget
- filters exist
- clicked items land the user in the right surface with context already loaded

Required verification:

- `Overview` tests
- route/integration tests for deep-link behavior
- `npm test`
- `npm run build`

## Wave 2 / Track F: Business Rollup Surfaces

Done when:

- grouped-by-business rollups are visible
- operators can drill into the right business cleanly
- the product does not collapse into one noisy merged queue by default

Required verification:

- businesses/monitor tests
- `npm test`
- `npm run build`

## Wave 3 / Track G: Find-And-Jump Search

Done when:

- operators can search and jump to major entities quickly
- command/search surface is useful before deep full-text exists

Required verification:

- command/search tests
- `npm test`
- `npm run build`

Avoid touching:

- deep doc/history indexing work unless explicitly in scope

## Wave 3 / Track H: Notification Model And Routing

Done when:

- canonical in-app notification records exist
- category/severity/actionability/delivery status are explicit
- global defaults plus business overrides exist
- dashboard inbox is source of truth

Required verification:

- framework notification tests
- SPA inbox/settings tests
- builds for touched repos

## Wave 3 / Track I: Notification Delivery Adapters

Done when:

- delivery uses host-backed transports where available
- delivery failures do not erase in-app notification truth
- transport logic does not duplicate OpenClaw ownership

Required verification:

- adapter/delivery tests
- framework build

Avoid touching:

- notification semantics that belong to Track H

## Wave 4 / Track J: Operator Preferences And Saved Views

Done when:

- light personalization exists
- saved views are real
- the app remains opinionated and coherent
- arbitrary custom layout building has not snuck in

Required verification:

- SPA tests for preferences and saved views
- `npm test`
- `npm run build`

## Wave 4 / Track K: Extension UX Polish

Done when:

- operators can tell what extensions add
- operators can tell where extensions appear
- compatibility/health/business applicability are visible

Required verification:

- extension UX tests
- `npm test`
- `npm run build`

## Phase-Level Success

Do not call this next app layer successful until:

- change truth and safe structural revert are real
- `Today` makes `Overview` the obvious domain operating home
- multi-business UX is grouped by business first
- search is useful as find-and-jump
- notifications behave like a real routed system
- personalization improves operations without fragmenting IA
- extension UX feels integrated instead of bolted on

