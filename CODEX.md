# ClawForce — Codex Context

This file is the Codex-specific companion to `CLAUDE.md`.

## What ClawForce Is

ClawForce is a framework-first governance runtime for autonomous agent systems.
It owns the durable primitives: tasks, approvals, budgets, trust, goals,
messages, context, telemetry, and config semantics.

## Product Direction

ClawForce ships as the framework.

The dashboard is optional and should behave like a base control plane for the
common surfaces almost every ClawForce deployment shares. Builders should be
able to:

- use ClawForce without the dashboard
- use the base dashboard as-is
- extend the base dashboard for their domain

Read:
- `README.md`
- `docs/plans/2026-04-04-framework-dashboard-direction.md`

## Non-Negotiable Boundary

### Framework owns

- canonical schemas and semantics
- config loading, validation, and persistence
- typed query/action/event contracts
- storage and migration rules
- compatibility and versioning

### Dashboard owns

- presentation
- operator workflows
- default UI modules for common ClawForce concepts

### Extensions own

- use-case-specific pages, cards, actions, and config editors

## Rules For Codex Changes

1. Do not make the dashboard the source of truth.
2. Do not let dashboard code bypass framework-owned services for config or
   storage access.
3. If the dashboard needs new data or mutations, add a framework-owned contract
   first.
4. Respect `CLAWFORCE_HOME` and runtime-configured paths.
5. Prefer extension points over hard-coded one-off dashboard behavior.
6. Keep the framework usable without the dashboard.
7. When this boundary changes, update the docs in the same change.

## Practical Checks

Before landing dashboard work, ask:

- Can this be consumed through a published ClawForce contract?
- Does this work if the dashboard is not installed?
- Would a builder need a fork, or can they extend the base dashboard?
- Is the path/config/storage behavior runtime-aware rather than hard-coded?

## Repo Notes

- Runtime: Node 22+
- TypeScript: strict mode
- Main docs: `README.md`, `docs/API.md`, `docs/INTEGRATION.md`
- Direction doc: `docs/plans/2026-04-04-framework-dashboard-direction.md`
- Validate with: `pnpm typecheck`, `pnpm build`, `pnpm vitest --run`
