# ui-dogfood-2026-04-18 onboarding-backlog-sweep

- Run time: 2026-04-19 17:52 UTC
- Domain: `ui-dogfood-2026-04-18`
- Workflow: `ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep`

## Checks performed

1. Revalidated workflow wiring:
   - `src/setup/workflows.ts` still defines `data-source-onboarding`, `proposed-onboarding-request`, and recurring `onboarding-backlog-sweep`.
   - `~/.clawforce/domains/ui-dogfood-2026-04-18.yaml` still declares the `data-source-onboarding` template/workflow.
2. Checked live domain health:
   - `cf setup status --json --domain=ui-dogfood-2026-04-18`
   - `cf running --domain=ui-dogfood-2026-04-18`
   - `cf feed --json --domain=ui-dogfood-2026-04-18`
   - `cf decisions --json --domain=ui-dogfood-2026-04-18`
   - `cf errors --hours=24 --domain=ui-dogfood-2026-04-18`
3. Queried governed onboarding scope:
   - jurisdiction entity counts by state
   - candidate jurisdictions with `state in ('proposed','bootstrapping')` or missing `owner_agent_id`
   - non-recurring onboarding-related open tasks
   - onboarding state rows
   - recurring failure count for this exact workflow

## Results

- No governed jurisdiction entities currently exist in this domain.
  - Query result: `jurisdiction_entities=0`, `proposed=0`, `bootstrapping=0`
- No jurisdiction rows were found needing owner coverage or onboarding follow-up.
- No onboarding queue/state backlog exists beyond:
  - `last_digest_at`
  - `welcome_delivered=true`
- The only relevant open non-recurring governed task is already the infra investigation:
  - `8a70f01e-6b37-4a0c-988c-64b29befe34e` - "Investigate recurring workflow dispatches that lose their active session in ui-dogfood-2026-04-18"
- This workflow has accumulated repeated execution failures instead of business backlog:
  - `68` failed `onboarding-backlog-sweep` task records
  - current running state shows `0` active sessions, `1` dispatched item, and a large failed queue tail
  - recent errors continue to show `Recovered missed dispatch cron job ... no active session ... exhausted dispatch retries`

## Follow-up decision

No new governed onboarding task was opened or updated in this run.

Reason: there is currently no proposed/bootstrapping jurisdiction backlog and no missing owner coverage to govern. The actionable problem is dispatch/session-loss infrastructure instability, which is already captured by existing task `8a70f01e-6b37-4a0c-988c-64b29befe34e`. Opening duplicate governed onboarding work here would be noise.
