# Domain Execution Mode And Dry Run

> Last updated: 2026-04-11

## Goal

Add a first-class dry-run capability to ClawForce so a user can verify that a
domain is configured correctly before trusting live side effects.

This is not the same thing as entity lifecycle.

- `shadow` means "real workflow, not yet authoritative"
- `dry_run` means "side effects are simulated or blocked"

Those must remain separate concepts.

## Problem

Today, a user can onboard an app, sync entities, and run workflows, but there
is no native way to prove the setup is correct before real side effects begin.

That produces the wrong operator experience:

1. set up the domain
2. hope the routes, checks, ownership, and playbooks behave correctly
3. discover mismatches only after live behavior happens

For mature dogfooding, ClawForce needs a "zeroing in" phase:

- prove the config and routing are correct
- show intended side effects
- surface decision points
- let the user verify the setup before going live

## Locked Product Decision

ClawForce should support two separate control axes:

### 1. Domain execution mode

How the domain behaves operationally.

- `dry_run`
- `live`

Later, a third mode may be justified:

- `staging`

But `dry_run | live` is the correct mature v1.

### 2. Entity lifecycle

How trusted a governed object is inside the domain.

Examples:

- `proposed`
- `bootstrapping`
- `shadow`
- `active`
- `retired`

These remain app-defined through entity kinds.

## Product Stance

Dry-run should not mean "fake intelligence."

Agents should still:

- read real context
- run real checks
- create real tasks/issues/proposals/entities
- reason normally
- route work normally

What changes is side-effect execution.

Dry-run is a runtime policy layer, not a prompt trick.

## Core Model

## Domain Config

Add a domain-level execution block:

```yaml
execution:
  mode: dry_run
  default_mutation_policy: simulate
  environments:
    primary: production
    verification: production
  policies:
    tools:
      clawforce_config:
        write: simulate
      clawforce_task:
        create: allow
        transition: allow
      clawforce_entity:
        create: allow
        transition: simulate
      shell:
        default: block
    commands:
      - match: "cd backend && npm run data:validate*"
        effect: allow
      - match: "cd backend && npm run integrity:check*"
        effect: allow
      - match: "cd backend && npm run test:golden*"
        effect: allow
      - match: "cd backend && npm run data:generate*"
        effect: simulate
```

Meaning:

- read/check operations can run for real
- internal governance records can be real
- external or risky mutations are either simulated or blocked

## Mutation Effects

Supported effect values:

- `allow`
- `simulate`
- `block`
- `require_approval`

`require_approval` is optional for v1, but the model should allow it.

## Side-Effect Records

Dry-run needs a first-class durable record of intended mutations.

Add a new durable concept:

- `simulated_actions`

Each record should include:

- `id`
- `project_id`
- `domain_id`
- `agent_id`
- `task_id`
- `entity_type` / `entity_id`
- `source_type` / `source_id`
- `action_type`
- `target_type`
- `target_id`
- `summary`
- `payload`
- `policy_decision`
- `status`
  - `simulated`
  - `blocked`
  - `approved_for_live`
  - `discarded`
- `created_at`
- `resolved_at`

This makes dry-run legible instead of implicit.

## Feed Integration

Simulated behavior must surface in the operator feed.

### `info`

Use for safe simulation summaries:

- "would rerun verification"
- "would create follow-up task"

### `proposal`

Use when the system is proactively suggesting a change that is not a hard gate.

### `approval`

Use when the simulated action crosses a real decision boundary:

- promote an entity
- change production-affecting data
- spend money
- execute a blocked mutation in live mode

### `alert`

Use when dry-run reveals the setup is not coherent:

- no owner can accept the task
- a required check cannot run
- a playbook wants a blocked tool with no safe simulation path
- the config implies contradictory policies

The decision inbox should include dry-run approvals and dry-run alerts.

## What Dry Run Must Allow

These should normally run in dry-run:

- entity creation
- issue creation and resolution
- task creation
- proposal creation
- check execution
- feed item creation
- history/audit records marking actions as simulated

Without this, the user cannot actually verify the flow.

## What Dry Run Must Prevent

These should not execute live unless explicitly allowed:

- file writes to app-owned canonical sources
- production data promotion
- irreversible external delivery
- money-spending actions
- shell commands classified as mutating
- entity transitions that should only happen in live mode

## Tool Policy Model

Dry-run should not be implemented by hardcoding app logic into core.

The correct enforcement layer is:

1. resolve the domain execution mode
2. resolve tool/command mutation policy
3. classify the requested action
4. either:
   - allow it
   - simulate it
   - block it
   - require approval

This should sit alongside existing risk/approval policy rather than replacing
it.

## UX Flow

The intended operator flow is:

1. configure a new domain
2. set `execution.mode = dry_run`
3. run entity sync / checks / kickoff workflows
4. review one feed
5. verify:
   - routing is correct
   - ownership is correct
   - checks execute
   - intended mutations look right
   - approvals appear where expected
   - alerts surface true setup gaps
6. fix onboarding/config problems
7. switch the domain to `execution.mode = live`
8. keep entity lifecycle in `shadow` until the workflow earns trust

That gives a clean progression:

- setup verification
- real-but-shadow operations
- authoritative operations

## RentRight Example

For RentRight:

- domain starts in `execution.mode = dry_run`
- jurisdiction entities stay in `shadow`
- pipeline checks run for real
- issue creation is real
- source onboarding writes are simulated
- entity promotion to `active` remains approval-gated
- generated "would change" actions are visible in the feed

This lets the user verify:

- the right jurisdiction owner received the work
- shared specialists were engaged correctly
- checks and issue synthesis are coherent
- proposed data mutations look sane

before letting live writes happen.

## Why This Is Better Than Overloading `shadow`

If `shadow` means both "not authoritative" and "simulated," the model becomes
confusing fast.

Examples:

- an entity can be `shadow` while the domain is `live`
- an entity can be `shadow` while the domain is `dry_run`
- an entity can be `active` while the domain is still `dry_run` for setup
  verification of other workflows

Keeping execution mode separate from lifecycle is the mature product shape.

## Implementation Order

### Phase 1

- add domain execution config
- add mutation policy resolution
- add simulated action records
- surface simulated actions in the feed
- block/simulate tool calls and shell actions according to policy

### Phase 2

- add dashboard indicators for `dry_run` domains
- add explicit "go live" action
- add policy previews so users can see what would be simulated vs blocked

### Phase 3

- optional `staging` mode
- environment-target routing
- replay/compare between dry-run and live outcomes

## Acceptance Criteria

The feature is successful when:

- a new domain can be onboarded in `dry_run`
- checks and internal governance records still work
- mutating side effects are intercepted by policy
- intended side effects are visible and durable
- the operator can verify the setup from the feed and decision inbox
- moving to `live` is a deliberate transition, not a leap of faith
