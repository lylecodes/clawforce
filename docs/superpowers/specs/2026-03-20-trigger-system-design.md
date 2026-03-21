# External Trigger System — Design Spec

## Overview

Pluggable ingestion layer that accepts events from external sources (webhooks, CLI, SDK calls, file drops, script exit codes), maps them to ClawForce events using config-driven trigger definitions, and routes them through the existing dispatch pipeline. Reuses existing event store, router, and dispatch queue — no new event processing path.

## Flow

```
External Source → Trigger Ingestion Layer → ingestEvent() → processEvents() → dispatch queue → agent
```

## Trigger Config Schema (YAML)

```yaml
triggers:
  pipeline-failure:
    source: script_exit
    condition:
      exit_code: "!= 0"
    agent: qs-ops
    severity: high
    task_template: "Pipeline failed: {{payload.script_name}} exit code {{payload.exit_code}}"
    cooldown_ms: 300000
    dedup_key: "pipeline-failure:{{payload.script_name}}"

  cloudwatch-alarm:
    source: webhook
    path: /triggers/cloudwatch
    auth:
      type: shared_secret
      secret_env: CW_WEBHOOK_SECRET
    condition:
      NewStateValue: "== ALARM"
    agent: qs-ops
    severity: critical
    task_template: "CloudWatch alarm: {{payload.AlarmName}}"
```

## Ingestion Adapters

1. **Core processor** (`src/triggers/processor.ts`) — `fireTrigger()` evaluates conditions, renders templates, creates tasks, ingests events
2. **Webhook** (`src/triggers/webhook.ts`) — `http.createServer`, zero deps, localhost by default, per-trigger auth
3. **CLI** (`src/bin/trigger.ts`) — `npx clawforce trigger -d quantscape -n pipeline-failure --set exit_code=1`
4. **SDK** (`src/sdk/triggers.ts`) — `cf.triggers.fire("pipeline-failure", payload)`
5. **File drop** (`src/triggers/file-watcher.ts`) — `fs.watch` on trigger directories
6. **Script exit** — convention: shell wrapper calls CLI on non-zero exit

## Key Design Decisions

- No new database tables — reuses events, tasks, dispatch_queue
- Event type convention: `"trigger:<name>"`
- Conditions: simple dotted-path comparisons, AND logic only
- Cooldown via events table query
- Webhook server is optional — CLI/SDK/file drop work without a server
- Reuses existing `interpolate()` template engine from `src/events/template.ts`

## Implementation Phases

1. Core types + config parsing
2. Processor + conditions engine
3. SDK namespace (cf.triggers)
4. CLI entry point
5. Webhook server + auth
6. File watcher
