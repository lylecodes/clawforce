# ui-dogfood-2026-04-19 19:56 UTC onboarding-backlog-sweep

## Workflow wiring
```sh
src/setup/workflows.ts:4:export const STARTER_WORKFLOW_TYPES = ["data-source-onboarding"] as const;
src/setup/workflows.ts:59:    jobId: "onboarding-backlog-sweep",
src/setup/workflows.ts:76:  "data-source-onboarding": {
src/setup/workflows.ts:77:    id: "data-source-onboarding",
src/setup/workflows.ts:106:        id: "onboarding-backlog-sweep",
src/setup/workflows.ts:107:        jobId: "onboarding-backlog-sweep",
src/setup/workflows.ts:210:  if (workflow !== "data-source-onboarding") {
src/setup/workflows.ts:271:      "onboarding-backlog-sweep": {
src/setup/workflows.ts:428:              id: "proposed-onboarding-request",
src/setup/workflows.ts:446:    template: "data-source-onboarding",
/Users/lylejens/.clawforce/domains/ui-dogfood-2026-04-18.yaml:2:template: data-source-onboarding
/Users/lylejens/.clawforce/domains/ui-dogfood-2026-04-18.yaml:4:  - data-source-onboarding
/Users/lylejens/.clawforce/domains/ui-dogfood-2026-04-18.yaml:134:        - id: proposed-onboarding-request
```

## Setup status
- `./bin/cf setup status --json --domain=ui-dogfood-2026-04-18` still shows the `data-source-onboarding` workflow present and the current recurring run attached to task `bb7f7b51-b4d6-4abc-9861-1970020ade44`.
- Controller health is still degraded: `active_sessions=0`, `active_dispatches=1`, plus stranded recurring jobs for `memory_review`, `coordination`, and `intake-triage`, and a blocked `session_reset` task.

## Decision / backlog surfaces
- `./bin/cf decisions --json --domain=ui-dogfood-2026-04-18` returned `actionNeeded=0`, `watching=0`, `fyi=0`.
- Jurisdiction backlog query returned:

```text
jurisdiction_entities	proposed	bootstrapping
0
```

- Owner-gap / proposed / bootstrapping jurisdiction query returned `(no rows)`.
- `onboarding_state` only contains:

```text
key	value
last_digest_at	1776498008214
welcome_delivered	true
```

- Non-recurring onboarding-related open tasks still only show the existing infra investigation:

```text
id	title	state	assigned_to	kind	entity_id	updated_at
8a70f01e-6b37-4a0c-988c-64b29befe34e	Investigate recurring workflow dispatches that lose their active session in ui-dogfood-2026-04-18	OPEN		infra		1776557070558
```

## Runtime state
- `./bin/cf running --domain=ui-dogfood-2026-04-18` reports:
  - `Active Sessions: 0`
  - queue `dispatched=1`, `failed=249`, `cancelled=2`
  - recent transition: the prior onboarding-backlog-sweep run failed around `19:54 UTC`

## Outcome
- No governed onboarding work was opened or updated in this run.
- Explicit no-action reason: there are still no proposed jurisdictions, no bootstrapping jurisdictions, no stale onboarding requests in `onboarding_state`, and no missing jurisdiction owner coverage to convert into governed onboarding tasks.
- The only active follow-up remains infra task `8a70f01e-6b37-4a0c-988c-64b29befe34e`, which already covers the recurring dispatch/session-loss issue causing these sweeps to strand or fail.