# Dashboard Acceptance Matrix

Use this as the finish-line checklist for each implementation pack.

## Pack 1: Framework Config Contract

Done when:

- remaining rich config sections have explicit contract shapes
- query/save/validate semantics are clearer and less guessy
- SPA-facing contract types are no longer obviously under-modeled

Required verification:

- focused framework dashboard tests for changed sections
- any contract tests added for new shapes

Blocked by:

- none

Primary files:

- `src/api/contract.ts`
- `src/dashboard/queries.ts`
- `src/dashboard/actions.ts`

Avoid touching:

- `clawforce-dashboard/src/views/ConfigEditor.tsx`

## Pack 2: SPA Config Fidelity

Done when:

- structured editing no longer silently discards meaning on remaining rich shapes
- raw and structured views stay aligned
- backend validation remains the source of truth

Required verification:

- `clawforce-dashboard` config-editor tests
- `npm test`
- `npm run build`

Blocked by:

- any major contract changes from Pack 1

Primary files:

- `clawforce-dashboard/src/views/ConfigEditor.tsx`
- `clawforce-dashboard/src/hooks/useConfig.ts`
- `clawforce-dashboard/src/api/types.ts`

Avoid touching:

- framework contract files unless blocked

## Pack 3: Runtime / Auth / Deployment

Done when:

- embedded vs standalone behavior is explicit and tested
- auth/CORS/security-header behavior is coherent
- docs explain the runtime boundary clearly

Required verification:

- framework auth/server/gateway tests
- framework build

Blocked by:

- none

Primary files:

- `adapters/openclaw.ts`
- `src/dashboard/auth.ts`
- `src/dashboard/server.ts`
- `src/dashboard/gateway-routes.ts`

Avoid touching:

- SPA shell/config files

## Pack 4: Shell / IA Cleanup

Reference:

- `docs/plans/2026-04-05-dashboard-shell-ia-spec.md`

Done when:

- the dashboard shell has one intentional operator-home model
- dormant competing shell patterns are removed or clearly deprecated
- navigation order and page roles feel coherent

Required verification:

- shell/router SPA tests
- `npm test`
- `npm run build`

Blocked by:

- none, though Pack 5 benefits from the result

Primary files:

- `clawforce-dashboard/src/App.tsx`
- `clawforce-dashboard/src/components/Layout.tsx`
- `clawforce-dashboard/src/components/NavBar.tsx`
- `clawforce-dashboard/src/components/DomainLayout.tsx`

Avoid touching:

- framework runtime/auth files

## Pack 5: Verification / E2E Operator Flows

Done when:

- the critical operator paths are covered automatically
- the suite proves real cross-view workflows instead of only isolated components

Required verification:

- new e2e/integration suite itself
- `npm test`
- `npm run build`

Blocked by:

- stable enough UI flows from Packs 2 and 4

Primary files:

- `clawforce-dashboard/src/test/`
- new route/e2e tests

Avoid touching:

- product code unless a real testability fix is required

## Pack 6: Locks And Overrides

Reference:

- `docs/plans/2026-04-05-lock-override-spec.md`

Done when:

- lockable surfaces exist
- lock state is persistent and visible
- override precedence is explicit
- audit trail exists for lock/unlock and override actions

Required verification:

- framework tests for lock semantics
- SPA tests for lock UI
- builds for touched repos

Blocked by:

- stable config/action contracts

Primary files:

- lock-related framework runtime/config files
- related dashboard UI surfaces

Avoid touching:

- unrelated shell files unless lock UI lives there

## Pack 7: Action Status And Recovery

Reference:

- `docs/plans/2026-04-05-dashboard-action-status-spec.md`

Done when:

- risky async actions expose accepted/queued/completed/failed states
- UI no longer pretends risky actions completed synchronously when they did not
- retry/failure/degraded paths are visible

Required verification:

- framework action/SSE tests
- SPA action-flow tests
- builds for touched repos

Blocked by:

- none, but runtime hardening from Pack 3 helps

Primary files:

- `src/dashboard/actions.ts`
- `src/dashboard/gateway-routes.ts`
- `src/dashboard/sse.ts`

Avoid touching:

- unrelated config-editor files

## Pack 8: Extension Proving Path

Reference:

- `docs/plans/2026-04-05-extension-proving-spec.md`

Done when:

- one real non-core extension proves the platform
- missing core slots/contracts needed by that extension are implemented
- OpenClaw remains the loader/lifecycle owner

Required verification:

- extension registration/rendering tests
- docs updates
- builds for touched repos

Blocked by:

- stable enough extension slots and shell

Primary files:

- extension contract/slot files in core
- proving-extension integration points

Avoid touching:

- OpenClaw ownership boundaries

## Pack 9: Docs And Release Gate

Reference:

- `docs/plans/2026-04-05-dashboard-release-gate.md`

Done when:

- docs match implemented behavior
- operator/builder/deployment guides exist
- release checklist is explicit

Required verification:

- documentation review against actual implementation

Blocked by:

- final implementation details from the other packs

Primary files:

- `README.md`
- roadmap docs
- operator/builder/deployment docs

Avoid touching:

- product code unless the docs expose a real mismatch that must be fixed
