# Extract Experiments as OpenClaw Plugin

**Date:** 2026-04-04
**Status:** Approved

## Summary

Move all experiment-related code out of ClawForce core into a standalone OpenClaw plugin package (`@clawforce/plugin-experiments`). The plugin uses OpenClaw's existing plugin system for discovery, loading, and lifecycle. It accesses ClawForce primitives (`getDb`, `writeAuditEntry`, `recordMetric`) as a peer dependency.

## Plugin Package Structure

```
workplace/openclaw-plugins/clawforce-experiments/
├── package.json              # peerDep: clawforce, openclaw
├── openclaw.plugin.json      # Plugin manifest
├── tsconfig.json
├── src/
│   ├── index.ts              # register(api) entry point, table init
│   ├── lifecycle.ts          # create/start/pause/complete/kill/list
│   ├── assignment.ts         # variant assignment
│   ├── results.ts            # outcome recording
│   ├── config.ts             # variant config merge
│   ├── canary.ts             # canary health checks
│   ├── validation.ts         # experiment config validation
│   ├── schema.ts             # CREATE TABLE IF NOT EXISTS
│   ├── types.ts              # Experiment types (from clawforce/types.ts)
│   ├── tool.ts               # Experiment tool actions
│   └── dashboard.ts          # queryExperiments + route handler
```

## Plugin Contract

The plugin exports a `register(api)` function that:

1. Runs `CREATE TABLE IF NOT EXISTS` for `experiments`, `experiment_variants`, `experiment_sessions`
2. Registers experiment tool via `api.registerTool()` with 8 actions: `create_experiment`, `start_experiment`, `pause_experiment`, `complete_experiment`, `kill_experiment`, `apply_experiment`, `experiment_status`, `list_experiments`
3. Registers dashboard HTTP route via `api.registerHttpRoute()` for the experiments endpoint
4. Uses `clawforce` peer dependency for `getDb`, `writeAuditEntry`, `recordMetric`

## What Gets Removed from ClawForce Core

### Files deleted
- `src/experiments/lifecycle.ts`
- `src/experiments/assignment.ts`
- `src/experiments/results.ts`
- `src/experiments/config.ts`
- `src/experiments/canary.ts`
- `src/experiments/validation.ts`
- `src/sdk/experiments.ts`

### Code removed from existing files
- `src/index.ts` — all experiment exports (lines 262–269) and experiment types from type export block
- `src/types.ts` — `ExperimentState`, `ExperimentAssignmentStrategy`, `CompletionCriteria`, `VariantConfig`, `ExperimentOutcome`, `Experiment`, `ExperimentVariant`, `ExperimentSession` types
- `src/sdk/index.ts` — `ExperimentsNamespace` import, lazy getter, private field
- `src/tools/ops-tool.ts` — all 8 experiment action cases, experiment param definitions, experiment imports
- `src/dashboard/queries.ts` — `queryExperiments()` function
- `src/dashboard/routes.ts` — experiments case in switch
- `src/dashboard/gateway-routes.ts` — experiments case in switch, `queryExperiments` import, `hasExperiments` capability flag, `"experiments"` in default views
- `src/config-validator.ts` — `"clawforce_experiment"` from `KNOWN_TOOLS`
- `src/api/contract.ts` — `experiments: boolean` from capabilities type

### What stays (backward compat)
- Migration V36 in `src/migrations.ts` — tables already deployed, harmless
- `experiment_variant_id` column in session archive — nullable, no code references it after removal

## What Gets Added to ClawForce Core

- Export `recordMetric` from `src/index.ts` (from `./metrics.js`)
- Export `writeAuditEntry` from `src/index.ts` (from `./audit.js`)

## Test Migration

- `test/experiments/e2e-experiment.test.ts` → moves to plugin package
- `test/tools/ops-experiments.test.ts` → moves to plugin package
- Plugin tests import from `clawforce` and test against real SQLite DB
