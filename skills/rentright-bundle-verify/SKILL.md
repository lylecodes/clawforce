---
name: rentright-bundle-verify
description: Use when verifying RentRight calculation bundles before promotion or after parent/jurisdiction changes. Runs scenario packs, validates generated data, and issues a release verdict. Triggers on "verify bundle", "check jurisdiction bundle", "pre-release verify", "validate calculator outputs".
---

# RentRight Bundle Verify

Use this skill to verify that RentRight's generated jurisdiction data still produces correct calculation behavior.

Read these first:
- `../../rentright/docs/architecture/DATA_VALIDATION_FLOW.md`
- `../../rentright/docs/COMPLIANCE_METHODOLOGY.md`
- `../../rentright/README.md`

Then read the jurisdiction dossier:
- `../../rentright/docs/jurisdictions/<slug>/scenario-pack.md`
- `../../rentright/docs/jurisdictions/<slug>/known-quirks.md`

## Goal

Issue a release verdict for a jurisdiction or parent-regime change:
- `pass`
- `pass_with_followups`
- `fail`

## Process

1. Identify change surface.
   Determine whether the change affects:
   - local only
   - parent/child inheritance
   - temporal rate logic
   - exemptions
   - notice/procedural outputs

2. Rebuild data artifacts.
   Run:
   - `npm run data:generate`
   - `npm run data:validate`

3. Run scenario pack.
   Cover at least:
   - standard covered unit
   - standard exempt unit
   - edge-case unit
   - temporal/effective-date case
   - inherited-field case where applicable

4. Compare expected vs actual behavior.
   Focus on:
   - coverage determination
   - rate computation
   - exemption handling
   - warnings and procedural requirements

5. Check downstream impact.
   If a parent regime changed, verify impacted child jurisdictions too.

6. Produce verdict.
   Fail if:
   - calculation outputs differ materially from expected behavior
   - a downstream child was not re-verified
   - validation passed but scenario pack regressed

## Output

Produce:
- affected jurisdictions
- scenarios run
- expected vs actual summary
- release verdict
- follow-up tasks if needed

## Rules

- Do not stop at `data:validate`.
- Bundle verification is product verification, not schema verification.
- Parent changes are incomplete until child verification is done.
