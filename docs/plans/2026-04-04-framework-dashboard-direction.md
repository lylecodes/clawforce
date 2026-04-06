# Framework + Base Dashboard Direction

> Last updated: 2026-04-04

## Summary

ClawForce should ship as a framework first.

The dashboard should ship as an optional base control plane for the common
surfaces that nearly every ClawForce deployment shares:

- agent hierarchy
- task orchestration
- approvals
- budget visibility
- context and policy visibility
- trust and telemetry

Canonical operator/product stance:
[`docs/DASHBOARD_PRODUCT_STANCE.md`](../DASHBOARD_PRODUCT_STANCE.md)

Users must be able to adopt ClawForce without adopting the dashboard, and they
must be able to extend the dashboard without forking the framework.

## Product Boundary

### ClawForce framework owns

- canonical concepts and schemas
- task, approval, budget, trust, message, goal, and event semantics
- config loading, validation, and persistence rules
- storage layout and migration logic
- typed query, action, and event contracts consumed by UI layers
- compatibility guarantees and versioning

### Base dashboard owns

- presentation
- operator workflows
- navigation and layout
- visualizations and editing experiences
- the default UI for common ClawForce concepts

### Builders own

- domain-specific views
- custom panels and cards
- custom workflows and actions
- use-case-specific config editors
- branding and packaging on top of the base dashboard

## Design Rules

1. The dashboard is not the source of truth.
2. The framework must be usable without the dashboard.
3. Dashboard features should depend on published ClawForce contracts, not
   private files, ad hoc SQLite queries, or hidden implementation details.
4. If a dashboard feature needs new data or mutations, add or extend a
   framework-owned contract first.
5. Common concepts belong in the base dashboard. Use-case-specific concepts
   belong in extensions.

## Extension Model

The base dashboard should be designed for extension rather than forks.

### Preferred extension points

- custom pages in navigation
- extra cards on agent, task, org, and analytics screens
- custom actions backed by framework APIs
- domain-specific config sections
- capability-gated UI modules
- branding, theming, and layout customization

### Anti-patterns

- dashboard code writing framework files directly
- dashboard code assuming `~/.clawforce` instead of using framework-owned config
  services
- dashboard code depending on raw tables when a framework API should own the
  contract
- framework changes silently breaking dashboard consumers
- forcing users to fork the base dashboard for normal customization

## Packaging Direction

The likely shape is:

- `clawforce`: framework runtime, SDK, storage, orchestration, contracts
- `clawforce/dashboard` or `clawforce-dashboard-base`: optional base control
  plane for common ClawForce operations
- extension packages: domain-specific additions built on top of the base
  dashboard

Exact package names can change. The boundary should not.

## Implementation Consequences For This Repo

When adding or changing dashboard functionality:

1. Define or update the framework-owned contract first.
2. Keep config and storage access behind framework-owned services.
3. Respect runtime-configured locations such as `CLAWFORCE_HOME`.
4. Treat dashboard actions as consumers of the framework, not alternate
   implementations of framework logic.
5. Keep docs aligned across `README.md`, `CODEX.md`, and this file.

## Why This Direction Fits ClawForce

ClawForce builders will vary by domain, but they still tend to share the same
bones:

- hierarchies of agents
- scoped context for agents
- task routing and review loops
- approvals and governance
- budgets, safety, and observability

That common layer is what the framework and base dashboard should standardize.
The domain-specific layer is what builders should customize.
