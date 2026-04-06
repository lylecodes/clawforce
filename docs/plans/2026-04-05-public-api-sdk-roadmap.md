# Public API And SDK Roadmap

> Last updated: 2026-04-05

## Goal

Define the external builder surface for ClawForce so it can be integrated,
automated, and extended intentionally rather than by reaching into internal
implementation details.

This roadmap covers:

- public API boundaries
- SDK shape and guarantees
- event/webhook/streaming semantics
- auth/versioning/deprecation policy
- examples and builder documentation

## Important Current Reality

ClawForce does **not** currently expose “everything” through a single universal
data-stream model.

There are three different things today:

- **Data streams**: context-source/catalog surfaces for briefing and routed
  outputs via `src/streams/`
- **Events**: persisted domain events plus in-process `cf.events.on()` via
  `src/sdk/events.ts`
- **Dashboard SSE**: a narrow live-update channel for UI state via
  `src/dashboard/sse.ts`

Those are related, but they are not one unified external streaming contract.

Also important:

- the stream catalog in `src/streams/builtin-manifest.ts` is discoverability
  metadata over existing context sources, not a universal external API surface
- many core capabilities are still exposed through namespaces and direct
  function exports, not data streams

So the public API plan should not assume “everything is already streamable.”
That would be false.

## Stream Principle

Streams should be **queryable first, live second**.

Recommended model:

- **Streams** are named data products or computed views that can be discovered
  and executed on demand
- **Events** are the primary live/reactive primitive
- **Live streams** are an optional later capability for the small subset of
  streams where subscription semantics are worth the complexity

Short version:

- not all streams should be live
- all live streams should still be modeled as streams

This keeps the public platform aligned with what ClawForce actually has today
instead of forcing every stream-shaped thing into a realtime subscription model.

## Definition Of Done

The public API / SDK should be considered mature when:

- the supported public surface is explicitly defined
- builders know what is stable vs internal
- API versioning and deprecation policy are documented
- auth and rate-limit semantics are explicit
- async action semantics are explicit
- event/webhook/streaming surfaces are deliberate, not accidental
- there is a documented builder path for the common integration cases
- examples exist for both direct SDK use and external automation

## Current State

Already real:

- high-level SDK entry via `Clawforce` in `src/sdk/index.ts`
- 17 lazy-loaded namespaces documented in `docs/INTEGRATION.md`
- broad low-level export surface from `src/index.ts`
- dashboard HTTP contract in `src/api/contract.ts`
- event namespace, telemetry namespace, triggers, messages, goals, config, etc

Still immature as a public platform:

- the public surface is too broad and not clearly tiered
- there is no strong policy for stable vs internal APIs
- the dashboard contract is not yet clearly positioned as internal-only or
  public-supported
- auth/versioning/idempotency/deprecation policy is not formalized
- streaming/event/webhook semantics are fragmented
- the builder story is more “read the code/export surface” than “use the platform intentionally”

## Public Surface Tiers

This needs to be formalized before the API is considered stable.

### Tier 1. Stable Public Surface

Intended long-lived builder-facing contracts:

- `Clawforce` SDK namespaces
- selected HTTP/control API surfaces
- extension registration contract
- event subscription/query semantics where explicitly documented

### Tier 2. Advanced Public Surface

Supported, but more specialized:

- lower-level exports from `src/index.ts`
- stream catalog and custom stream registration
- raw monitoring/telemetry access

### Tier 3. Internal / No Stability Guarantee

Should not be treated as public contract:

- dashboard-only implementation helpers
- adapter internals
- implicit file formats not declared as public
- undocumented internal route behavior

## Workstreams

### 1. Public Contract Definition

Objective:
Decide exactly what ClawForce supports externally.

Remaining work:

- inventory the current export surface
- classify APIs into stable / advanced / internal
- decide whether the dashboard HTTP contract is:
  - internal-only
  - semi-public
  - fully public
- define what builders should import from:
  - `clawforce`
  - `clawforce/dashboard/extensions`
  - future API client packages

Deliverables:

- public surface inventory
- tiered support policy
- builder-facing contract map

Acceptance criteria:

- builders do not need to guess which surface is safe to build on

### 2. HTTP API Strategy

Objective:
Define the external HTTP story instead of letting the dashboard API become the
default by accident.

Remaining work:

- decide whether to publish a formal external HTTP API distinct from dashboard
  internals
- define resource model
- define read vs mutate surface
- define sync vs accepted/async vs streaming responses
- define idempotency expectations
- define auth model
- define rate limits

Deliverables:

- HTTP API strategy doc
- versioning plan
- auth/idempotency model

Acceptance criteria:

- the HTTP story is deliberate, not “whatever the dashboard happens to call”

### 3. Event, Webhook, And Streaming Model

Objective:
Make ClawForce’s external real-time/data-delivery story coherent.

Remaining work:

- define how events, webhooks, dashboard SSE, and stream catalog relate
- decide what external subscribers can rely on
- decide whether a public streaming API exists
- decide whether webhook delivery is first-class
- define event schema/versioning policy
- define how custom streams fit into public integration stories

Current recommendation:

- do **not** pretend the current stream catalog is a universal public stream API
- treat streams as queryable context/routing primitives first
- treat events as the main reactive integration primitive unless/until a
  deliberate public streaming contract is designed
- add stream discovery and execution endpoints before adding stream
  subscriptions

Deliverables:

- unified event/webhook/streaming model
- event schema policy
- stream discovery/execution policy
- guidance for when to use:
  - streams
  - events
  - webhooks
  - HTTP polling

Acceptance criteria:

- builders understand how to react to ClawForce state changes without reverse engineering

Recommended endpoint evolution:

1. `GET /streams`
2. `GET /streams/:name`
3. `POST /streams/:name/execute`
4. optional later: selective subscription or webhook delivery for eligible streams

### 4. SDK Maturity

Objective:
Make the SDK the best path for serious programmatic use.

Remaining work:

- audit namespace completeness and consistency
- normalize naming and vocabulary where still inconsistent
- define sync/async expectations clearly
- define error shapes and retry guidance
- reduce pressure to use low-level raw exports when the SDK should suffice
- publish better namespace-by-namespace examples

Deliverables:

- SDK maturity audit
- namespace consistency pass
- example-driven SDK docs

Acceptance criteria:

- most serious builder use cases can stay in the high-level SDK

### 5. Builder Auth And Deployment Model

Objective:
Define how external systems authenticate and integrate.

Remaining work:

- document embedded vs standalone auth implications
- define external auth for any public HTTP surface
- decide how tokens/credentials are issued and rotated
- define local development vs hosted deployment auth stories

Recommended auth boundary:

- **Embedded in OpenClaw**
  - OpenClaw owns human auth/session
  - ClawForce should trust the host context and avoid double-auth
  - ClawForce may expose runtime metadata indicating that auth is OpenClaw-owned

- **Standalone ClawForce dashboard**
  - ClawForce owns auth directly
  - current practical baseline is bearer-token or localhost-only access
  - future session UX can improve, but ownership remains ClawForce-side

- **Public API / machine access**
  - should use explicit machine-auth, not UI session auth
  - recommended direction is API keys or service tokens with scopes
  - should not depend on OpenClaw’s embedded human session model

Recommended token classes:

- **Operator session**
  - human-authenticated dashboard access
  - embedded: OpenClaw-owned
  - standalone: ClawForce-owned

- **Service token**
  - machine-to-machine automation
  - scoped to explicit capabilities/domains
  - revocable and rotatable

- **Extension/runtime token**
  - if needed later for trusted internal service-to-service calls
  - not necessarily exposed to third-party builders

Recommended scope model:

- domain scope
- read vs write scope
- optional capability scopes such as:
  - config
  - tasks
  - approvals
  - comms
  - budget
  - monitoring
  - extensions

Non-goal:

- do not recreate OpenClaw’s embedded auth/session logic inside ClawForce
- do not use dashboard-human session auth as the machine-auth model for the public API

Deliverables:

- auth guide
- local dev guide
- deployment integration guide

Acceptance criteria:

- builders know how to authenticate without reading adapter internals

### 6. Versioning And Deprecation

Objective:
Prevent external breakage from becoming accidental.

Remaining work:

- define semver expectations for public API changes
- define dashboard-contract change policy if any part becomes public
- define deprecation windows and notices
- define compatibility notes between:
  - ClawForce version
  - OpenClaw version
  - extension contract version

Deliverables:

- versioning policy
- deprecation policy
- compatibility matrix

Acceptance criteria:

- builders can upgrade intentionally

### 7. Examples, SDK Client, And Tooling

Objective:
Make the public platform easy to adopt.

Remaining work:

- provide minimal integration examples
- provide example apps/scripts for:
  - SDK-only usage
  - event-driven integration
  - webhook consumer
  - extension registration
- decide whether to ship a dedicated API client package
- decide whether CLI should consume the same public HTTP/API contracts

Deliverables:

- examples folder or docs examples
- sample integration recipes
- decision on dedicated client package

Acceptance criteria:

- a builder can integrate ClawForce without reading internals first

## Recommended Sequencing

### Phase 1. Public Surface Inventory

- classify exports
- define stable vs internal
- decide dashboard API posture

### Phase 2. Event And HTTP Strategy

- define external HTTP position
- define event/webhook/streaming model
- define auth/idempotency/versioning rules

### Phase 3. SDK Maturity

- namespace audit
- naming consistency
- examples

### Phase 4. Tooling And Client Layer

- example clients
- optional dedicated API client
- CLI/API alignment

### Phase 5. Compatibility And Release Policy

- versioning matrix
- deprecation process
- upgrade notes

## Open Questions

These should be answered explicitly:

- Is the dashboard control API intended to become public, or should there be a
  separate public API?
- Should events be the primary external reactive primitive, or should ClawForce
  eventually expose a dedicated public stream/subscription API?
- Is webhook delivery core, or extension territory?
- How much of the 200+ export surface should remain public long-term?

## Release Gates

Do not call the public API / SDK mature until:

- the supported public surface is explicitly tiered
- external builders have a documented auth story
- the event/webhook/streaming model is coherent
- versioning/deprecation policy is published
- the SDK has examples good enough for real use
- builders do not need to depend on undocumented dashboard or adapter internals
