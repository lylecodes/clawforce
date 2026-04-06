# Dashboard Action Status Spec

> Last updated: 2026-04-05

## Goal

Make dashboard actions truthful and trackable so the UI never pretends a risky
operation completed synchronously when it actually continued in background work.

This spec exists primarily for Pack 7, but it also informs Pack 3 runtime work
and Pack 5 verification.

## Product Commitments This Spec Must Honor

- no fake controls
- no unaudited actions
- dashboard is the real control plane over core
- framework remains source of truth
- async behavior should be explicit, not hidden behind a `200`

## Core Principles

### 1. Separate request acceptance from action completion

If work continues after the HTTP response returns, the response must say so.

### 2. Action status is not the same thing as audit

Audit answers “what happened and who did it.”

Action status answers “is the operation still running, done, failed, or stuck.”

They should reference each other, not replace each other.

### 3. Accepted work must be trackable

A `202 Accepted` response without a durable status record is not mature enough.

### 4. Immediate work should still be wrapped consistently

The UI should not need one mental model for sync actions and a totally separate
one for async actions.

### 5. Risky operator actions need durable visibility

Kill, emergency, and other high-impact operations should remain visible after a
toast disappears or a page reloads.

## Action Execution Classes

### Immediate

The mutation completes before the request returns.

Examples:

- approvals approve/reject
- most task actions
- agent enable/disable
- direct message persistence
- meeting create/message/end
- config validate
- most config save actions
- budget allocation
- domain enable/disable

### Accepted / Background

The server accepts the request, then background work continues after the HTTP
response.

Examples:

- agent kill
- domain kill
- future bulk/import/export operations
- future extension actions with long-running side effects

### Streamed

The client receives incremental output over SSE or another streaming transport.

Examples:

- assistant/chat surfaces when they are eventually deepened again

This is intentionally not the current critical path, but the model should leave
room for it.

## Canonical Status Set

Recommended states:

- `accepted`
- `queued`
- `in_progress`
- `completed`
- `failed`
- `cancelled`
- `timed_out`

Important rule:

- request-level validation and authorization failures are not action states
- those remain plain HTTP errors because the action was never accepted

## Required Action Record Shape

The exact storage can vary, but the framework should expose something close to:

```ts
type DashboardActionRecord = {
  actionId: string;
  projectId: string;
  actor: string;
  actionType: string;
  resourceType?: string;
  resourceId?: string;
  requestId?: string;
  state:
    | "accepted"
    | "queued"
    | "in_progress"
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out";
  summary?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  auditIds?: string[];
  result?: Record<string, unknown>;
};
```

Minimum persistence requirement:

- all accepted/background actions must have durable action records

Recommended later:

- important immediate actions may also emit lightweight action records so the UI
  can show a unified recent-actions timeline

## HTTP Contract

### Immediate success

Recommended response shape:

```json
{
  "ok": true,
  "action": {
    "state": "completed",
    "actionType": "agent.disable"
  },
  "result": {
    "agentId": "a1",
    "status": "disabled"
  }
}
```

The maturity push does not require every immediate action to persist a durable
action record, but the response should still classify the action as completed.

### Accepted/background success

Required response shape:

```json
{
  "ok": true,
  "action": {
    "actionId": "act_123",
    "state": "accepted",
    "actionType": "domain.kill",
    "statusUrl": "/clawforce/api/test/actions/act_123"
  }
}
```

HTTP status must be `202`.

### Immediate failure

If the action fails before acceptance:

- return the correct HTTP error
- do not pretend the action is queued
- include structured error code where helpful

Examples:

- validation failure
- auth failure
- lock conflict
- unknown resource

## Query Model

Recommended endpoints:

- `GET /clawforce/api/:domain/actions`
- `GET /clawforce/api/:domain/actions/:actionId`

Recommended list filters:

- `status`
- `actionType`
- `resourceType`
- `resourceId`
- `limit`
- `offset`

The dashboard should be able to restore outstanding operator work after reload.

## SSE Model

Recommended addition:

- `action:update`

Payload should include:

- `actionId`
- `state`
- `actionType`
- `resourceType`
- `resourceId`
- `summary`
- `error`
- `updatedAt`

Important rule:

- do not emit `accepted` in HTTP and then never publish a terminal state

## State Transition Rules

### Common path

`accepted -> queued -> in_progress -> completed`

### Failure paths

- `accepted -> failed`
- `queued -> failed`
- `in_progress -> failed`
- `in_progress -> timed_out`
- `queued -> cancelled`

### Short-circuit path

Some accepted actions may go straight from:

- `accepted -> in_progress`
- `accepted -> completed`

That is fine as long as the status record remains truthful.

## Current Core Action Classification

### Immediate in current maturity model

- `approvals/:id/approve`
- `approvals/:id/reject`
- `tasks/create`
- `tasks/:id/reassign`
- `tasks/:id/transition`
- `tasks/:id/evidence`
- `agents/:id/disable`
- `agents/:id/enable`
- `agents/:id/message`
- `meetings/*`
- `messages/*`
- `config/validate`
- `config/save`
- `budget/allocate`
- `disable`
- `enable`
- context file writes

### Accepted/background in current maturity model

- `kill`
- `agents/:id/kill`

### Streamed / not current critical path

- assistant and deeper live operator-chat flows

## Idempotency And Retry

High-impact accepted actions should support a client-supplied request key.

Recommended field:

- `requestId`

Recommended behavior:

- same request body + same `requestId` returns the same action record
- conflicting body + same `requestId` returns `409`
- retries after network loss should be safe for accepted actions

The public API can later map this onto a formal `Idempotency-Key` header, but
dashboard maturity does not need to block on that.

## Cancellation

v1 does not need a fully general cancellation framework, but the spec should be
clear:

- if an accepted action is cancellable, that must be explicit
- kill/emergency operations should not be treated as casually cancellable once
  they are in progress

If cancellation is added later, use:

- `POST /clawforce/api/:domain/actions/:actionId/cancel`

## Recovery And Degraded Behavior

### Client reload

The UI should:

- restore outstanding actions from `GET /actions`
- continue listening for `action:update`

### Background failure

If background work fails after acceptance:

- action record must move to `failed`
- error should be operator-visible
- audit trail should remain intact

### Tracking-store failure

Do not return `202` unless an action record can actually be created.

If durable tracking is unavailable:

- fail the request explicitly
- or complete it synchronously if the action is genuinely immediate

Never lie about trackability.

## UI Requirements

Minimum dashboard behavior:

- accepted actions show a durable pending state, not just a toast
- high-risk actions remain visible in ops/activity surfaces until terminal
- terminal failures are visible after reload
- the UI distinguishes:
  - accepted
  - still running
  - completed
  - failed
- buttons should not imply “done” when the action is merely accepted

Recommended surfaces:

- ops center recent actions
- resource-level inline status
- global action/activity timeline

## Audit Relationship

Every mutating action should continue writing audit entries.

Recommended relationship:

- action record references audit IDs
- audit log may reference action ID in detail metadata

This keeps execution status and immutable history connected.

## Extension Boundary

Extensions may introduce accepted/background actions only if they use the same
action-status model.

Do not let extension actions invent a second async vocabulary.

## Release-Bar Acceptance

Pack 7 should not be considered done until:

- every accepted/background dashboard action returns an action ID
- accepted actions have durable status records
- the dashboard can restore pending actions after reload
- SSE or polling can surface terminal states
- risky actions no longer masquerade as immediate success
- tests cover success, failure, and retry/degraded behavior

