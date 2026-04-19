---
name: rentright-production-sentinel
description: Use for post-release and live-state monitoring of RentRight jurisdiction data. Watches for stale rates, production drift, verification gaps, and user-visible anomalies, then opens governed remediation tasks. Triggers on "check production drift", "watch the pipeline", "monitor live jurisdictions", "production sentinel".
---

# RentRight Production Sentinel

Use this skill to monitor live RentRight jurisdictions after release and catch problems before they become silent compliance failures.

Read these first:
- `../../rentright/docs/architecture/DATA_INTEGRITY_GATE.md`
- `../../rentright/docs/architecture/DATA_VALIDATION_FLOW.md`
- `../../rentright/docs/architecture/TEMPORAL_DATA.md`
- `../../rentright/docs/architecture/JURISDICTION_COMPLETENESS.md`

## Goal

Detect live data drift and open the right governed remediation path before customer-facing damage spreads.

## Watch Categories

- expiring or expired rates
- stale verification windows
- extraction failures
- integrity verdict regressions
- parent/child propagation misses
- bundle/result mismatches
- unexpected completeness drops

## Process

1. Check live jurisdiction health.
   For each active jurisdiction, review:
   - lifecycle state
   - latest verification age
   - current active rate coverage
   - recent integrity verdict changes

2. Check recent release surface.
   Identify jurisdictions changed since the last run and confirm post-release verification completed.

3. Classify incidents.
   Route each issue into one of:
   - `temporal_rate_refresh`
   - `integrity_block`
   - `source_fix`
   - `bundle_regression`
   - `production_drift`

4. Open remediation tasks.
   Route to:
   - jurisdiction owner
   - `cpi-temporal-steward`
   - `integrity-gatekeeper`
   - `bundle-verifier`
   as appropriate

5. Degrade status when necessary.
   Recommend `degraded` if:
   - a rate-determining field is stale or expired
   - bundle verification has regressed
   - integrity blocks remain unresolved

6. Record watch notes.
   Update the jurisdiction release log or ops notes with only high-signal production findings.

## Output

Produce:
- active incident list
- impacted jurisdictions
- routed remediation tasks
- recommended lifecycle state changes

## Rules

- Production watch is not just uptime.
- A jurisdiction with stale rates but no crash is still unhealthy.
- If parent data drift is suspected, force child verification tasks.
