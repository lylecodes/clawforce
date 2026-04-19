---
name: rentright-integrity-remediation
description: Use when RentRight has blocked or flagged data integrity verdicts. Diagnoses the failed checks, identifies the real cause, remediates data or sources, and drives the verdict back to trusted. Triggers on "integrity block", "fix integrity verdict", "remediate blocked field", "resolve data integrity".
---

# RentRight Integrity Remediation

Use this skill when a jurisdiction or field is blocked or flagged by the integrity gate.

Read these first:
- `../../rentright/docs/architecture/DATA_INTEGRITY_GATE.md`
- `../../rentright/docs/architecture/DATA_VALIDATION_FLOW.md`

## Goal

Move a field or jurisdiction from:
- `blocked` -> `trusted`
- `flagged` -> `trusted`

## Process

1. Identify the failed checks.
   Record:
   - check IDs
   - field importance
   - jurisdiction
   - current verdict

2. Classify the root cause.
   Determine whether the failure is caused by:
   - bad source
   - stale source quote
   - wrong normalization
   - wrong temporal dates
   - contradictory field pair
   - cross-jurisdiction outlier
   - false peer assumption

3. Inspect the evidence chain.
   Review:
   - source URL
   - source quote
   - extracted value
   - current generated artifact
   - related fields

4. Remediate at the right layer.
   Fix the source or extracted value, not the generated YAML.

5. Re-run validation.
   Confirm:
   - integrity verdict clears
   - no new contradictions appear
   - any affected bundle still passes

6. Update the jurisdiction dossier.
   Add:
   - failure mode
   - remediation notes
   - any durable “watch this” guidance

## Output

Produce:
- failed checks summary
- root cause
- remediation action taken
- post-fix verdict
- any remaining risk

## Rules

- `rate_determining` and `applicability_determining` issues are urgent.
- Never “resolve” by hand-waving the peer check away without evidence.
- If the integrity rule itself appears wrong, document that separately; do not silently bypass it.
