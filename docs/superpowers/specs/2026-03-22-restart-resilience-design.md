# Gateway Restart Resilience — Design Spec

## Problem

When the gateway restarts (crash, deploy, manual restart), in-flight state is orphaned:
- Tasks stuck in IN_PROGRESS with no active agent session to complete them
- Dispatch queue items stuck in "dispatched" state that will never receive a response
- Tasks in ASSIGNED with expired leases that will never be picked up

This leaves the system in a stale state requiring manual SQL intervention to recover.

## Solution

Add orphan session recovery to the `gateway_start` hook in `adapters/openclaw.ts`. On gateway startup, sweep all active projects and recover orphaned state before accepting new work.

## Recovery Steps

### 1. Recover Orphaned Sessions

On `gateway_start`, iterate each active project and call `recoverOrphanedSessions()` (already exists in `src/enforcement/tracker.ts`). This detects agent sessions that were active before the restart but no longer have a running process.

### 2. Release Stale IN_PROGRESS Tasks

Detect tasks stuck in IN_PROGRESS with no active session backing them:
- Query tasks where `state = 'IN_PROGRESS'` and no matching active session exists
- Release their leases via `releaseTaskLease()` from `src/tasks/ops.ts`
- Transition them back to ASSIGNED via `transitionTask()` so they can be re-picked-up

### 3. Fail Stale Dispatch Queue Items

Detect dispatch queue items in "dispatched" state that are older than the gateway start time:
- These items were dispatched to agent sessions that no longer exist
- Call `failItem()` from `src/dispatch/queue.ts` on each stale item
- This allows the sweep to re-queue them on the next tick

### 4. Release Expired ASSIGNED Leases

Detect tasks in ASSIGNED state with expired leases:
- These are tasks that were leased to an agent that never started working on them
- Release their leases via `releaseTaskLease()` so other agents can pick them up

### 5. Log Recovery Summary

After all recovery steps, log a single summary line:
```
"Recovered X orphaned sessions, Y stale tasks, Z failed dispatches"
```

This gives operators visibility into the scope of the restart impact.

## Implementation Location

The recovery logic should be called from the `gateway_start` hook in the OpenClaw adapter. The hook already fires once when the gateway process initializes, making it the natural place for recovery before the system starts accepting new agent connections.

```typescript
// In adapters/openclaw.ts gateway_start hook
async function onGatewayStart() {
  const projects = getActiveProjects();
  let orphanedSessions = 0;
  let staleTasks = 0;
  let failedDispatches = 0;

  for (const project of projects) {
    orphanedSessions += await recoverOrphanedSessions(project.id);
    staleTasks += await releaseStaleInProgressTasks(project.id);
    failedDispatches += await failStaleDispatchItems(project.id, gatewayStartTime);
    await releaseExpiredAssignedLeases(project.id);
  }

  log.info(`Recovered ${orphanedSessions} orphaned sessions, ${staleTasks} stale tasks, ${failedDispatches} failed dispatches`);
}
```

## Critical Files

- `adapters/openclaw.ts` — `gateway_start` hook where recovery is triggered
- `src/enforcement/tracker.ts` — `recoverOrphanedSessions()` function (already exists)
- `src/tasks/ops.ts` — `releaseTaskLease()`, `transitionTask()` for releasing and reassigning stuck tasks
- `src/dispatch/queue.ts` — `failItem()` for failing stale dispatch queue entries

## Acceptance Criteria

- After a gateway restart, no tasks remain stuck in IN_PROGRESS without an active session
- After a gateway restart, no dispatch queue items remain stuck in "dispatched" state from before the restart
- After a gateway restart, expired ASSIGNED leases are released
- A summary log line is emitted showing the count of recovered items
- Recovery runs before the system starts accepting new agent connections
