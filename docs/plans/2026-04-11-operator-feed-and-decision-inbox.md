# Operator Feed And Decision Inbox

> Last updated: 2026-04-11

## Goal

Define the primary operator UX for ClawForce:

- one canonical feed the operator can live in
- a narrower decision inbox for actual human decisions
- a clean mapping from checks, issues, proposals, approvals, and agent messages
  into those surfaces

This builds on the existing attention model in
[src/attention/types.ts](/Users/lylejens/workplace/clawforce/src/attention/types.ts)
and the operator roadmap in
[2026-04-06-operator-experience-roadmap.md](/Users/lylejens/workplace/clawforce/docs/plans/2026-04-06-operator-experience-roadmap.md).
See also
[2026-04-11-domain-execution-mode-and-dry-run.md](/Users/lylejens/workplace/clawforce/docs/plans/2026-04-11-domain-execution-mode-and-dry-run.md)
for the domain-level dry-run / live execution model that should feed simulated
actions, setup alerts, and go-live decisions into this surface.

## Product Stance

The operator should not have to hunt across separate queues to understand what
matters.

The default experience should be:

1. open ClawForce
2. scan one feed
3. decide what needs approval, what needs attention, and what can be ignored
4. drill into the right surface only when needed

This means the feed is the primary operator surface.

It does **not** mean every event becomes an approval.

## Locked Decisions

- the operator feed is canonical
- the decision inbox is a filtered view of the feed, not a separate truth system
- the existing `attention` urgency model remains useful, but it is not rich
  enough by itself
- approvals are for actual decision boundaries
- alerts are for cases the system cannot safely handle on its own
- issues represent governed problems that may still be auto-remediated
- proposals represent proactive next-step recommendations, not just failures
- info items exist so the system can stay legible without turning every update
  into a decision

## Canonical Feed Item Model

Every surfaced operator item should normalize into one feed record with these
dimensions:

- `kind`
  - `info`
  - `issue`
  - `proposal`
  - `approval`
  - `alert`
- `severity`
  - `critical`
  - `high`
  - `normal`
  - `low`
- `actionability`
  - `needs_action`
  - `watching`
  - `fyi`
- `automationState`
  - `auto_handled`
  - `auto_handling`
  - `blocked_for_agent`
  - `needs_human`
- `projectId`
- `entityType` / `entityId` when applicable
- `taskId` / `proposalId` / `issueId` when applicable
- `title`
- `summary`
- `evidence`
- `recommendedAction`
- `destination`
- `focusContext`
- `createdAt`
- `updatedAt`

The existing `AttentionItem` model should evolve toward this shape rather than
being replaced by a parallel operator model.

## Kind Semantics

### `info`

Use for material context that helps the operator maintain orientation but does
not currently require intervention.

Examples:

- a release finished
- a bundle verification passed
- a task completed
- a low-risk safe playbook auto-resolved an issue

### `issue`

Use for governed problems detected by checks, validators, policies, or agents.

An issue means:

- something is wrong, risky, or incomplete
- ownership should be clear
- the system may still be able to remediate it automatically

Examples:

- integrity flag
- temporal overlap
- missing source coverage
- budget pressure

### `proposal`

Use for proactive recommendations about what should change next.

A proposal is not necessarily a failure. It is often an evolution signal.

Examples:

- add a new safe playbook for a recurring issue type
- tighten a config policy
- onboard a new jurisdiction
- split an overloaded specialist role
- automate a manual validation step

### `approval`

Use only when the system reaches a real human decision boundary.

Approvals should be comparatively rare and high-signal.

Examples:

- promote an entity from `shadow` to `active`
- accept a risky data remediation
- override a blocking integrity finding
- approve a release that affects production
- authorize money spend above policy

### `alert`

Use when the system cannot safely continue or cannot safely decide.

An alert is stronger than an issue. It indicates a blocked or ambiguous
situation that requires intervention beyond ordinary routing.

Examples:

- agent cannot safely resolve source conflict
- entity remains degraded after repeated remediation attempts
- policy contradiction blocks automation
- runtime or integration failure prevents checks from running

## What Belongs In The Decision Inbox

The decision inbox is a filtered operator view containing only:

- `approval` items
- `alert` items with `automationState = needs_human`
- `proposal` items explicitly marked as requiring operator choice

The decision inbox should **not** contain:

- routine issue noise
- ordinary FYI events
- problems already being auto-remediated safely
- messages that are informational but not blocking

This keeps the inbox high-signal and prevents approval fatigue.

## How Existing Surfaces Map Into The Feed

### Attention

Current `attention` items map into the feed as:

- urgency -> `actionability`
- category -> part of classification metadata
- title / summary / destination stay the same

The attention builder should become the first feed aggregator, not a separate
concept.

### Proposals

Current approval proposals should map into the feed as either:

- `approval` when a human decision is already required
- `proposal` when it is a recommended next step but not yet at a hard gate

### Entity Issues

Entity issues should materialize as `issue` items by default.

They may escalate into:

- `alert` when they block safe automation or remain unresolved after retries
- `approval` when policy says human signoff is required to proceed

### Inbox / Messages

Operator-directed agent messages should not all become feed items.

Message threads should surface into the feed only when they are:

- unread and action-needed
- attached to an approval or alert
- explicitly marked as operator-relevant

Otherwise they remain in comms.

## Automation Policy

The feed should reflect what the system is doing, not just what it wants.

### Silent automation

Do not surface by default:

- rerunning safe checks
- recomputing entity health
- opening internal remediation tasks
- refreshing manifests or generated views

### Feed without decision

Surface as `info` or `issue`:

- new issue detected
- issue resolved automatically
- entity health degraded
- recurring problem pattern observed

### Feed plus decision

Surface as `approval` or `alert`:

- a risky transition is requested
- a policy override is needed
- automation is blocked by ambiguity
- a release cannot continue without operator judgment

## App-Specific Discrepancy Flow

ClawForce should not hardcode domain semantics, but it should govern the flow.

The right split is:

1. the app defines checks
2. the app defines parsers/classifiers
3. ClawForce turns results into structured issues
4. ClawForce synthesizes entity health/state effects
5. ClawForce routes remediation or safe playbooks
6. ClawForce emits feed items
7. ClawForce escalates to approvals or alerts when policy requires it

This lets apps teach ClawForce what failures mean without turning ClawForce into
opaque app-specific magic.

## RentRight Examples

### Example 1: Temporal overlap in Los Angeles

- check result -> `issue`
- issue type -> `temporal_issue`
- entity health -> `degraded`
- feed item -> `issue`, `severity=high`, `actionability=needs_action`
- if auto-remediation exists, the feed should show that remediation is underway
- if remediation fails repeatedly, escalate to `alert`

### Example 2: Shadow to active promotion

- clean checks and no blocking issues are necessary but not sufficient
- the promotion request becomes an `approval`
- the decision inbox should show:
  - entity
  - evidence summary
  - what changed
  - what risk remains
  - recommended action

### Example 3: Repeated semantic warning pattern

- recurring low-risk semantic mismatches should create a `proposal`
- the proposal asks whether to change a playbook, parser, or issue policy
- this should not be an approval unless the proposed change crosses a risk
  boundary

## Operator Views

### Default feed

Recommended default filters:

- `Needs action`
- `Watching`
- `All`

Recommended quick pivots:

- `Approvals`
- `Alerts`
- `Issues`
- `Proposals`
- `Messages`

### Decision inbox

Recommended sections:

- `Approvals`
- `Human-needed alerts`
- `Decision proposals`

### Deep-link rule

Clicking any feed item must land the operator in the exact surface needed to act
with the right entity, task, proposal, or thread already focused.

## Data And Routing Rules

Every feed item should carry enough identity to avoid lossy joins later:

- `projectId`
- `entityType` / `entityId`
- `taskId` if task-backed
- `proposalId` if approval-backed
- `issueId` if issue-backed
- `sourceType`
- `sourceId`

The feed should be materialized from canonical records, not maintained as a
separate mutable truth table.

## Implementation Order

1. extend `AttentionItem` toward a richer feed item model
2. add feed adapters for:
   - entity issues
   - approvals/proposals
   - operator-relevant messages
3. create a unified feed query in dashboard and CLI
4. add the decision inbox as a filtered feed view
5. add proactive proposal generation from recurring issue patterns
6. add per-domain routing policy for what becomes:
   - silent automation
   - issue
   - alert
   - approval

## Non-Goals

This spec does not imply:

- every event should be surfaced
- every issue should require approval
- every message belongs in the main feed
- apps should lose control over their own semantic checks

## Success Criteria

This model is working when:

- the operator can live out of one feed most of the time
- the decision inbox stays small and high-signal
- routine automation remains visible without becoming noisy
- app-specific discrepancies become governed items instead of ad hoc logs
- proposals surface product evolution opportunities, not just failures
- the operator rarely has to ask “where should I look next?”
