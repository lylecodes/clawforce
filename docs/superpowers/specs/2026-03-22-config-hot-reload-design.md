# Config Hot-Reload — Design Spec

## Problem

Any change to ClawForce configuration — adding an agent, updating domain settings, changing continuous job definitions — requires a full gateway restart. This disrupts active agent sessions, loses in-flight work, and creates unnecessary downtime. The config watcher infrastructure already exists (`src/config/watcher.ts`) but is not wired into the adapter.

## Solution

Wire the existing `startConfigWatcher`/`stopConfigWatcher` from `src/config/watcher.ts` into the OpenClaw adapter. On config file changes, re-run `initializeAllDomains` to pick up changes in-place without restarting the gateway.

## Implementation

### 1. Register Config Watcher in Adapter

In the `gateway_start` hook (or as a registered service) in `adapters/openclaw.ts`, call `startConfigWatcher(baseDir, callback)` where the callback triggers a controlled re-initialization.

```typescript
// In adapters/openclaw.ts
startConfigWatcher(baseDir, async (changedFiles) => {
  log.info(`Config change detected: ${changedFiles.join(', ')}`);
  await reloadConfig(baseDir);
});
```

### 2. Config Reload Handler

The reload callback should:

1. Re-run `initializeAllDomains()` from `src/config/init.ts` to pick up:
   - New agents added to config
   - Updated domain configurations
   - Changed agent settings (presets, expectations, performance policies)
2. Sync agent changes to OpenClaw
3. Log a summary of what changed

### 3. Agent Sync Rules

When config reload detects agent changes:

- **New agents added**: Sync them to OpenClaw so they appear as available participants
- **Agents removed**: Do NOT kill active sessions. Mark the agent as "removed" so no new work is assigned, but let current sessions complete gracefully
- **Agent settings changed**: Apply new settings. Active sessions continue with old settings until their next task pickup

### 4. Continuous Job Changes

When a continuous job definition changes (nudge text, schedule, config):

- The change takes effect on the next re-dispatch cycle
- Currently running continuous jobs are not interrupted
- The next sweep tick picks up the new job definition naturally

### 5. What NOT to Do

- Do NOT restart the gateway — the entire point is in-place re-initialization
- Do NOT kill active agent sessions — they complete their current work
- Do NOT re-validate already-running tasks — only new task assignments use new config

### 6. Logging

On successful reload, log:
```
"Config reloaded: X agents synced, Y domains updated"
```

Include warnings for:
- Agents removed while sessions are active
- Config validation issues in the new config (reload anyway, but warn)

## Watched Files

The watcher should monitor:
- `config.yaml` — global ClawForce config
- `domains/**/*.yaml` — domain-level configs
- `domains/**/*.md` — domain context files (CLAWFORCE.md, etc.)

Changes to non-config files (source code, etc.) should be ignored.

## Critical Files

- `adapters/openclaw.ts` — register the config watcher service in gateway_start hook, handle teardown in gateway_stop
- `src/config/watcher.ts` — existing `startConfigWatcher` / `stopConfigWatcher` (already implemented)
- `src/config/init.ts` — `initializeAllDomains()` called on reload to re-initialize state

## Acceptance Criteria

- Changing `config.yaml` or a domain YAML file triggers automatic re-initialization without gateway restart
- New agents are synced to OpenClaw on reload
- Removed agents do not kill active sessions
- Continuous job definition changes take effect on next re-dispatch
- A summary log line is emitted showing agents synced and domains updated
- Config watcher is properly stopped on gateway shutdown (no leaked file watchers)
