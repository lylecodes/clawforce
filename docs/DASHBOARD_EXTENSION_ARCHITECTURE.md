# Dashboard Extension Architecture

> Last updated: 2026-04-05

## Principle

Do not build a second plugin manager in ClawForce if OpenClaw already provides
plugin discovery, loading, lifecycle hooks, and route/tool registration.

The boundary should be:

- **OpenClaw:** loads plugins, manages lifecycle, owns plugin manifests
- **ClawForce:** defines what a dashboard contribution means
- **Dashboard SPA:** renders extension metadata exposed by ClawForce

Short version:

OpenClaw loads extensions.  
ClawForce interprets extensions.

## Why

This avoids duplicated infrastructure while keeping the dashboard coherent.

If ClawForce tried to manage plugin installation and lifecycle itself, it would
re-implement a weaker version of something OpenClaw already has.

If ClawForce relied only on raw OpenClaw plugin primitives, the dashboard would
have no stable notion of:

- nav pages
- screen panels
- operator actions
- config editor contributions
- capability expectations
- audit semantics

ClawForce still needs a thin extension contract because OpenClaw does not know
what a ClawForce dashboard page or config section is.

## Implemented First Slice

ClawForce now exposes a minimal registry for dashboard contributions:

- public import path: `clawforce/dashboard/extensions`
- framework registry module: `src/dashboard/extensions.ts`
- gateway registry route: `GET /clawforce/api/extensions`
- SPA client contract: `clawforce-dashboard/src/api/client.ts`

This is intentionally metadata-only.

ClawForce does **not** load extension code itself. The plugin is still loaded by
OpenClaw. The extension simply registers dashboard contribution metadata with
ClawForce at runtime.

## First Proven Extension — experiments plugin

The experiments plugin at `openclaw-plugins/clawforce-experiments/` is the first
real extension to prove the platform end-to-end. It registers during `plugin.register()`:

```ts
import { registerDashboardExtension } from "clawforce/internal";

registerDashboardExtension({
  id: "clawforce-experiments",
  title: "Experiments",
  description: "A/B experiment framework for ClawForce agent teams",
  version: "0.1.0",
  source: { kind: "openclaw-plugin", pluginId: "@clawforce/openclaw-plugin-experiments" },
  pages: [
    { id: "experiments", title: "Experiments", route: "/experiments",
      navLabel: "Experiments", surface: "nav", domainScoped: true },
  ],
  panels: [
    { id: "experiment-summary", title: "Experiment Summary",
      surface: "overview", slot: "sidebar", route: "/experiments", domainScoped: true },
  ],
  configSections: [
    { id: "experiments", title: "Experiments", editor: "structured",
      description: "A/B experiment configuration" },
  ],
});
```

The `GET /clawforce/api/extensions` endpoint returns this contribution at runtime.
The `GET /clawforce/api/:domain/capabilities` endpoint includes an `extensions`
field that lists loaded extension IDs and count, so the SPA can adapt its UI
based on which extensions are present.

Tests: `test/dashboard/extension-proving.test.ts` (clawforce) and
`test/extension.test.ts` (experiments plugin).

## Extension Registration Flow

### 1. OpenClaw loads a plugin

The plugin is discovered and initialized through the normal OpenClaw plugin
system.

### 2. The plugin registers its own runtime surfaces

The plugin uses OpenClaw APIs for:

- `registerTool()`
- `registerHttpRoute()`
- lifecycle hooks
- plugin-specific state/bootstrap

### 3. The plugin registers dashboard metadata with ClawForce

The plugin imports the ClawForce registry bridge and registers a contribution:

```ts
import { registerDashboardExtension } from "clawforce/dashboard/extensions";

const unregister = registerDashboardExtension({
  id: "clawforce-experiments",
  title: "Experiments",
  source: {
    kind: "openclaw-plugin",
    pluginId: "@clawforce/plugin-experiments",
  },
  pages: [
    {
      id: "experiments",
      title: "Experiments",
      route: "/experiments",
      navLabel: "Experiments",
      surface: "nav",
      domainScoped: true,
    },
  ],
  panels: [
    {
      id: "experiment-summary",
      title: "Experiment Summary",
      surface: "overview",
      slot: "sidebar",
      route: "/experiments",
      domainScoped: true,
    },
  ],
});
```

If the plugin unloads, it can call the returned unregister function.

## Contribution Model

Current contribution types:

- **pages**: route-level dashboard pages, optionally nav-mounted
- **panels**: cards/panels for existing core surfaces
- **actions**: operator actions that can attach to a surface
- **configSections**: extra config-editor sections

Current registry type lives in:

- `src/dashboard/extensions.ts`

The contract is intentionally small right now. It is enough to establish the
boundary without prematurely hard-coding the full rendering system.

## What ClawForce Should Own

ClawForce should own:

- contribution schema and validation
- registry semantics
- gateway endpoint exposing loaded contributions
- capability requirements for extension surfaces
- dashboard-side rendering rules
- audit expectations for operator-triggered extension actions

ClawForce should **not** own:

- plugin discovery
- plugin installation
- plugin manifest format
- plugin lifecycle orchestration
- tool/route loading infrastructure already handled by OpenClaw

## What OpenClaw Should Own

OpenClaw should continue to own:

- plugin manifests
- plugin loading order
- plugin enable/disable state
- plugin lifecycle hooks
- tool and route registration
- distribution/install/update story

## Recommended Path For The Experiments Plugin

The experiments extraction already points the right direction:

- plugin package remains an OpenClaw plugin
- plugin registers its own tools and routes through OpenClaw
- plugin registers dashboard metadata through ClawForce

That makes experiments the proving ground for the extension architecture
without reintroducing experiment code into ClawForce core.

## Next Slices

### 1. Render registry-driven pages and nav contributions in the SPA

The SPA should consume `GET /clawforce/api/extensions` and begin rendering:

- extra nav items
- extra page routes
- extension-driven config tabs

### 2. Add capability-aware filtering

Extensions should be hideable based on:

- required core endpoints
- required feature flags
- domain-scoped vs global-scoped behavior

### 3. Define action execution semantics

Operator actions need a clearer contract:

- route-only actions
- API-backed actions
- audit requirements
- domain requirements

### 4. Add explicit extension slots in core surfaces

Core views should expose named slots instead of ad hoc insertion:

- `overview.sidebar`
- `overview.main`
- `config.sections`
- `monitor.cards`
- `workspace.sidebar`

## Non-Goals

This architecture does **not** yet solve:

- extension code bundling into the SPA
- hot-loaded React modules from plugins
- plugin marketplace UX
- cross-plugin dependency management
- full permission model for extension actions

Those can come later. The immediate goal is to establish the correct ownership
boundary and a real metadata contract.
