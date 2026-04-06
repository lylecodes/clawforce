# Dashboard Lock And Override Spec

> Last updated: 2026-04-05

## Goal

Translate the dashboard product stance into an implementable framework and UI
contract for human authority, agent autonomy, and persistent locks.

This spec exists so Pack 6 can build one coherent model instead of inventing
ad hoc lock behavior in multiple places.

## Product Commitments This Spec Must Honor

Already locked in product stance:

- dashboard changes apply immediately
- framework remains source of truth
- agents retain autonomy unless the human explicitly locks a change
- locks persist until a human explicitly unlocks them
- users can intervene at any level
- tasks are not a general-purpose lock surface in v1
- emergency and kill behavior must remain available

## Core Principles

### 1. Lock truth lives in framework state

The dashboard may render and edit lock state, but it must not become a second
source of truth.

### 2. Human changes are not automatically “sacred” by default

Under the default policy, a human can change a lockable value without locking
it. That change takes effect immediately, but agents may later change it again
if policy allows.

### 3. Locks are explicit and durable

If a human wants persistent authority over a lockable surface, that must be
represented by a real stored lock, not inferred from “last writer wins.”

### 4. Locked state blocks agent-originated mutation, not human operation

Humans should still be able to edit a locked surface. The lock exists to
preserve human authority against autonomous mutation, not to freeze the UI.

### 5. Safety can outrank locks

Emergency stop, kill, and critical safety enforcement must be allowed to bypass
locks when necessary. Those bypasses must be explicit and audited.

### 6. v1 granularity should be stable and boring

Do not implement arbitrary JSON-path locks in v1. Use stable surface keys the
framework and UI can understand without guesswork.

## Terms

### Lockable surface

A core domain surface where human authority may be persisted and enforced.

### Manual change

A human-originated mutation to a lockable surface that applies immediately.

### Lock

A persistent framework record stating that agent-originated mutation for a
specific lock key is blocked until a human unlocks it.

### Override policy

The domain-level rule for what happens after a human changes a lockable
surface.

### Lock key

A stable identifier for a lockable scope. v1 should use semantic keys, not raw
JSON paths.

## Override Policy

Override precedence must be configurable, but the maturity path should start
with a small explicit policy set.

### Required v1 policy values

#### `autonomous_until_locked` (default)

- human change applies immediately
- no persistent protection is created unless the user explicitly locks
- agents may later mutate the same surface if their policy allows it

#### `manual_changes_lock`

- human change applies immediately
- if the target surface is lockable, the change also creates or refreshes a
  lock for that surface
- agents are blocked until a human unlocks it

This second mode is intentionally simple. It avoids implementing a fuzzy
“manual wins unless maybe later” state machine.

### v1 policy scope

The default should be domain-level, not per-user.

Later, ClawForce may support per-surface overrides, but that is not required
for the maturity push.

## Lockable Surfaces In v1

These should support explicit locks by default:

- budget windows
- initiative allocations
- agent enabled/disabled state
- org structure
- rules
- jobs
- tool gates
- direction, policies, standards, architecture, and file-backed context docs

These should not become general-purpose lock surfaces in v1:

- tasks
- approvals
- comms/messages
- meetings
- read-only observability surfaces

Task exception:

- humans may still cancel/archive a task for stop/kill purposes
- task removal means cancel/archive with audit trail, not delete

## Recommended v1 Lock Granularity

The goal is stable enforcement without arbitrary path math.

### Budget

- `budget.window.hourly`
- `budget.window.daily`
- `budget.window.monthly`
- `budget.initiative.<initiativeId>`

### Agent state

- `agent.state.<agentId>`

### Org structure

- `org.agent.<agentId>`

This covers reporting line, department, team, or similar agent-topology edits.

### Config sections

Where stable entry IDs do not exist yet, use section-level locks:

- `config.section.rules`
- `config.section.jobs`
- `config.section.tool_gates`

If Pack 6 adds durable entry identifiers later, entry-level keys can be added
without breaking the section-level model.

### Context and docs

- `doc.direction`
- `doc.policies`
- `doc.standards`
- `doc.architecture`
- `doc.file.<relativePath>`

## Required Lock Record Shape

The exact storage implementation may vary, but the framework should expose a
stable record close to this:

```ts
type DashboardLockRecord = {
  id: string;
  projectId: string;
  lockKey: string;
  surface: "budget" | "agent_state" | "org" | "config_section" | "doc";
  actor: string;
  reason?: string;
  createdAt: number;
  updatedAt: number;
};
```

v1 should not require expiration timestamps. Locks are persistent until unlock.

## Mutation Semantics

### Human mutation of an unlocked surface

- apply immediately
- audit as a normal human action
- if override policy is `manual_changes_lock`, create or refresh the lock
- if override policy is `autonomous_until_locked`, do not create a lock unless
  explicitly requested

### Human mutation of a locked surface

- allowed
- lock remains in place unless the user explicitly unlocks
- audit should show both the mutation and the continued lock ownership

### Agent mutation of an unlocked surface

- allowed if the underlying policy allows it

### Agent mutation of a locked surface

- rejected with a clear lock violation
- auditable as a blocked mutation attempt

### Safety/system bypass

The following classes may bypass locks:

- emergency stop
- kill
- critical safety disable/containment actions

Bypass requirements:

- explicit action classification
- explicit audit entry showing lock bypass
- no silent unlock side effect

## API And Query Model

The maturity push should avoid inventing lock semantics separately in every
resource endpoint.

### Query requirements

At minimum, the dashboard needs:

- lock metadata on affected read surfaces
- a generic lock listing endpoint for operator visibility

Recommended reads:

- `GET /clawforce/api/:domain/locks`
- read surfaces embed lock metadata where directly relevant

### Mutation requirements

There should be two paths:

#### 1. Change-and-lock in one request

Lockable mutations should accept an optional lock instruction:

```json
{
  "value": "...",
  "lock": true,
  "lockReason": "Freeze budget during launch week"
}
```

#### 2. Standalone lock/unlock actions

Recommended endpoints:

- `POST /clawforce/api/:domain/locks/lock`
- `POST /clawforce/api/:domain/locks/unlock`

Recommended request shape:

```json
{
  "lockKey": "budget.window.daily",
  "reason": "Protect launch budget",
  "actor": "dashboard"
}
```

This keeps lock management explicit and reusable across surfaces.

## Error Shape

Agent mutations blocked by locks should return an explicit conflict, not a
generic failure.

Recommended response:

```json
{
  "ok": false,
  "errorCode": "LOCKED_BY_HUMAN",
  "error": "budget.window.daily is locked by a human operator",
  "lock": {
    "lockKey": "budget.window.daily",
    "actor": "dashboard",
    "createdAt": 1770000000000,
    "reason": "Protect launch budget"
  }
}
```

HTTP status should be `409`.

## Audit Requirements

At minimum, the framework must audit:

- lock created
- lock updated/refreshed
- lock removed
- agent mutation blocked by lock
- safety/system bypass of a lock

Suggested audit actions:

- `lock_set`
- `lock_refreshed`
- `lock_removed`
- `lock_blocked_mutation`
- `lock_bypassed`

## SSE / Live Update Requirements

The dashboard should not force operators to refresh to see lock truth.

Recommended additions:

- `lock:update` SSE event for lock set/remove/change
- include lock metadata on any related `config:changed`, `agent:status`, or
  `budget:update` payload where relevant

If Pack 7 introduces a generic action-status stream, lock actions should also
participate in it.

## UI Requirements

The dashboard should distinguish clearly between:

- editable and unlocked
- edited by human but still autonomous
- explicitly locked

Minimum UI requirements:

- visible lock badge on lockable surfaces
- lock reason visible without deep drilling
- explicit unlock control
- explicit “save and lock” option where it matters most
- clear messaging when an agent-originated change was blocked by a lock

The UI should avoid implying that every human change is automatically locked.

## Extension Boundary

Extensions may participate in locks only if they declare stable semantic lock
keys and enforce them through ClawForce-owned mutation paths.

Do not let extensions invent incompatible lock semantics outside the framework.

## Release-Bar Acceptance

Pack 6 should not be considered done until:

- lock storage exists in framework truth
- default override policy is implemented
- alternate override policy exists or is explicitly deferred and documented
- lockable v1 surfaces are enforced
- lock/unlock state is visible in the dashboard
- blocked mutations are explicit and audited
- safety bypass behavior is explicit and audited

