# Setup Productization Roadmap

## Goal

Get ClawForce from "power-user framework with strong internals" to "a user can configure it for their app, trust the workflow, and only see real decisions."

## What "Done" Looks Like

- Users describe policy and outcomes, not internal queue or router behavior.
- Setup can be validated before runtime with actionable next steps.
- A running controller sees config changes without manual babysitting.
- Workflow gaps raise steward proposals automatically instead of falling back to operator folklore.
- Admin tools remain admin tools, not part of normal user operation.

## Workstreams

### 1. Setup Contract

- Keep `config.yaml` and `domains/*.yaml` as the primary user surface.
- Document the minimum viable domain contract:
  - global agents
  - domain agents
  - manager agent
  - project paths
  - execution / verification policy
- Prefer user-facing commands over raw file edits where possible.

### 2. Validate + Explain

- Add a first-class `cf setup` surface:
  - `cf setup status`
  - `cf setup validate`
  - `cf setup explain`
- Report readiness checks, not just schema errors.
- Turn missing setup pieces into explicit fixes and next steps.

Status:
- Implemented in this slice.

### 3. Config Apply / Runtime Honesty

- Config writes must have a clear runtime effect.
- Current gap:
  - `cf config set` now reloads in the calling process, but long-lived controllers still need a first-class config handoff or restart story.
- Needed:
  - controller config reload signal, or
  - explicit "controller restart required" surfacing, or
  - generation-aware hot reload semantics.

### 4. Scaffolding

- Add starter generation for common domain shapes:
  - issue/remediation workflow
  - onboarding workflow
  - production monitoring workflow
  - verifier-driven workflow
- Users should be able to start from a template and refine, not build every role by hand.

### 5. Explainability

- Every surfaced item should answer:
  - why was this created?
  - why is it blocked?
  - why this agent?
  - why not promotable?
  - what config caused it?

### 6. Simulation / Preflight

- Add a pre-runtime dry run for setup:
  - if issue X happens, what task is created?
  - if review fails twice, does steward proposal fire?
  - if entity becomes clean, does promotion proposal fire?

### 7. Workflow Mutation as Product Surface

- Repeated unsupported operator work should become:
  - structured workflow-mutation proposals
  - approval-backed setup changes
  - replay of the affected source path

### 8. Self-Serve Runtime Choices

- Users should select runtime policy declaratively:
  - local controller
  - hosted controller
  - execution adapter
  - mutation policy
- They should not need to reason about internal dispatch plumbing.

### 9. Dogfood Lanes

- Keep one runtime/control-plane dogfood lane active.
- Keep one setup-surface dogfood lane active.
- Current setup-surface dogfood lane:
  - RentRight `source-onboarding-steward.jobs.onboarding-backlog-sweep`
  - added through `cf config set`
  - validated through `cf setup validate`

## Immediate Next Gaps

1. Make live controllers pick up config changes honestly.
2. Keep using config-only changes to add fresh RentRight workflows.
3. Add more setup validation checks around runtime readiness and review/steward coverage.
