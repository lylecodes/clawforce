# ClawForce Extension Guide

A guide for developers building extensions on top of ClawForce.

---

## Extension Model

ClawForce extensions contribute dashboard metadata: navigation pages, surface panels, operator actions, and config editor sections. Extensions do not inject code into the dashboard SPA — they register metadata that the dashboard reads at runtime.

The ownership split is:

| Layer | Owner |
|-------|-------|
| Plugin discovery, lifecycle, tool/route registration | OpenClaw |
| Dashboard contribution schema and registry | ClawForce |
| Rendering extension metadata | Dashboard SPA |

**OpenClaw loads extensions. ClawForce interprets extensions.**

This means:
- Your plugin still uses OpenClaw APIs for `registerTool()`, `registerHttpRoute()`, and lifecycle hooks
- Your plugin uses the ClawForce extension API to declare what dashboard surfaces it contributes
- ClawForce does not load or bundle your plugin code

---

## Registration API

### `registerDashboardExtension(contribution)`

Registers a dashboard extension contribution. Returns an unregister function.

```typescript
import { registerDashboardExtension } from "clawforce/dashboard/extensions";

const unregister = registerDashboardExtension({
  id: "my-extension",
  title: "My Extension",
  version: "1.0.0",
  description: "Optional description",
  source: {
    kind: "openclaw-plugin",
    pluginId: "@myorg/plugin-my-extension",
  },
  pages: [...],
  panels: [...],
  actions: [...],
  configSections: [...],
});

// When the plugin unloads:
unregister();
```

### Validation rules

- `id` and `title` must be non-empty strings
- All items within `pages`, `panels`, `actions`, and `configSections` must have unique `id` values
- Routes must start with `/`
- Each `action` must define either `route` or `actionId`

Registration throws if validation fails.

---

## Contribution Types

### Pages

A page is a full dashboard route contributed by the extension.

```typescript
pages: [
  {
    id: "my-page",             // unique within this extension
    title: "My Page",          // displayed in nav and page header
    route: "/my-page",         // must start with /
    navLabel: "My Page",       // optional nav label (falls back to title)
    surface: "nav",            // where to mount: "nav" | "monitor" | "workspace" | "overview" | "org" | "tasks" | "approvals" | "comms" | "config"
    order: 100,                // optional sort order in nav
    domainScoped: true,        // optional: if true, page is per-domain
    hidden: false,             // optional: hide from nav (still routable)
    description: "...",        // optional
  },
]
```

### Panels

A panel is a card or embedded section contributed to an existing dashboard surface.

```typescript
panels: [
  {
    id: "my-panel",
    title: "My Panel",
    surface: "overview",       // target surface (not "nav")
    slot: "sidebar",           // optional: "main" | "sidebar" | "drawer"
    route: "/my-panel-data",   // optional: data source route
    order: 10,
    domainScoped: true,
    description: "...",
  },
]
```

### Actions

An action is an operator-facing button that appears on a surface.

```typescript
actions: [
  {
    id: "my-action",
    label: "Run My Action",
    surface: "agent-detail",   // "nav" | "monitor" | "workspace" | "overview" | "org" | "tasks" | "approvals" | "comms" | "config" | "agent-detail" | "task-detail"
    route: "/my-action",       // OR actionId — at least one required
    actionId: undefined,
    order: 10,
    domainScoped: true,
    description: "...",
  },
]
```

### Config sections

A config section contributes a tab to the Config view.

```typescript
configSections: [
  {
    id: "my-config",
    title: "My Config",
    editor: "structured",      // "raw" | "structured" | "dual"
    order: 20,
    description: "...",
  },
]
```

---

## Capability Awareness

Extensions can declare capability requirements. If the declared endpoint or feature is not available, the dashboard can hide or disable the extension contribution.

```typescript
registerDashboardExtension({
  id: "my-extension",
  title: "My Extension",
  requiredFeatures: ["experiments"],
  requiredEndpoints: ["/clawforce/api/experiments"],
  // ...
});
```

The dashboard checks capability availability via `GET /clawforce/api/runtime`.

---

## Plugin Integration

When building an OpenClaw plugin that contributes to the ClawForce dashboard:

1. Register your tools and routes through the normal OpenClaw plugin API
2. Register your dashboard contribution with ClawForce at plugin init time
3. Call the returned unregister function when the plugin unloads

```typescript
// my-plugin/index.ts
import type { ClawPlugin } from "openclaw";
import { registerDashboardExtension } from "clawforce/dashboard/extensions";

let unregisterDashboard: (() => boolean) | null = null;

export const plugin: ClawPlugin = {
  id: "@myorg/plugin-my-extension",

  async init(api) {
    // Register tools and routes via OpenClaw
    api.registerTool({ name: "my-tool", handler: myToolHandler });
    api.registerHttpRoute({ path: "/my-extension", handler: myRouteHandler });

    // Register dashboard contribution with ClawForce
    unregisterDashboard = registerDashboardExtension({
      id: "my-extension",
      title: "My Extension",
      source: {
        kind: "openclaw-plugin",
        pluginId: "@myorg/plugin-my-extension",
      },
      pages: [
        {
          id: "my-extension-page",
          title: "My Extension",
          route: "/my-extension",
          navLabel: "My Extension",
          surface: "nav",
          domainScoped: true,
        },
      ],
    });
  },

  async shutdown() {
    unregisterDashboard?.();
  },
};
```

---

## Example: Experiments Extension

The experiments plugin is the reference implementation for the ClawForce extension architecture.

```typescript
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

---

## Reading the Extension Registry

Registered extensions are served at:

```
GET /clawforce/api/extensions
```

Response:

```json
{
  "extensions": [
    {
      "id": "my-extension",
      "title": "My Extension",
      "version": "1.0.0",
      "source": { "kind": "openclaw-plugin", "pluginId": "..." },
      "requiredFeatures": [],
      "requiredEndpoints": [],
      "pages": [...],
      "panels": [...],
      "actions": [...],
      "configSections": [...]
    }
  ],
  "count": 1
}
```

---

## Limitations

Extensions cannot:

- Modify ClawForce core behavior
- Bypass role-based access control on config fields
- Inject code into the dashboard SPA at runtime
- Register tools or routes directly (use OpenClaw for that)
- Access the ClawForce SQLite database directly
- Override or replace built-in dashboard views

Extensions can only contribute metadata. Rendering is always controlled by the dashboard SPA.

---

## Other Registry Functions

```typescript
import {
  unregisterDashboardExtension,
  listDashboardExtensions,
  getDashboardExtension,
  clearDashboardExtensions,
} from "clawforce/dashboard/extensions";

unregisterDashboardExtension("my-extension");       // remove by id
listDashboardExtensions();                          // all registered, sorted by title
getDashboardExtension("my-extension");              // get by id (null if not found)
clearDashboardExtensions();                         // clear all (useful for tests)
```

---

## Architecture Reference

For the full design rationale, see `docs/DASHBOARD_EXTENSION_ARCHITECTURE.md`.
