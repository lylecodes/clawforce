# ui-dogfood-2026-04-19 20:31 UTC onboarding-backlog-sweep

## Checks executed
- `./bin/cf setup status --json --domain=ui-dogfood-2026-04-18`
- `./bin/cf running --domain=ui-dogfood-2026-04-18`
- `./bin/cf feed --json --domain=ui-dogfood-2026-04-18`
- `./bin/cf decisions --json --domain=ui-dogfood-2026-04-18`
- `./bin/cf query --domain=ui-dogfood-2026-04-18 "SELECT state, COUNT(*) AS count FROM entities WHERE kind='jurisdiction' GROUP BY state ORDER BY state;"`
- `./bin/cf query --domain=ui-dogfood-2026-04-18 "SELECT id, title, state, owner_agent_id FROM entities WHERE kind='jurisdiction' AND (state IN ('PROPOSED','BOOTSTRAPPING') OR owner_agent_id IS NULL) ORDER BY updated_at DESC LIMIT 50;"`
- `./bin/cf query --domain=ui-dogfood-2026-04-18 "SELECT key, value FROM onboarding_state ORDER BY key;"`
- `./bin/cf query --domain=ui-dogfood-2026-04-18 "SELECT id, title, state, priority FROM tasks WHERE state IN ('TODO','IN_PROGRESS','BLOCKED','ASSIGNED','WAITING') AND (title LIKE '%onboarding%' OR description LIKE '%onboarding%' OR description LIKE '%bootstrapping%' OR description LIKE '%owner coverage%') ORDER BY updated_at DESC LIMIT 50;"`
- `./bin/cf query --domain=ui-dogfood-2026-04-18 "SELECT COUNT(*) AS recurring_failures FROM tasks WHERE project_id='ui-dogfood-2026-04-18' AND title LIKE 'Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep%' AND state='FAILED';"`
- `./bin/cf errors --hours=24 --domain=ui-dogfood-2026-04-18 | head -n 30`

## Evidence
- `setup status` still validates the `data-source-onboarding` workflow and shows `onboarding-backlog-sweep` configured on the source onboarding steward.
- This specific recurring job is no longer active in setup state at inspection time: `lastStatus=completed`, `activeTaskId=null`, `nextRunAt=1776630900000`.
- The domain controller remains lease-less: `state=none`, `activeSessionCount=0`, `activeDispatchCount=1`, with setup warnings for orphaned `memory_review`, `coordination`, and `intake-triage`, plus blocked `session_reset`.
- `cf running` still shows queue churn instead of onboarding backlog: `dispatched=1`, `failed=255`, `cancelled=2`, and a fresh `ASSIGNED -> FAILED` transition at `2026-04-19 20:32:18`.
- `cf feed --json` is still dominated by recurring failure noise, including repeated failed `onboarding-backlog-sweep` task alerts, not jurisdiction-level onboarding work.
- `cf decisions --json` still reports no actionable decision items: `actionNeeded=0`, `watching=0`, `fyi=0`.
- Jurisdiction inventory remains empty. Both the state-count query and the proposed/bootstrapping-or-owner-gap query returned no rows.
- `onboarding_state` still only contains `last_digest_at` and `welcome_delivered`, with no stale onboarding-request markers to advance.
- No open governed onboarding task exists beyond recurring run noise. The onboarding task query returned no rows.
- Failed recurring history for this exact sweep increased again to `75` failed tasks.
- `cf errors --hours=24` continues to show the same dispatch/session-loss pattern: repeated `Recovered missed dispatch cron job after 119s/120s with no active session; exhausted dispatch retries`, plus stale dispatched items.

## Outcome
- No governed onboarding work was opened or updated this run.
- Explicit no-action reason: there are still no proposed jurisdictions, no bootstrapping jurisdictions, no pending onboarding request state, and no missing owner coverage to convert into governed onboarding work.
- The only active issue visible from this sweep remains recurring orchestration instability rather than onboarding backlog content.
