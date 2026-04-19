# ui-dogfood-2026-04-19 20:47 UTC onboarding-backlog-sweep

## Checks executed
- `grep -nE 'onboarding-backlog-sweep|proposed-onboarding-request|data-source-onboarding' src/setup/workflows.ts /Users/lylejens/.clawforce/domains/ui-dogfood-2026-04-18.yaml`
- `./bin/cf setup status --json --domain=ui-dogfood-2026-04-18`
- `./bin/cf running --domain=ui-dogfood-2026-04-18`
- `./bin/cf feed --json --domain=ui-dogfood-2026-04-18`
- `./bin/cf decisions --json --domain=ui-dogfood-2026-04-18`
- `./bin/cf query --domain=ui-dogfood-2026-04-18 "SELECT state, COUNT(*) AS count FROM entities WHERE kind='jurisdiction' GROUP BY state ORDER BY state;"`
- `./bin/cf query --domain=ui-dogfood-2026-04-18 "SELECT id, title, state, owner_agent_id FROM entities WHERE kind='jurisdiction' AND (state IN ('PROPOSED','BOOTSTRAPPING','proposed','bootstrapping') OR owner_agent_id IS NULL) ORDER BY updated_at DESC LIMIT 50;"`
- `./bin/cf query --domain=ui-dogfood-2026-04-18 "SELECT key, value FROM onboarding_state ORDER BY key;"`
- `./bin/cf query --domain=ui-dogfood-2026-04-18 "SELECT id, title, state, priority FROM tasks WHERE state IN ('TODO','IN_PROGRESS','BLOCKED','ASSIGNED','WAITING') AND title NOT LIKE 'Run recurring workflow %' AND (title LIKE '%onboarding%' OR description LIKE '%onboarding%' OR description LIKE '%bootstrapping%' OR description LIKE '%owner coverage%') ORDER BY updated_at DESC LIMIT 50;"`
- `./bin/cf query --domain=ui-dogfood-2026-04-18 "SELECT COUNT(*) AS recurring_failures FROM tasks WHERE project_id='ui-dogfood-2026-04-18' AND title LIKE 'Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep%' AND state='FAILED';"`
- `./bin/cf errors --hours=24 --domain=ui-dogfood-2026-04-18 | head -n 30`

## Evidence
- Workflow wiring is still present in code and domain config. `src/setup/workflows.ts` still defines `data-source-onboarding`, `onboarding-backlog-sweep`, and `proposed-onboarding-request`, and the domain yaml still points at the `data-source-onboarding` template.
- `setup status --json` shows this sweep currently active as task `3316fee8-56fd-4fa2-825f-8b481f84762e`, with `lastStatus=scheduled`, `activeQueueStatus=dispatched`, and the domain controller still lease-less (`activeSessionCount=0`, `activeDispatchCount=1`).
- `cf running` still shows queue churn instead of onboarding progress: `dispatched=1`, `failed=257`, `cancelled=2`.
- `cf feed --json` remains recurring-failure noise, not backlog work: `actionNeeded=0`, `watching=122`, `fyi=0`.
- `cf decisions --json` returned no decision items: `actionNeeded=0`, `watching=0`, `fyi=0`.
- Jurisdiction inventory is still empty. The grouped jurisdiction query returned `(no rows)`.
- The proposed/bootstrapping-or-missing-owner query also returned `(no rows)`, so there are still no jurisdictions needing owner coverage.
- `onboarding_state` still only contains `last_digest_at` and `welcome_delivered`, with no stale onboarding-request markers to advance.
- The targeted non-recurring onboarding task query returned `(no rows)`, so there is no governed onboarding task to update from this sweep.
- Failed recurring history for this exact sweep increased again to `76` failed tasks.
- `cf errors --hours=24` shows the current failure mode is orchestration, not onboarding content: repeated `Recovered missed dispatch cron job after 119s/120s with no active session; exhausted dispatch retries`, plus a fresh `rate limit reached (15/15 per hour)` event at `20:36 UTC`.

## Outcome
- No governed onboarding work was opened or updated this run.
- Explicit no-action reason: there are still no proposed jurisdictions, no bootstrapping jurisdictions, no stale onboarding request state, and no missing owner coverage to convert into governed onboarding work.
- The only live issue surfaced by this sweep remains recurring orchestration instability rather than source-onboarding backlog content.
