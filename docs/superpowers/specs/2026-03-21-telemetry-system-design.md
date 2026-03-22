# Telemetry & Experimentation System — Design Spec

## Overview

Full observability layer for ClawForce. Every session is fully reproducible, comparable, and analyzable. Enables data-driven optimization of agent teams — both for ClawForce product development and customer agent setups.

## 6 Subsystems

### 1. Session Archives (V31)
Complete session reconstruction: compressed transcript, context hash, agent config snapshot, outcome, cost, dispatch context. ~25KB per session.

### 2. Tool Call Details (V32)
Per-call records with full I/O (truncated at 10KB), sequence order, duration, cost estimate. Buffered in-memory during session, batch-inserted at agent_end. Zero per-call write overhead.

### 3. Config Version Tracking (V33)
Content-addressable storage for context files. SHA-256 hash computed at assembleContext() time, detects changes automatically. Every session linked to the exact config that produced it.

### 4. Manager Review Records (V34)
Structured review data: verdict, reasoning, criteria checked, follow-up task ID. Replaces unstructured evidence-only approach.

### 5. Trust Score History (V35)
Time-series snapshots triggered by every trust decision, override, or decay. Enables trend analysis.

### 6. Experiment Framework (V36)
Named experiments with variant assignment, aggregate stats, statistical comparison. Supports A/B tests, canary deployments, model comparisons.

## Experiment Runtime

### Variant Configs
Patch/merge over base config — only override specified fields. Can vary: persona, briefing sources, expectations, model, context file content.

### Assignment Strategies
- random (default, 50/50)
- weighted (for canary: 90/10)
- round_robin
- per_agent
- manual

### Lifecycle
draft → running → paused/completed/cancelled

### Canary Deployments
Experiment with weighted assignment + rollback criteria. Auto-rollback if error rate exceeds threshold. Auto-promote if stable after N sessions.

### Safety
- Kill switch per experiment
- Error rate circuit breaker per variant (>50% errors after 5 sessions → variant disabled)
- Max 2 concurrent experiments per domain
- Variant config validation (can't disable safety features)
- Conflict detection (no overlapping experiments on same agent)

### Manager Tool Interface
8 new actions on clawforce_ops: create_experiment, start_experiment, pause_experiment, complete_experiment, kill_experiment, apply_experiment, experiment_status, list_experiments

## SDK
New `cf.telemetry` namespace: sessionDetail(), compareSessions(), agentPerformance(), experimentResults(), configHistory(), trustTimeline()

## Performance
- Zero per-tool-call write overhead (buffer + batch insert)
- Transcript compression: 200KB → 20KB via zlib
- Config hash: <1ms via SHA-256
- ~45KB total storage per session
