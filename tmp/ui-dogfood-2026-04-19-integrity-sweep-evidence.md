# ui-dogfood-2026-04-18 integrity-sweep evidence

Run time: 2026-04-19 20:31 UTC
Task: `1bab2e90-b35b-4d50-b4ce-cfe4edf419d6`
Domain: `ui-dogfood-2026-04-18`

## What I checked

### Workflow presence and scope
- Confirmed `integrity-sweep` is declared in `src/setup/workflows.ts` for the `data-source-onboarding` template.
- Confirmed domain file `/Users/lylejens/.clawforce/domains/ui-dogfood-2026-04-18.yaml` includes `data-source-onboarding`.

### Domain runtime state
Command: `./bin/cf setup status --json --domain=ui-dogfood-2026-04-18`

Relevant findings:
- Domain valid and enabled.
- `integrity-sweep` recurring job is present and currently dispatched as task `1bab2e90-b35b-4d50-b4ce-cfe4edf419d6`.
- Controller warning: active worker activity exists under a shared or lease-less controller path.
- Additional warnings show orphaned recurring runs for `memory_review`, `coordination`, `intake-triage`, plus blocked `session_reset`.

### Live integrity data
Command:
```sql
SELECT 'entities' AS metric, COUNT(*) AS count FROM entities WHERE project_id='ui-dogfood-2026-04-18'
UNION ALL
SELECT 'open_issues', COUNT(*) FROM entity_issues WHERE project_id='ui-dogfood-2026-04-18' AND lower(coalesce(status,'')) IN ('open','active','blocked')
UNION ALL
SELECT 'check_runs', COUNT(*) FROM entity_check_runs WHERE project_id='ui-dogfood-2026-04-18'
UNION ALL
SELECT 'blocked_or_flagged_checks', COUNT(*) FROM entity_check_runs WHERE project_id='ui-dogfood-2026-04-18' AND lower(coalesce(status,'')) IN ('blocked','flagged','fail','failed','warning')
UNION ALL
SELECT 'manager_reviews', COUNT(*) FROM manager_reviews WHERE project_id='ui-dogfood-2026-04-18';
```

Result:
- entities: 0
- open_issues: 0
- check_runs: 0
- blocked_or_flagged_checks: 0
- manager_reviews: 0

Follow-up inspection queries returned no rows for:
- recent blocked/flagged `entity_check_runs`
- open/active/blocked `entity_issues`
- recent `manager_reviews`

## Verdict for this run
- There are **no blocked or flagged integrity verdicts to remediate** in this domain right now.
- There are **no contradictory field verdicts to escalate** because there are no entities, no check runs, and no manager reviews yet.
- Therefore **no remediation work was created** for data integrity itself.

## Related reliability risk observed
This run did surface a separate workflow reliability issue, not a live integrity-data issue.

Commands reviewed:
- `./bin/cf running --domain=ui-dogfood-2026-04-18`
- `./bin/cf feed --domain=ui-dogfood-2026-04-18 --json`
- `./bin/cf review 8a70f01e-6b37-4a0c-988c-64b29befe34e --domain=ui-dogfood-2026-04-18 --json`
- `./bin/cf errors --hours=24 --domain=ui-dogfood-2026-04-18 | grep -E 'Recovered missed dispatch cron job|no active session|dispatch' | head -n 20`

Relevant findings:
- `cf running` showed `Active Sessions: 0`, queue `dispatched 2`, `failed 254`, `cancelled 2`.
- `cf feed` contains many recent failures for `integrity-sweep`, `onboarding-backlog-sweep`, and `production-watch`.
- Existing task `8a70f01e-6b37-4a0c-988c-64b29befe34e` already documents the dispatcher problem as a P1 release-risk issue.
- Error logs repeatedly show: `Recovered missed dispatch cron job after ... no active session; exhausted dispatch retries` and `Stale dispatched item: no active session after ...`.

## Why no additional follow-up was created here
- The task specifically asked for blocked/flagged integrity verdict review, remediation, and contradiction escalation.
- There were no live integrity verdicts or contradictions to act on.
- The separate dispatch reliability problem is already captured in existing task `8a70f01e-6b37-4a0c-988c-64b29befe34e`, so duplicating follow-up work from this sweep would add noise instead of clarity.
