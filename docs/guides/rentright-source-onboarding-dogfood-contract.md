# RentRight Source Onboarding Dogfood Contract

Use this as the canonical setup-surface dogfood lane for ClawForce.

## App

- Name: RentRight source onboarding
- Repo / location: RentRight workspace governed through the `rentright-data` domain
- Owner: RentRight data operations
- Rollout lead: `rentright-data-data-director`
- Start state: `dry_run`
- Review cadence: weekly during rollout

## Why This App

- It has real recurring work, real correctness risk, and clear operator expectations.
- The blast radius is acceptable because `dry_run` keeps routing and governance real while side effects stay simulated or blocked.
- It exercises the exact ClawForce category we need to prove: setup clarity, workflow completeness, approvals, and runtime honesty.

## In Scope

- Workflow: `data-source-onboarding`
- Roles:
  - `rentright-data-data-director`
  - `rentright-data-source-onboarding-steward`
  - `rentright-data-integrity-gatekeeper`
  - `rentright-data-production-sentinel`
  - `workflow-steward`
- Primary governed object: `jurisdiction`
- Operator surfaces:
  - Setup control plane
  - Feed
  - Decision inbox
  - Config editor
  - Entity snapshots / checks

## Authoritative Control Path

The rollout only counts if these go through ClawForce:

- Task creation and transition
- Dispatch and recurring job routing
- Budget and policy enforcement
- Approval routing for risky transitions
- Feed / decision surfacing
- Audit and runtime receipts

## Setup Verification

- Dry-run available: yes
- Dry-run stance:
  - tasks, issues, proposals, entities, feed items, and audit remain real
  - external mutations remain simulated or blocked
- Proof that setup is wired correctly:
  - proposed jurisdictions create or refresh governed onboarding work
  - blocked integrity verdicts surface clearly
  - simulated actions appear in setup/feed with the right owning agent
  - operator can explain the state from ClawForce surfaces without checking internals
- Normal operator path:
  - `cf setup status --domain=rentright-data`
  - `cf feed --domain=rentright-data --json`
  - `cf decisions --domain=rentright-data --json`
  - `cf entities snapshot --domain=rentright-data --entity-id=<id> --json`
  - `cf entities check-runs --domain=rentright-data --entity-id=<id> --limit=<n> --json`

## Success Metrics

- Operational:
  - onboarding requests route within one recurring cycle
  - blocked integrity work stays visible until resolved
- Governance:
  - risky transitions show up in the decision inbox before live execution
  - no budget or approval bypasses are needed
- Reliability:
  - config edits show a clear runtime apply result
  - operators can tell whether the runtime is current or stale
- Operator experience:
  - setup explains why a workflow is blocked
  - dry-run intended mutations are legible without reading logs

## Failure Signals

- Operators bypass ClawForce and patch the app directly
- Config changes require folklore or repeated poking to understand whether they applied
- The same unsupported manual recovery happens more than once
- Feed / decisions do not explain why work is blocked or who owns it

## Rollout Plan

1. Create or scaffold the domain in `dry_run`.
2. Verify setup and recurring jobs from the setup control plane.
3. Run explicit onboarding experiments and record discrepancies.
4. Only switch to `live` after the dry-run path is boring and explainable.

## Exit Criteria

- Keep the rollout going if ClawForce remains the operator control path.
- Pause and reassess if runtime honesty, approvals, or workflow explanation are still not trustworthy enough for daily use.
