# OpenClaw Boundary Matrix

> Last updated: 2026-04-05

## Goal

Keep ClawForce from reimplementing platform concerns OpenClaw already owns.

This note is intentionally tactical. It exists to guide ongoing implementation
work, especially in runtime/auth/deployment and extension/platform packs.

## Core Rule

OpenClaw loads and hosts.  
ClawForce interprets and operates.

If a feature is fundamentally about plugin lifecycle or embedded host auth,
OpenClaw should own it.

If a feature is fundamentally about ClawForce runtime semantics, dashboard
contract behavior, or operator workflows, ClawForce should own it.

## Ownership By Surface

### Plugin discovery, manifests, and lifecycle

OpenClaw owns:

- plugin manifests
- discovery
- load order
- enable/disable at plugin runtime level
- install/update/uninstall
- lifecycle hooks

ClawForce owns:

- nothing beyond consuming the result of loaded plugins

Do not build:

- a second plugin manager in ClawForce
- ClawForce-native install/update state for OpenClaw plugins

### Embedded human auth and session ownership

OpenClaw owns:

- user session/authentication when ClawForce is mounted inside OpenClaw
- any embedded gateway/session identity

ClawForce owns:

- reporting runtime metadata that the dashboard is embedded
- adapting UI behavior to embedded auth truth

Do not build:

- a second login screen for embedded mode
- duplicate bearer/session checks inside embedded requests

### Standalone dashboard auth and server behavior

OpenClaw owns:

- nothing, unless it is the host

ClawForce owns:

- standalone HTTP server
- standalone auth behavior
- standalone security headers and localhost/bearer-token policy
- standalone static asset serving
- standalone runtime metadata

Do not build:

- OpenClaw-style embedded session logic into standalone mode

### Dashboard extension semantics

OpenClaw owns:

- loading the plugin that contributes extension metadata

ClawForce owns:

- extension contribution schema
- registry semantics
- extension discovery endpoint for the dashboard
- page/panel/action/config contribution meaning
- capability requirements
- audit expectations for extension actions

Do not build:

- a raw “plugin manifest == dashboard page” assumption

### Extension install / update UX

OpenClaw owns:

- install/update/uninstall mechanics
- package/distribution lifecycle

ClawForce owns:

- visibility into installed/registered dashboard extensions
- operator-facing explanation of what an installed extension contributes

Do not build:

- a separate ClawForce marketplace installer if OpenClaw already owns install

### Public machine auth

OpenClaw owns:

- nothing by default for standalone/public ClawForce API use

ClawForce owns:

- explicit service-token or API-key model for future public APIs

Do not build:

- public machine auth by reusing embedded OpenClaw user sessions

### Streams, events, and webhooks

OpenClaw owns:

- none of the ClawForce semantic model by default

ClawForce owns:

- event vocabulary
- stream discovery and execution semantics
- any public webhook or stream endpoint contract

Do not build:

- a fake universal “everything is an OpenClaw stream” model

### Agent session message injection

OpenClaw owns:

- host/runtime facilities when it provides them

ClawForce owns:

- deciding when the dashboard should inject or persist a message
- fallback semantics when live delivery is unavailable

Acceptable bridge:

- adapter-specific helpers such as CLI/session injection bridges in embedded
  mode

Do not build:

- a second session runtime inside ClawForce just to avoid using the host bridge

### Capability and runtime metadata

OpenClaw owns:

- whether ClawForce is embedded and what host context exists

ClawForce owns:

- exposing runtime mode and capability metadata to the dashboard
- telling the UI whether auth is OpenClaw-owned or standalone

Do not build:

- UI guesswork about runtime ownership

## Decision Rules For In-Flight Work

When a worker is unsure who should own something, apply these checks:

### 1. Is this about plugin/package lifecycle?

If yes, default to OpenClaw.

### 2. Is this about ClawForce operator semantics?

If yes, default to ClawForce.

### 3. Is this about embedded human auth?

If yes, default to OpenClaw.

### 4. Is this about standalone server behavior?

If yes, default to ClawForce.

### 5. Is this about how a dashboard surface should render or behave?

If yes, default to ClawForce.

## Practical Implications For Current Packs

### Pack 3: Runtime / Auth / Deployment

Allowed:

- improve standalone auth
- improve runtime metadata
- improve embedded-vs-standalone docs/tests

Not allowed:

- recreate OpenClaw embedded auth/session management

### Pack 7: Action Status And Recovery

Allowed:

- add ClawForce action records
- add action SSE/query semantics

Not allowed:

- couple action status to OpenClaw-specific plugin lifecycle assumptions

### Pack 8: Extension Proving Path

Allowed:

- add ClawForce extension slots and contribution metadata
- prove one real extension path

Not allowed:

- build install/update/marketplace logic that OpenClaw should own

## Short Version

Use OpenClaw for:

- loading
- lifecycle
- embedded auth
- install/update

Use ClawForce for:

- dashboard meaning
- runtime semantics
- standalone behavior
- operator workflows
- extension contribution interpretation

