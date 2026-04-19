# ClawForce Architecture

This file defines the target architecture for ClawForce core.

If the codebase drifts from this document, either:
- bring the code back into alignment, or
- update this document in the same change with an explicit reason.

## Purpose

ClawForce is a local-first governance runtime for autonomous agent systems.
Core owns durable semantics and execution policy. Transports and integrations
sit on top of core; they do not define it.

## Architectural End State

The stable target shape is:

```text
SDK / HTTP / CLI / Dashboard / Adapters
                |
         App Services Layer
      (typed commands + queries)
                |
      Core Domain Modules + Policies
                |
     Runtime Context + Storage + Events
                |
      Ports for schedulers / sessions /
      delivery / auth / external runtimes
```

## Invariants

These are the non-negotiable rules.

1. Core logic is transport-agnostic.
   HTTP, dashboard, CLI, SDK helpers, and adapters all call the same command
   and query services.

2. Runtime state is explicit.
   DB handles, schedulers, config roots, registries, watchers, and emitters
   belong to a runtime/container object, not hidden module globals.

3. Config has one canonical semantic model.
   File edits, API edits, and dashboard edits must round-trip the same meaning.
   The UI is not allowed to flatten or simplify away core semantics.

4. Integrations happen through ports and adapters.
   OpenClaw is an implementation of runtime ports, not the architecture center.

5. Every mutation produces one durable operation trail.
   Commands create an operation record, emit a domain event, and then fan out to
   SSE, notifications, webhooks, and other projections.

6. Public API tiers are explicit.
   The SDK is the stable public surface. Advanced and internal surfaces are
   separate and documented as such.

## Layer Responsibilities

### 1. App Services

Own typed use cases such as:
- create task
- approve proposal
- update config section
- disable domain
- query task detail
- query dashboard summary

Services coordinate multiple domain modules and return stable results for all
transports. They define sync vs accepted/async behavior.

### 2. Core Domain Modules

Own durable semantics:
- tasks
- approvals
- budgets
- trust
- goals
- messaging
- policies
- telemetry
- config semantics

These modules should not know about HTTP, dashboard state, or OpenClaw.

### 3. Runtime Context

Own process-local state and resources:
- database handles
- active domains
- sweep timers
- config watchers
- event emitters
- caches
- path resolution

Core code should depend on a runtime context interface, with a default runtime
for the current single-process setup.

### 4. Ports / Adapters

Ports define what core needs from the outside world:
- session runner
- scheduler
- message injection
- delivery
- auth/context
- filesystem/context roots where needed

Adapters implement those ports for OpenClaw, standalone mode, tests, or future
runtimes.

## Config Model

Config is a canonical document model with typed patch semantics.

Required properties:
- exact round-tripping of core meaning
- canonical diffs before apply
- explicit validation results
- selective runtime reloads where possible
- no dashboard-only shadow schema

Human-readable YAML remains a valid storage format, but YAML formatting or
comment preservation is secondary to semantic fidelity.

## Mutation Flow

Every mutating action should follow one path:

```text
transport request
-> app command
-> validation + lock checks + policy checks
-> domain mutation
-> operation record
-> domain event
-> projections (audit, SSE, notifications, webhooks)
```

No transport should invent side effects outside this path.

## Public Surface

Three tiers:

- `clawforce`
  Stable SDK surface for builders.
- `clawforce/advanced`
  Supported advanced contracts that are intentional but lower-level.
- `clawforce/internal`
  No stability guarantee. Used by ClawForce itself and tightly-coupled tooling.

The repo root export list is not the product contract by accident. Public
surfaces must be curated.

## Extension Boundary

Base ClawForce core owns common governance capabilities.
Base dashboard owns common operator workflows.
Extensions own non-core or domain-specific pages, panels, actions, and config
editors.

Core should expose extension points instead of absorbing every feature.

## Anti-Goals

Do not optimize the architecture toward:
- microservices
- network-first infrastructure
- replacing SQLite for its own sake
- "everything is a stream"
- runtime-specific shortcuts inside core
- dashboard-owned config or storage behavior

## Change Rule

Before landing architectural work, ask:
- Does this strengthen the service boundary?
- Does this reduce hidden global state?
- Does this preserve one canonical config model?
- Does this keep adapters outside core semantics?
- Does this clarify the public contract instead of widening it?

If the answer is no, it is probably not moving toward the target architecture.
