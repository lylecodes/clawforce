# Hybrid Dispatch Architecture — Design Spec

*Updated 2026-03-26 — reflects the actual implemented architecture.*

## Background
The original plan was to remove all cron service dependency and dispatch purely
via `api.injectAgentMessage()`. In practice, ClawForce evolved to a **hybrid
model**: OpenClaw's cron API is the primary dispatch mechanism for both scheduled
jobs and one-shot worker dispatch, while an internal sweep loop drives queue
processing on a timer.

The file-based cron fallback (`jobs.json`, `flushPendingCronJobsViaFile()`) and
the `capturedCronAdd`/`pendingCronJobs` indirection layer were removed as
planned. What remains is a direct, reliable integration with OpenClaw's in-process
cron service.

## Architecture

### 1. Cron service capture (bootstrap)
The OpenClaw gateway exposes `context.cron` to plugins. ClawForce captures it
at three points for resilience:

- **`clawforce.init`** gateway method (lazy, on first gateway call)
- **`clawforce.bootstrap`** gateway method (eager, called at `gateway_start`)
- **`clawforce.dispatch`** gateway method (defensive fallback)

Once captured via `setCronService()`, the cron API is available in-process for
the lifetime of the gateway. No WebSocket round-trips after bootstrap.

### 2. Worker dispatch (event-driven → queue → cron one-shot)
Task dispatch follows a pipeline:

```
event → processEvents() → dispatch_queue → dispatchLoop() → dispatchViaCron()
                                                ↓
                                        cronService.add({
                                          schedule: "at:<now>",
                                          deleteAfterRun: true,
                                          sessionTarget: "isolated",
                                          payload: taggedPrompt
                                        })
```

- Events feed the dispatch queue (event-driven).
- The **sweep loop** (`setInterval`, default 60s) calls `processAndDispatch()`
  which drains the queue via `dispatchLoop()`.
- Each queue item is dispatched by creating a **one-shot cron job** that fires
  immediately (`schedule: "at:<now>"`, `deleteAfterRun: true`).
- The `[clawforce:dispatch=<queueItemId>:<taskId>]` tag in the payload links
  the spawned session back to the dispatch queue item.

### 3. Manager wake cycles (scheduled cron)
Manager agents are woken on a recurring schedule:

- `buildManagerCronJob()` constructs a cron job definition with a dynamic
  OODA-loop payload (project state hints, velocity, blockers, cost alerts).
- The job is synced to OpenClaw's native cron via agent-sync config.
- Schedule formats: interval (`5m`, `1h`), cron expression (`0 9 * * MON-FRI`),
  one-shot (`at:2025-12-31T23:59:00Z`).

### 4. Per-agent jobs (scheduled + continuous)
Individual agent jobs (triage, reporting, etc.) run on their own schedules:

- `buildJobCronJob()` constructs a cron job with a `[clawforce:job=<name>]` tag
  so the `before_prompt_build` hook can inject job-specific context.
- **Scheduled jobs**: real cron expressions with optional timezone.
- **Continuous jobs**: re-dispatched via `cronService.add()` at `agent_end`,
  creating a new one-shot cron job for the next iteration (isolated session).

### 5. Ops tool cron management
The ops tool exposes `list_jobs`, `create_job`, `update_job`, `delete_job`
actions for managers to programmatically manage agent job schedules at runtime.
Wake bounds enforcement (`clampCronToWakeBounds`) prevents schedules that
violate agent availability windows.

## What Was Removed (from original design)
- `capturedCronAdd`, `pendingCronJobs`, `cronRegistrar` wrapper — replaced by
  direct `setCronService()` capture
- File-based cron fallback (`jobs.json`, `flushPendingCronJobsViaFile()`)
- `registerManagerCron()`, `registerJobCrons()` — replaced by agent-sync config

## What Exists Today
- `setCronService()` / `getCronService()` — captures OpenClaw's cron API at
  bootstrap, used by all dispatch paths
- `dispatchViaCron()` — creates one-shot cron jobs for worker dispatch
- `dispatchViaInject()` — thin wrapper that delegates to `dispatchViaCron()`
  (name is historical; the inject path was replaced by cron dispatch)
- `parseSchedule()`, `buildManagerCronJob()`, `buildJobCronJob()`,
  `toCronJobCreate()` — schedule parsing and payload builders
- `CronServiceLike`, `CronJobRecord`, `CronJobState` — runtime cron management
  types used by ops tooling
- `cron` field on `JobDefinition` — encodes schedule intent
- `CronDelivery`, `CronFailureAlert` types — delivery and alerting config
- `callGatewayRpc()` — WebSocket RPC used once at bootstrap to capture cron

## Key Files
- `src/manager-cron.ts` — schedule parsing, cron job builders, cron service
  getter/setter
- `src/dispatch/cron-dispatch.ts` — one-shot cron job creation for worker
  dispatch
- `src/dispatch/inject-dispatch.ts` — gateway RPC + dispatch entry point
  (delegates to cron-dispatch)
- `src/dispatch/dispatcher.ts` — queue-based dispatch loop with concurrency,
  budget, safety, and risk gates
- `src/lifecycle.ts` — sweep timer that drives `processAndDispatch()`
- `adapters/openclaw.ts` — cron service capture at bootstrap, continuous job
  re-dispatch, agent-sync integration
