# Claude Handoff

Use this as the top-level brief for Claude Code while the dashboard maturity
work is being implemented.

## What Is Happening

ClawForce is in the middle of making the base dashboard the full operator
surface for all ClawForce core capabilities.

This is an implementation push, not a strategy discussion.

The planning docs already exist. Execution should follow them.

## Read These First

1. `docs/DASHBOARD_PRODUCT_STANCE.md`
2. `docs/plans/2026-04-05-dashboard-maturity-roadmap.md`
3. `docs/plans/2026-04-05-dashboard-parallel-execution-plan.md`
4. `docs/plans/2026-04-05-dashboard-acceptance-matrix.md`
5. `docs/plans/2026-04-05-dashboard-subagent-prompts.md`

Platform follow-on planning exists here:

- `docs/plans/2026-04-05-extension-ecosystem-roadmap.md`
- `docs/plans/2026-04-05-public-api-sdk-roadmap.md`

Implementation-shaping specs exist here:

- `docs/plans/2026-04-05-dashboard-shell-ia-spec.md`
- `docs/plans/2026-04-05-lock-override-spec.md`
- `docs/plans/2026-04-05-dashboard-action-status-spec.md`
- `docs/plans/2026-04-05-openclaw-boundary-matrix.md`
- `docs/plans/2026-04-05-extension-proving-spec.md`
- `docs/plans/2026-04-05-dashboard-release-gate.md`

## Current Goal

Finish the dashboard maturity roadmap so the base dashboard is:

- the default UI for all ClawForce core capabilities
- trustworthy and non-lossy
- coherent for a solo operator running multiple businesses
- extensible without forking core

## Current Critical Path

1. finish config fidelity
2. implement locks/overrides and action-state truthfulness
3. harden runtime/deployment/auth behavior
4. finish shell/operator-flow coherence
5. add end-to-end operator verification
6. prove the extension path with a real extension

## Non-Negotiable Product Boundaries

- dashboard is the full control plane for ClawForce core
- framework remains source of truth
- experiments are not core
- no fake controls
- no hidden file-first behavior
- no implicit magic outside explicitly modeled behavior
- no unaudited actions

## OpenClaw Boundary

Do not duplicate OpenClaw ownership.

OpenClaw owns:

- plugin discovery and lifecycle
- embedded auth/session ownership
- plugin loading infrastructure

ClawForce owns:

- dashboard semantics
- standalone server behavior
- extension contribution schema and rendering semantics
- runtime metadata, capabilities, audit expectations

## Public Platform Decisions Already Locked

- streams are queryable first, live second
- events are the main reactive primitive
- not all streams should be live
- embedded auth is OpenClaw-owned
- standalone auth is ClawForce-owned
- future public API auth should use explicit machine-auth

## Out Of Scope For This Push

- deeper assistant/operator-console phase 2
- research/eval system
- org templates as a product track
- reimplementing plugin management inside ClawForce
- recreating OpenClaw embedded auth inside ClawForce

## Execution Rules

- follow the parallel execution plan
- keep write scopes disjoint where possible
- do not reopen already locked product decisions
- update docs only when implementation changes reality
- preserve the OpenClaw boundary at all times

## Definition Of Success

Do not call the dashboard mature until:

- no known lossy config sections remain
- locks and override semantics are real and audited
- standalone vs embedded runtime behavior is documented and tested
- the shell has one intentional operator-home model
- critical operator flows are covered end-to-end
- extension path is proven with a real non-core extension
- release/deployment/operator docs match the product
