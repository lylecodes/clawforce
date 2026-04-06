# Dashboard Subagent Prompts

Use these prompts when spawning Claude Code subagents or workers. Each prompt
assumes the product stance and parallel execution plan are already loaded.

## Shared Instructions For Every Worker

You are not alone in the codebase.

- Do not revert other in-flight work.
- Stay inside the owned file set unless blocked.
- If you must cross the ownership boundary, do the minimum and call it out.
- Keep the OpenClaw boundary intact.
- Do not reopen locked product decisions.
- Run the relevant tests for your slice.

Read first:

1. `docs/DASHBOARD_PRODUCT_STANCE.md`
2. `docs/plans/2026-04-05-dashboard-parallel-execution-plan.md`
3. `docs/plans/2026-04-05-dashboard-acceptance-matrix.md`
4. `docs/plans/2026-04-05-openclaw-boundary-matrix.md`

## Pack 1: Framework Config Contract

You own:

- `src/api/contract.ts`
- `src/dashboard/queries.ts`
- `src/dashboard/actions.ts`
- `test/dashboard/queries*.test.ts`
- `test/dashboard/actions.test.ts`

Do not own:

- `clawforce-dashboard/src/views/ConfigEditor.tsx`

Task:

Finish the remaining framework-side config contract work for dashboard maturity.
Tighten section shapes, remove guessy/simplified semantics where possible, and
make save/validate/query behavior explicit enough that the SPA can trust it.

Deliver:

- tighter config contract
- better query/save fidelity for remaining rich sections
- updated backend tests

## Pack 2: SPA Config Fidelity

You own:

- `clawforce-dashboard/src/views/ConfigEditor.tsx`
- `clawforce-dashboard/src/hooks/useConfig.ts`
- `clawforce-dashboard/src/api/types.ts`
- `clawforce-dashboard/src/views/ConfigEditor.test.tsx`
- small supporting editor components as needed

Do not own:

- framework contract files unless blocked

Task:

Finish the deepest remaining config-fidelity work in the dashboard SPA. Remove
lossy UI projections, preserve rich meanings on save, and keep structured and
raw editing aligned with backend validation.

Deliver:

- richer editors or better-preserved raw/structured sync
- no silent data loss for remaining rich shapes
- focused regression tests

## Pack 3: Runtime / Auth / Deployment

You own:

- `adapters/openclaw.ts`
- `src/dashboard/auth.ts`
- `src/dashboard/server.ts`
- `src/dashboard/gateway-routes.ts`
- `test/dashboard/auth.test.ts`
- `test/dashboard/server.test.ts`
- `test/dashboard/gateway-routes.test.ts`
- deployment/runtime docs

Task:

Harden embedded-vs-standalone runtime behavior and auth/deployment semantics
without duplicating OpenClaw ownership. Clarify runtime metadata, auth/CORS
behavior, compatibility mode, and deployment docs/tests.

Deliver:

- cleaner runtime/auth behavior
- stronger tests
- docs that explain embedded vs standalone clearly

## Pack 4: Shell / IA Cleanup

You own:

- `clawforce-dashboard/src/App.tsx`
- `clawforce-dashboard/src/components/Layout.tsx`
- `clawforce-dashboard/src/components/NavBar.tsx`
- `clawforce-dashboard/src/components/DomainLayout.tsx`
- `clawforce-dashboard/src/components/DomainSwitcher.tsx`
- `clawforce-dashboard/src/views/Monitor.tsx`
- `clawforce-dashboard/src/views/Workspace.tsx`
- `clawforce-dashboard/src/views/Overview.tsx`
- `clawforce-dashboard/src/views/OperationsCenter.tsx`
- shell/router tests

Task:

Finish the dashboard shell so it feels like one operator product. Remove stale
competing shell patterns, make navigation roles intentional, and leave the app
with a single clear operator-home model.

Also read:

- `docs/plans/2026-04-05-dashboard-shell-ia-spec.md`

Deliver:

- final shell cleanup
- removal or neutralization of dormant shell drift
- updated shell tests

## Pack 5: Verification / E2E Operator Flows

You own:

- `clawforce-dashboard/src/test/`
- new route/integration/e2e tests
- test scripts/config if needed

Task:

Raise dashboard verification from broad component coverage to real operator-flow
confidence. Focus on the critical paths a real operator would use.

Priority flows:

- create business -> land in config
- switch business -> operate from shell
- config edit -> validate -> save
- budget edit/allocation
- approvals
- task intervention
- direct comms
- emergency controls
- context editing

Deliver:

- e2e or route-integration coverage for critical flows
- any needed test helpers

## Pack 6: Locks And Overrides

You own:

- framework lock storage/enforcement files you introduce or modify
- dashboard UI surfaces showing or editing lock state
- related tests/docs

Task:

Implement the product stance for human locks and override precedence. Make lock
state explicit, persistent, and audited.

Also read:

- `docs/plans/2026-04-05-lock-override-spec.md`

Deliver:

- lock model
- UI indicators/controls
- tests and docs

## Pack 7: Action Status And Recovery

You own:

- `src/dashboard/actions.ts`
- `src/dashboard/gateway-routes.ts`
- `src/dashboard/sse.ts`
- relevant dashboard action hooks/components
- related tests

Task:

Make async/accepted actions visible and trustworthy. Add accepted/queued/
completed/failed semantics where needed and surface them honestly in the UI.

Also read:

- `docs/plans/2026-04-05-dashboard-action-status-spec.md`

Deliver:

- action-status model
- UI feedback for risky actions
- tests around retries/failures/race conditions

## Pack 8: Extension Proving Path

You own:

- extension slot/contract files in core if needed
- proving-extension integration points
- extension docs

Task:

Prove the extension platform with one real non-core extension. Do not implement
plugin loading in ClawForce. Keep OpenClaw as loader/lifecycle owner.

Also read:

- `docs/plans/2026-04-05-extension-proving-spec.md`

Deliver:

- one proving extension path
- any missing slot/contract additions
- docs updates

## Pack 9: Docs And Release Gate

You own:

- `README.md`
- roadmap/guide docs
- deployment/operator/builder docs

Task:

Keep docs aligned to implementation reality and prepare the release gate.

Also read:

- `docs/plans/2026-04-05-dashboard-release-gate.md`

Deliver:

- operator guide
- builder/extension guide
- deployment/troubleshooting updates
- release checklist
