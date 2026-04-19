---
name: rentright-jurisdiction-onboarding
description: Use when onboarding a new RentRight jurisdiction or bringing an inactive jurisdiction to shadow/active state. Covers source discovery, extraction, validation, bundle verification, and dossier setup. Triggers on "onboard jurisdiction", "set up jurisdiction owner", "add rentright jurisdiction", "bootstrap jurisdiction".
---

# RentRight Jurisdiction Onboarding

Use this skill for end-to-end onboarding of a jurisdiction into RentRight's governed data pipeline.

Read these first:
- `../../rentright/docs/architecture/DATA_SOURCE_ONBOARDING.md`
- `../../rentright/docs/architecture/DATA_VALIDATION_FLOW.md`
- `../../rentright/docs/architecture/DATA_INTEGRITY_GATE.md`
- `../../rentright/docs/architecture/DATA_SOURCES.md`
- `../../rentright/docs/architecture/JURISDICTION_COMPLETENESS.md`

## Goal

Move a jurisdiction through:
- `proposed`
- `bootstrapping`
- `shadow`
- `active`

## Process

1. Identify owner and parent regime.
   Determine:
   - jurisdiction owner
   - parent jurisdictions
   - whether shared parent verification will be required

2. Create the dossier.
   Scaffold:
   - `docs/jurisdictions/<slug>/sources.md`
   - `docs/jurisdictions/<slug>/known-quirks.md`
   - `docs/jurisdictions/<slug>/scenario-pack.md`
   - `docs/jurisdictions/<slug>/release-log.md`

3. Build the source map.
   Prefer official `.gov` or government-hosted sources only.
   Separate:
   - authoritative sources
   - fallback/reference sources
   - rejected sources

4. Onboard sources through the DB-first pipeline.
   Never edit YAML directly.
   Flow:
   - create data source
   - run extraction
   - persist to `extracted_values`
   - run `data:generate`
   - run `data:validate`

5. Check integrity.
   Ensure no blocking verdicts remain for activation.

6. Build the scenario pack.
   At minimum include:
   - covered property
   - exempt property
   - edge case
   - rate-period case
   - parent/child inheritance case if applicable

7. Verify bundles.
   Run the jurisdiction through bundle and calculation verification before promotion.

8. Promote status.
   - `bootstrapping -> shadow` when pipeline runs cleanly
   - `shadow -> active` only after validation and bundle verification pass

## Output

Produce:
- owner assignment
- source inventory
- dossier files
- activation recommendation
- unresolved ambiguities list

## Rules

- DB is source of truth.
- YAML is generated artifact only.
- Official source beats agent memory.
- Parent-jurisdiction dependencies must be documented before activation.
