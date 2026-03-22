# Cron Service Removal — Design Spec

## Problem
ClawForce dispatches agents via OpenClaw's cron API, but the cron service capture never works (needs operator scope). Falls back to writing JSON files which doesn't work for one-shot dispatches. Result: unreliable agent dispatch.

## Solution
Remove all cron service dependency. Three direct dispatch mechanisms:

1. **Employee dispatch** — `api.injectAgentMessage({ sessionKey: unique, message: prompt })`. Generates isolated session per dispatch.
2. **Manager recurring jobs** — configured in OpenClaw's native cron via agent sync. No programmatic registration.
3. **Continuous jobs** — `api.injectAgentMessage()` on session end + CLI for initial kick.

## What to Remove
- `capturedCronAdd`, `pendingCronJobs`, `cronRegistrar` wrapper in adapter
- `clawforce.init` gateway method cron capture
- File-based cron fallback (jobs.json writing)
- `flushPendingCronJobsViaFile()`
- `setCronService()`, `getCronService()` exports
- `registerManagerCron()`, `registerJobCrons()`
- `dispatchViaCron()`
- Cron management ops tool actions

## What to Keep
- `parseSchedule()`, `buildManagerCronJob()`, `buildJobCronJob()` — payload builders
- `cron` field on `JobDefinition` — encodes schedule intent
- `CronDelivery`, `CronFailureAlert` types

## New Dispatch
```
dispatchItem() → dispatchViaInject() → api.injectAgentMessage({
  sessionKey: "agent:${agentId}:dispatch:${queueItemId}",
  message: taggedPrompt
})
```

Session key pattern ensures isolated sessions. The `[clawforce:dispatch=...]` tag in the message links it to the dispatch queue.
