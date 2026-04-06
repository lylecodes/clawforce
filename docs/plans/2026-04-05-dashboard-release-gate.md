# Dashboard Release Gate

> Last updated: 2026-04-05

## Goal

Define the single release bar for calling the base dashboard “mature enough to
ship” so implementation can converge on one stopping condition.

This doc is intentionally stricter than a generic roadmap. It is a release gate,
not a wish list.

## Release Principle

Do not ship on vibes.

The base dashboard is only ready when the product stance, contract truth, and
operator workflows line up well enough that a serious user can rely on it
without dropping to files or CLI for core behavior.

## Must-Pass Gates

All of these are ship blockers.

### 1. Core control-plane truth

Must be true:

- every base-dashboard control maps to a real core contract
- no base-dashboard control is knowingly fake
- no core capability still requires CLI or direct file editing for normal use
- capability-disabled surfaces render honestly instead of looking empty

Blocking failures:

- any `501`/placeholder path exposed in the base UI
- any silent fallback that pretends success

### 2. Config trust

Must be true:

- core config sections round-trip without silent loss
- structured and raw editing stay semantically aligned
- validation errors come from canonical backend rules
- context/doc editing and config editing feel like one product

Blocking failures:

- known lossy sections remain in the base dashboard
- structured editor meaning differs from raw editor meaning

### 3. Lock and override truth

Must be true:

- lockable surfaces exist
- locks are persistent
- default override policy is real
- blocked mutations are explicit and audited
- operators can see lock state in the UI

Blocking failures:

- lock behavior is only cosmetic
- runtime ignores locks
- the UI implies locks that are not enforced

### 4. Action-status truth

Must be true:

- accepted/background actions return trackable action status
- risky actions no longer masquerade as immediate success
- terminal failures remain visible after reload

Blocking failures:

- `202` without durable tracking
- async work hidden behind `200`
- action failure visible only in transient toasts

### 5. Shell coherence

Must be true:

- the dashboard has one intentional operator-home model
- navigation is coherent and complete for core
- multi-business switching is clear
- no stale competing shell patterns remain active

Blocking failures:

- users can reach obviously dormant or contradictory shell patterns
- operators cannot tell what business they are acting on

### 6. Onboarding and operator flow

Must be true:

- create business/domain works from the dashboard
- a user can reach config immediately after creation
- switching businesses and operating from the shell works
- critical intervention paths are reachable

Blocking failures:

- first-run requires assistant/CLI/file fallback
- users get stranded in empty or dead-end states

### 7. Runtime and auth boundary

Must be true:

- embedded vs standalone runtime behavior is explicit
- embedded auth remains OpenClaw-owned
- standalone auth is documented and tested
- runtime metadata is truthful

Blocking failures:

- duplicated embedded auth
- ambiguous auth/runtime mode in the UI
- standalone mode behaving as if it were a half-supported afterthought

### 8. Extension proof

Must be true:

- at least one real non-core extension proves the architecture
- OpenClaw remains plugin loader/lifecycle owner
- ClawForce extension semantics are reusable and not bespoke to one plugin

Blocking failures:

- no proving extension
- proving extension only works through one-off hacks

### 9. Verification bar

Must be true:

- focused framework dashboard tests are green
- dashboard SPA tests are green
- critical operator flows are automatically covered
- release smoke checklist exists

Blocking failures:

- no automated coverage for route-to-route operator flows
- known failing tests in the maturity-critical areas

### 10. Docs match product reality

Must be true:

- operator docs match the actual dashboard
- deployment/runtime docs match actual behavior
- extension docs match actual platform boundaries
- release checklist is explicit

Blocking failures:

- docs describe behaviors the product does not have
- runtime/auth boundaries are still only tribal knowledge

## Critical Operator Flows That Must Be Covered

These are the minimum flows the release should prove automatically or through a
documented smoke pass:

1. create business -> land in config
2. switch business -> operate from shell
3. config edit -> validate -> save
4. budget edit/allocation
5. approval resolve
6. task intervention
7. direct comms path
8. emergency control path
9. context/doc edit path
10. extension page/panel/action/config path

## Known Non-Blockers For This Release

These may still be incomplete without blocking the maturity release:

- deeper assistant/operator-console phase 2
- research/eval system
- org templates as a separate product track
- marketplace UX
- full public API/SDK rollout

These are important, but they are not part of the base dashboard maturity gate.

## Recommended Release Evidence Pack

Before calling the dashboard mature, there should be a short evidence pack with:

- links to passing framework dashboard tests
- links to passing dashboard SPA tests
- note on proving extension status
- note on embedded vs standalone runtime verification
- note on remaining known non-blockers

The point is to make the release claim easy to defend later.

## Final Ship Question

Ask this directly:

Can a serious operator running multiple businesses create, configure, run, and
intervene in ClawForce core entirely from the dashboard, with honest feedback,
without needing CLI or file fallbacks for normal operation?

If the answer is not clearly yes, the dashboard has not met the maturity bar.

